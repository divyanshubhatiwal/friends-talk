// Wavelength — anonymous voice-first random chat.
//
// The server does three things: it matches two strangers, it relays the WebRTC
// handshake between them, and it screens anything textual or visual that passes
// through. Audio itself is peer-to-peer and never reaches this process.

import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';

import { Matchmaker } from './src/matchmaker.js';
import { RoomRegistry, newGame, applyMove } from './src/rooms.js';
import { screenText, screenImage, VERDICT } from './src/moderation.js';
import { randomName } from './src/names.js';
import * as store from './src/storage/repository.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 4e6, // room for a screened image
  cors: { origin: false }
});

const matchmaker = new Matchmaker();
const rooms = new RoomRegistry();

/** @type {Map<string, object>} socketId -> peer */
const peers = new Map();
/** @type {Map<string, string>} clientId -> socketId, for friend calls */
const online = new Map();

// A client reported this many times in 24 hours is suspended automatically.
const REPORT_BAN_THRESHOLD = 5;
const REPORT_BAN_SECONDS = 24 * 60 * 60;

const ICE_SERVERS = buildIceServers();

function buildIceServers() {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  return servers;
}

// ---------------------------------------------------------------- HTTP layer

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/stats', (_req, res) => {
  res.json(stats());
});

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

function stats() {
  return {
    online: peers.size,
    waiting: matchmaker.size(),
    inCall: rooms.size() * 2,
    rooms: rooms.size(),
    persistent: store.isPersistent()
  };
}

// Operator view of the moderation queue. Put real authentication in front of
// this before exposing it anywhere public.
app.get('/api/moderation/reports', async (req, res) => {
  if (!process.env.MODERATION_TOKEN ||
      req.get('authorization') !== `Bearer ${process.env.MODERATION_TOKEN}`) {
    return res.status(404).end();
  }
  res.json(await store.recentReports(100));
});

// ------------------------------------------------------------ Socket signals

io.on('connection', (socket) => {
  const peer = {
    id: socket.id,
    clientId: null,
    name: randomName(),
    country: 'XX',
    mode: null,
    countries: [],
    interests: [],
    premium: false,
    genderPreference: 'any',
    gender: 'unknown',
    blocked: new Set(),
    joinedAt: Date.now(),
    ageConfirmed: false
  };
  peers.set(socket.id, peer);

  socket.emit('ready', {
    selfId: socket.id,
    name: peer.name,
    iceServers: ICE_SERVERS,
    stats: stats()
  });

  socket.on('hello', async (payload = {}) => {
    peer.clientId = sanitizeId(payload.clientId) || socket.id;
    peer.country = sanitizeCountry(payload.country);
    peer.ageConfirmed = payload.ageConfirmed === true;
    online.set(peer.clientId, socket.id);

    // The device's own list is a hint; the stored list is authoritative, so a
    // block survives clearing local storage or moving to another browser.
    const stored = await store.listBlocks(peer.clientId);
    peer.blocked = new Set([
      ...toArray(payload.blocked).map(sanitizeId).filter(Boolean),
      ...stored
    ]);

    if (await store.isBanned(peer.clientId)) {
      socket.emit('error:blocked', { reason: 'suspended' });
      peer.ageConfirmed = false;
      return;
    }

    socket.emit('hello:ok', {
      name: peer.name,
      friends: await store.listFriends(peer.clientId),
      inbox: await store.inboxFor(peer.clientId),
      persistent: store.isPersistent()
    });
  });

  socket.on('find', async (payload = {}) => {
    if (!peer.ageConfirmed) {
      socket.emit('error:blocked', { reason: 'age_not_confirmed' });
      return;
    }
    if (await store.isBanned(peer.clientId)) {
      socket.emit('error:blocked', { reason: 'suspended' });
      return;
    }
    leaveRoom(socket, 'searching');
    matchmaker.dequeue(socket.id);

    peer.mode = payload.mode === 'text' ? 'text' : 'voice';
    peer.countries = toArray(payload.countries).map(sanitizeCountry).slice(0, 8);
    peer.interests = toArray(payload.interests)
      .map((tag) => String(tag).toLowerCase().replace(/[^a-z0-9 -]/g, '').trim())
      .filter(Boolean)
      .slice(0, 6);
    peer.premium = payload.premium === true;
    peer.genderPreference = ['male', 'female', 'any'].includes(payload.genderPreference)
      ? payload.genderPreference
      : 'any';
    peer.gender = ['male', 'female', 'unknown'].includes(payload.gender)
      ? payload.gender
      : 'unknown';
    peer.joinedAt = Date.now();

    const partner = matchmaker.enqueue(peer);
    if (!partner) {
      socket.emit('waiting', { mode: peer.mode });
      broadcastStats();
      return;
    }
    pair(peer, partner);
  });

  socket.on('cancel', () => {
    matchmaker.dequeue(socket.id);
    socket.emit('idle');
    broadcastStats();
  });

  // WebRTC offer / answer / ICE candidates, relayed verbatim.
  socket.on('signal', (payload = {}) => {
    const partnerId = rooms.partnerOf(socket.id);
    if (!partnerId) return;
    io.to(partnerId).emit('signal', { data: payload.data });
  });

  socket.on('chat', async (payload = {}) => {
    const room = rooms.forSocket(socket.id);
    if (!room) return;
    const partnerId = rooms.partnerOf(socket.id);
    const text = String(payload.text || '').slice(0, 2000).trim();
    if (!text) return;

    const check = screenText(text);
    if (check.verdict === VERDICT.BLOCK) {
      socket.emit('chat:blocked', { reason: check.reason });
      recordReport({ kind: 'auto', reason: check.reason, roomId: room.id, clientId: peer.clientId });
      return;
    }
    if (check.verdict === VERDICT.FLAG) {
      recordReport({ kind: 'auto', reason: check.reason, roomId: room.id, clientId: peer.clientId });
      if (check.warn) socket.emit('chat:warning', { reason: check.reason });
    }

    const message = { from: 'them', text, at: Date.now() };
    io.to(partnerId).emit('chat', message);
    socket.emit('chat', { ...message, from: 'me' });
  });

  socket.on('image', async (payload = {}) => {
    const room = rooms.forSocket(socket.id);
    if (!room) return;
    const partnerId = rooms.partnerOf(socket.id);

    socket.emit('image:pending');
    const check = await screenImage(payload.dataUrl);
    if (check.verdict !== VERDICT.ALLOW) {
      socket.emit('image:blocked', { reason: check.reason });
      recordReport({ kind: 'auto', reason: `image:${check.reason}`, roomId: room.id, clientId: peer.clientId });
      return;
    }
    io.to(partnerId).emit('image', { from: 'them', dataUrl: payload.dataUrl, at: Date.now() });
    socket.emit('image', { from: 'me', dataUrl: payload.dataUrl, at: Date.now() });
  });

  socket.on('typing', (payload = {}) => {
    const partnerId = rooms.partnerOf(socket.id);
    if (partnerId) io.to(partnerId).emit('typing', { on: payload.on === true });
  });

  // A text room asking to become a voice call. Both sides must agree.
  socket.on('escalate', () => {
    const partnerId = rooms.partnerOf(socket.id);
    if (partnerId) io.to(partnerId).emit('escalate:request');
  });

  socket.on('escalate:accept', () => {
    const room = rooms.forSocket(socket.id);
    const partnerId = rooms.partnerOf(socket.id);
    if (!room || !partnerId) return;
    room.mode = 'voice';
    // The accepting side answers, so the other side creates the offer.
    io.to(partnerId).emit('escalate:accepted', { initiator: true });
    socket.emit('escalate:accepted', { initiator: false });
  });

  socket.on('game:start', () => {
    const room = rooms.forSocket(socket.id);
    const partnerId = rooms.partnerOf(socket.id);
    if (!room || !partnerId) return;
    room.game = newGame(socket.id, partnerId);
    emitGame(room);
  });

  socket.on('game:move', (payload = {}) => {
    const room = rooms.forSocket(socket.id);
    if (!room?.game) return;
    const result = applyMove(room.game, socket.id, Number(payload.cell));
    if (!result.ok) return;
    emitGame(room);
  });

  socket.on('friend:request', () => {
    const room = rooms.forSocket(socket.id);
    const partnerId = rooms.partnerOf(socket.id);
    if (!room || !partnerId) return;
    io.to(partnerId).emit('friend:request', { name: peer.name });
  });

  socket.on('friend:accept', async () => {
    const partnerId = rooms.partnerOf(socket.id);
    const partner = peers.get(partnerId);
    if (!partner || !peer.clientId || !partner.clientId) return;

    await store.addFriend(peer.clientId, partner.clientId, partner.name);
    await store.addFriend(partner.clientId, peer.clientId, peer.name);

    socket.emit('friend:added', { name: partner.name, clientId: partner.clientId });
    io.to(partnerId).emit('friend:added', { name: peer.name, clientId: peer.clientId });
  });

  socket.on('block', async () => {
    const partnerId = rooms.partnerOf(socket.id);
    const partner = peers.get(partnerId);
    if (partner?.clientId) {
      peer.blocked.add(partner.clientId);
      await store.addBlock(peer.clientId, partner.clientId);
    }
    socket.emit('blocked:ok', { clientId: partner?.clientId || null });
    leaveRoom(socket, 'blocked');
  });

  socket.on('report', async (payload = {}) => {
    const room = rooms.forSocket(socket.id);
    const partner = peers.get(rooms.partnerOf(socket.id));
    const reported = partner?.clientId || null;

    await recordReport({
      kind: 'user',
      reason: String(payload.reason || 'unspecified').slice(0, 200),
      roomId: room?.id || null,
      clientId: reported,
      reportedBy: peer.clientId
    });
    socket.emit('report:ok');

    // Enough independent reports in a day and the account is suspended without
    // waiting for a human. The ban carries its own expiry.
    if (reported && await store.reportCountFor(reported) >= REPORT_BAN_THRESHOLD) {
      await store.banClient(reported, { reason: 'report_threshold', seconds: REPORT_BAN_SECONDS });
      const reportedSocket = online.get(reported);
      if (reportedSocket) io.to(reportedSocket).emit('error:blocked', { reason: 'suspended' });
    }
  });

  socket.on('next', () => {
    leaveRoom(socket, 'skipped');
    socket.emit('idle');
  });

  socket.on('leave', () => {
    matchmaker.dequeue(socket.id);
    leaveRoom(socket, 'left');
    socket.emit('idle');
  });

  socket.on('disconnect', () => {
    matchmaker.dequeue(socket.id);
    leaveRoom(socket, 'disconnected');
    if (peer.clientId && online.get(peer.clientId) === socket.id) {
      online.delete(peer.clientId);
    }
    peers.delete(socket.id);
    broadcastStats();
  });
});

// ------------------------------------------------------------------- Helpers

function pair(a, b) {
  const room = rooms.create(a, b, a.mode);
  const shared = a.interests.filter((tag) => b.interests.includes(tag));

  // Exactly one side must create the WebRTC offer, or both will collide.
  io.to(a.id).emit('matched', {
    roomId: room.id,
    mode: room.mode,
    initiator: true,
    partner: { name: b.name, country: b.country },
    sharedInterests: shared
  });
  io.to(b.id).emit('matched', {
    roomId: room.id,
    mode: room.mode,
    initiator: false,
    partner: { name: a.name, country: a.country },
    sharedInterests: shared
  });
  broadcastStats();
}

function leaveRoom(socket, reason) {
  const room = rooms.forSocket(socket.id);
  if (!room) return;
  const partnerId = rooms.partnerOf(socket.id);

  // Metadata only: who was connected and for how long. Never any content.
  const members = room.members.map((id) => peers.get(id)).filter(Boolean);
  store.recordCall({
    roomId: room.id,
    mode: room.mode,
    participants: members.map((m) => m.clientId),
    countries: members.map((m) => m.country),
    startedAt: room.startedAt,
    duration: Date.now() - room.startedAt
  }).catch((error) => console.warn('Storage: failed to record call —', error.message));

  rooms.destroy(room.id);
  if (partnerId) {
    io.to(partnerId).emit('partner:left', { reason, duration: Date.now() - room.startedAt });
  }
  socket.emit('room:closed', { reason, duration: Date.now() - room.startedAt });
  broadcastStats();
}

function emitGame(room) {
  for (const memberId of room.members) {
    io.to(memberId).emit('game:state', {
      board: room.game.board,
      yourMark: room.game.marks[memberId],
      yourTurn: room.game.turn === memberId,
      winner: room.game.winner,
      finished: room.game.finished
    });
  }
}

async function recordReport(entry) {
  try {
    await store.saveReport(entry);
  } catch (error) {
    console.warn('Storage: failed to save report —', error.message);
  }
}

let statsTimer = null;
function broadcastStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    io.emit('stats', stats());
  }, 400);
}

setInterval(() => io.emit('stats', stats()), 10000).unref();

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeId(value) {
  const str = String(value || '').trim();
  return /^[\w-]{6,64}$/.test(str) ? str : null;
}

function sanitizeCountry(value) {
  const str = String(value || '').toUpperCase();
  return /^[A-Z]{2}$/.test(str) ? str : 'XX';
}

await store.init();

httpServer.listen(PORT, () => {
  console.log(`Wavelength listening on http://localhost:${PORT}`);
});
