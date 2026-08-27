// Friends Talk — anonymous voice-first random chat.
//
// The server does three things: it matches two strangers, it relays the WebRTC
// handshake between them, and it screens anything textual or visual that passes
// through. Audio itself is peer-to-peer and never reaches this process.

import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Server } from 'socket.io';

import { Matchmaker, relaxationFor } from './src/matchmaker.js';
import {
  transcribe, translate, LANGUAGES,
  isAvailable as voiceAvailable,
  provider as voiceProvider,
  verify as voiceVerify,
  healthReason as voiceReason,
  generateIcebreaker
} from './src/voice.js';
import {
  RoomRegistry,
  newGame,
  applyMove,
  newPitchMatchGame,
  submitPitchScore,
  newTriviaGame,
  submitTriviaAnswer,
  newDrawingGame
} from './src/rooms.js';
import { GroupRegistry, MAX_MEMBERS } from './src/groups.js';
import { screenText, screenImage, VERDICT } from './src/moderation.js';
import { randomName } from './src/names.js';
import * as store from './src/storage/repository.js';
import * as push from './src/push.js';

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
const groups = new GroupRegistry();

/** @type {Map<string, object>} socketId -> peer */
const peers = new Map();
/** @type {Map<string, string>} clientId -> socketId, for friend calls */
const online = new Map();

/** In-flight rings, from the moment someone calls until answer or timeout. */
const pendingRings = new Map();

/**
 * Call-back tokens.
 *
 * Ringing someone you spoke to earlier needs a way to name them. Handing each
 * stranger the other's persistent client id would do it, and would also quietly
 * destroy the anonymity the product is built on: anyone could then recognise a
 * returning partner across sessions.
 *
 * So the server issues an opaque token per pairing instead. The client keeps
 * the token, the server alone can resolve it back to a client id, and it
 * expires. Friends are different — they exchanged ids by mutual consent — so
 * they are callable directly.
 *
 * @type {Map<string, {clientId: string, name: string, expires: number}>}
 */
const callbackTokens = new Map();
const CALLBACK_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function issueCallbackToken(forClientId, name) {
  const token = randomUUID();
  callbackTokens.set(token, {
    clientId: forClientId,
    name,
    expires: Date.now() + CALLBACK_TOKEN_TTL_MS
  });
  return token;
}

function resolveCallbackToken(token) {
  const entry = callbackTokens.get(String(token || ''));
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    callbackTokens.delete(token);
    return null;
  }
  return entry;
}

// Expired tokens would otherwise accumulate for the life of the process.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of callbackTokens) {
    if (entry.expires < now) callbackTokens.delete(token);
  }
}, 30 * 60 * 1000).unref();

// A client reported this many times in 24 hours is suspended automatically.
const REPORT_BAN_THRESHOLD = 5;
const REPORT_BAN_SECONDS = 24 * 60 * 60;

// How often the queue retries pairing everyone already waiting.
const SWEEP_INTERVAL_MS = 3000;

// Spoken violations escalate faster than typed ones: saying it out loud to
// someone is the thing this product exists to prevent.
const VOICE_STRIKE_LIMIT = 3;
const VOICE_BAN_SECONDS = 60 * 60;

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

app.get('/api/icebreaker', async (req, res) => {
  const interests = String(req.query.interests || '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const text = await generateIcebreaker(interests);
    res.json({ ok: !!text, icebreakers: text });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

function stats() {
  const group = groups.stats();
  return {
    online: peers.size,
    waiting: matchmaker.size(),
    inCall: rooms.size() * 2 + group.people,
    rooms: rooms.size(),
    groupRooms: group.rooms,
    groupPeople: group.people,
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
    ageConfirmed: false,
    captions: false,
    language: 'en',
    translateTo: null,
    voiceStrikes: 0,
    notifyWhenOnline: false
  };
  peers.set(socket.id, peer);

  socket.emit('ready', {
    selfId: socket.id,
    name: peer.name,
    iceServers: ICE_SERVERS,
    stats: stats(),
    // The client hides the caption controls entirely when the server has no
    // speech provider configured, rather than offering a toggle that does
    // nothing when switched on.
    voiceFeatures: voiceAvailable(),
    languages: LANGUAGES,
    // Not a secret: the browser needs this to create a push subscription.
    pushKey: push.publicKey()
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
    peer.captions = payload.captions === true;
    peer.language = LANGUAGES[payload.language] ? payload.language : 'en';
    peer.translateTo = LANGUAGES[payload.translateTo] ? payload.translateTo : null;

    const partner = matchmaker.enqueue(peer);
    if (!partner) {
      emitWaiting(socket, peer);
      pingWatchers(socket.id);
      broadcastStats();
      return;
    }
    pair(peer, partner);
  });

  // Opt-in ping when the queue is no longer empty, so nobody has to sit and
  // watch a spinner on a quiet server.
  socket.on('notify', (payload = {}) => {
    peer.notifyWhenOnline = payload.on === true;
    // Remembered by client id as well, so the interest survives the socket and
    // a push can still reach them once they close the tab.
    if (peer.clientId) {
      if (peer.notifyWhenOnline) watchers.set(peer.clientId, true);
      else watchers.delete(peer.clientId);
    }
    socket.emit('notify:ok', { on: peer.notifyWhenOnline });
  });

  /**
   * Stores a browser push subscription against this client.
   *
   * Tied to the client id rather than the socket, because the entire point is
   * to reach someone whose socket is gone.
   */
  socket.on('push:subscribe', async (payload = {}) => {
    if (!peer.clientId || !payload.subscription?.endpoint) return;
    try {
      await store.savePushSubscription(peer.clientId, payload.subscription);
      socket.emit('push:ok', { subscribed: true });
    } catch (error) {
      console.warn('Push: could not store subscription —', error.message);
      socket.emit('push:ok', { subscribed: false });
    }
  });

  socket.on('push:unsubscribe', async (payload = {}) => {
    if (!payload.endpoint) return;
    await store.deletePushSubscription(payload.endpoint).catch(() => {});
    socket.emit('push:ok', { subscribed: false });
  });

  /**
   * A few seconds of the speaker's own microphone, for captioning.
   *
   * The clip is transcribed, screened, relayed to the partner as a caption,
   * and discarded. It is never written to disk. This only runs when the
   * speaker has switched captions on.
   */
  socket.on('voice:clip', async (payload = {}) => {
    if (!peer.captions || !voiceAvailable()) return;
    const room = rooms.forSocket(socket.id);
    if (!room) return;

    const chunk = payload.chunk;
    if (!chunk || typeof chunk.byteLength !== 'number') return;

    const text = await transcribe(Buffer.from(chunk), {
      mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : 'audio/webm',
      language: peer.language
    });
    if (!text) return;

    // The room can end while transcription is in flight.
    const partnerId = rooms.partnerOf(socket.id);
    if (!partnerId) return;
    const partner = peers.get(partnerId);

    // Moderate what was actually said, using the same rules as typed messages.
    const check = screenText(text);
    if (check.verdict !== VERDICT.ALLOW) {
      await recordReport({
        kind: 'auto-voice',
        reason: `spoken:${check.reason}`,
        roomId: room.id,
        clientId: peer.clientId
      });
    }
    if (check.verdict === VERDICT.BLOCK) {
      peer.voiceStrikes += 1;
      socket.emit('voice:warning', {
        reason: check.reason,
        strikes: peer.voiceStrikes,
        limit: VOICE_STRIKE_LIMIT
      });
      if (peer.voiceStrikes >= VOICE_STRIKE_LIMIT) {
        await store.banClient(peer.clientId, {
          reason: 'spoken_violations',
          seconds: VOICE_BAN_SECONDS
        });
        socket.emit('error:blocked', { reason: 'suspended' });
        leaveRoom(socket, 'suspended');
      }
      // The offending line is never forwarded as a caption.
      return;
    }

    socket.emit('caption', { from: 'me', text, at: Date.now() });

    if (partner?.captions) {
      const translated = partner.translateTo && partner.translateTo !== peer.language
        ? await translate(text, partner.translateTo)
        : null;
      io.to(partnerId).emit('caption', {
        from: 'them',
        text: translated || text,
        original: translated ? text : null,
        at: Date.now()
      });
    }
  });

  socket.on('cancel', () => {
    matchmaker.dequeue(socket.id);
    socket.emit('idle');
    broadcastStats();
  });

  // ------------------------------------------------------------ group rooms

  socket.on('group:join', async (payload = {}) => {
    if (!peer.ageConfirmed) {
      socket.emit('error:blocked', { reason: 'age_not_confirmed' });
      return;
    }
    if (await store.isBanned(peer.clientId)) {
      socket.emit('error:blocked', { reason: 'suspended' });
      return;
    }

    // Leave whatever they were in first, so nobody occupies two places.
    matchmaker.dequeue(socket.id);
    leaveRoom(socket, 'switched');
    leaveGroup(socket, 'switched');

    peer.interests = toArray(payload.interests)
      .map((tag) => String(tag).toLowerCase().replace(/[^a-z0-9 -]/g, '').trim())
      .filter(Boolean)
      .slice(0, 6);

    const room = groups.findOrCreate(peer);
    const roster = groups.roster(room);

    // The newcomer offers to everyone already present. Making the arrival the
    // sole initiator removes glare entirely — existing members only ever
    // answer, so two peers can never send each other an offer at once.
    socket.emit('group:joined', {
      roomId: room.id,
      you: peer.id,
      members: roster.filter((m) => m.id !== peer.id),
      capacity: MAX_MEMBERS
    });

    for (const member of room.members.keys()) {
      if (member === socket.id) continue;
      io.to(member).emit('group:peer-joined', {
        peer: { id: peer.id, name: peer.name, country: peer.country },
        size: room.members.size
      });
    }
    broadcastStats();
  });

  // Addressed signaling. One-to-one can assume "the other person"; a mesh
  // cannot, so every message names its recipient and is checked to be within
  // the sender's own room.
  socket.on('group:signal', (payload = {}) => {
    const room = groups.roomOf(socket.id);
    if (!room) return;
    const target = String(payload.to || '');
    if (!room.members.has(target)) return;
    io.to(target).emit('group:signal', { from: socket.id, data: payload.data });
  });

  socket.on('group:chat', async (payload = {}) => {
    const room = groups.roomOf(socket.id);
    if (!room) return;
    const text = String(payload.text || '').slice(0, 2000).trim();
    if (!text) return;

    const check = screenText(text);
    if (check.verdict === VERDICT.BLOCK) {
      socket.emit('chat:blocked', { reason: check.reason });
      recordReport({ kind: 'auto-group', reason: check.reason, roomId: room.id, clientId: peer.clientId });
      return;
    }
    if (check.verdict === VERDICT.FLAG) {
      recordReport({ kind: 'auto-group', reason: check.reason, roomId: room.id, clientId: peer.clientId });
      if (check.warn) socket.emit('chat:warning', { reason: check.reason });
    }

    for (const member of room.members.keys()) {
      io.to(member).emit('group:chat', {
        from: member === socket.id ? 'me' : 'them',
        author: peer.name,
        text,
        at: Date.now()
      });
    }
  });

  socket.on('group:leave', () => {
    leaveGroup(socket, 'left');
    socket.emit('idle');
  });

  // -------------------------------------------------- calling someone back

  /**
   * Rings a specific person: a friend by client id, or someone from the recent
   * list by the opaque token issued when they were matched.
   */
  socket.on('call:ring', async (payload = {}) => {
    if (!peer.ageConfirmed) return socket.emit('error:blocked', { reason: 'age_not_confirmed' });

    let targetClientId = null;
    let targetName = 'Someone';

    if (payload.token) {
      const entry = resolveCallbackToken(payload.token);
      if (!entry) return socket.emit('call:failed', { reason: 'expired' });
      targetClientId = entry.clientId;
      targetName = entry.name;
    } else if (payload.clientId) {
      // Only people who agreed to be friends may be rung by raw id.
      const friends = await store.listFriends(peer.clientId);
      const friend = friends.find((f) => f.clientId === payload.clientId);
      if (!friend) return socket.emit('call:failed', { reason: 'not_a_friend' });
      targetClientId = friend.clientId;
      targetName = friend.name;
    } else {
      return socket.emit('call:failed', { reason: 'no_target' });
    }

    if (peer.blocked.has(targetClientId)) return socket.emit('call:failed', { reason: 'blocked' });
    if (await store.isBanned(peer.clientId)) return socket.emit('error:blocked', { reason: 'suspended' });

    const targetSocketId = isReachable(targetClientId);
    if (!targetSocketId) return socket.emit('call:failed', { reason: 'unavailable', name: targetName });

    const target = peers.get(targetSocketId);
    if (target?.blocked.has(peer.clientId)) {
      // Indistinguishable from being offline on purpose — telling someone they
      // have been blocked invites them to work around it.
      return socket.emit('call:failed', { reason: 'unavailable', name: targetName });
    }

    const ringId = randomUUID();
    pendingRings.set(ringId, { fromSocket: socket.id, toSocket: targetSocketId, at: Date.now() });

    io.to(targetSocketId).emit('call:incoming', { ringId, name: peer.name, country: peer.country });
    socket.emit('call:ringing', { ringId, name: targetName });

    // Also push, in case their tab is buried or the phone is locked. This is
    // the case push exists for — a ring nobody sees is a ring that failed.
    push.sendTo(targetClientId, {
      title: 'Friends Talk',
      body: `${peer.name} is calling you`,
      tag: 'incoming-call',
      url: '/app'
    }).catch(() => { /* never let a push failure disturb the ring */ });

    // Nobody should hear a phone ring forever.
    setTimeout(() => {
      if (!pendingRings.has(ringId)) return;
      pendingRings.delete(ringId);
      io.to(socket.id).emit('call:failed', { reason: 'no_answer', name: targetName });
      io.to(targetSocketId).emit('call:cancelled', { ringId });
    }, 30000);
  });

  socket.on('call:accept', (payload = {}) => {
    const ring = pendingRings.get(String(payload.ringId || ''));
    if (!ring || ring.toSocket !== socket.id) return;
    pendingRings.delete(payload.ringId);

    const caller = peers.get(ring.fromSocket);
    if (!caller) return socket.emit('call:failed', { reason: 'unavailable' });

    // Both sides leave whatever they were doing, then pair as a normal call.
    matchmaker.dequeue(ring.fromSocket);
    matchmaker.dequeue(socket.id);
    caller.mode = 'voice';
    peer.mode = 'voice';
    pair(caller, peer);
  });

  socket.on('call:decline', (payload = {}) => {
    const ring = pendingRings.get(String(payload.ringId || ''));
    if (!ring || ring.toSocket !== socket.id) return;
    pendingRings.delete(payload.ringId);
    io.to(ring.fromSocket).emit('call:failed', { reason: 'declined' });
  });

  socket.on('call:cancel', (payload = {}) => {
    const ring = pendingRings.get(String(payload.ringId || ''));
    if (!ring || ring.fromSocket !== socket.id) return;
    pendingRings.delete(payload.ringId);
    io.to(ring.toSocket).emit('call:cancelled', { ringId: payload.ringId });
  });

  /** Blocks someone from a list rather than mid-call. */
  socket.on('block:client', async (payload = {}) => {
    let targetClientId = null;
    if (payload.token) {
      const entry = resolveCallbackToken(payload.token);
      if (entry) targetClientId = entry.clientId;
    } else if (payload.clientId) {
      targetClientId = sanitizeId(payload.clientId);
    }
    if (!targetClientId) return socket.emit('call:failed', { reason: 'expired' });

    peer.blocked.add(targetClientId);
    await store.addBlock(peer.clientId, targetClientId);
    await store.removeFriend(peer.clientId, targetClientId);
    socket.emit('blocked:ok', { clientId: targetClientId });
  });

  // --------------------------------------------------------- screen share

  /**
   * Screen sharing is consent-gated in both directions.
   *
   * Everywhere else in this app the visual channel is closed, which is the
   * whole reason it is safer than camera roulette. Opening it for a stranger
   * needs the receiver to actively agree first — a stream that simply appears
   * would hand any anonymous participant a projector.
   */
  socket.on('screen:request', () => {
    const partnerId = rooms.partnerOf(socket.id);
    if (!partnerId) return;
    io.to(partnerId).emit('screen:request', { name: peer.name });
  });

  socket.on('screen:accept', () => {
    const partnerId = rooms.partnerOf(socket.id);
    if (!partnerId) return;
    io.to(partnerId).emit('screen:accepted');
  });

  socket.on('screen:decline', () => {
    const partnerId = rooms.partnerOf(socket.id);
    if (!partnerId) return;
    io.to(partnerId).emit('screen:declined');
  });

  socket.on('screen:stopped', () => {
    const partnerId = rooms.partnerOf(socket.id);
    if (partnerId) io.to(partnerId).emit('screen:stopped');
  });

  /**
   * A report raised specifically about what is on screen.
   *
   * Recorded separately from ordinary reports because it is the one moderation
   * path with no automated screening behind it — nothing inspects a live video
   * stream — so a human signal is all there is.
   */
  socket.on('screen:report', async () => {
    const room = rooms.forSocket(socket.id);
    const partner = peers.get(rooms.partnerOf(socket.id));
    await recordReport({
      kind: 'screen',
      reason: 'screen_share_abuse',
      roomId: room?.id || null,
      clientId: partner?.clientId || null,
      reportedBy: peer.clientId
    });
    if (partner?.clientId) {
      await store.banClient(partner.clientId, { reason: 'screen_share_report', seconds: 60 * 60 });
      const partnerSocket = online.get(partner.clientId);
      if (partnerSocket) io.to(partnerSocket).emit('error:blocked', { reason: 'suspended' });
    }
    socket.emit('report:ok');
  });

  // ------------------------------------------------------- shared notepad

  /**
   * A scratch pad both sides can type in.
   *
   * Deliberately last-write-wins with a debounce on the client rather than a
   * conflict-free type. Two or three people jotting a word down do not generate
   * the concurrent edits that would justify the complexity, and a wrong merge
   * would be more confusing than a lost keystroke.
   *
   * The text is relayed, never stored, and dies with the room.
   */
  socket.on('pad:update', (payload = {}) => {
    const text = String(payload.text || '').slice(0, 20000);

    const check = screenText(text);
    if (check.verdict === VERDICT.BLOCK) {
      socket.emit('pad:blocked', { reason: check.reason });
      return;
    }

    const groupRoom = groups.roomOf(socket.id);
    if (groupRoom) {
      groupRoom.pad = text;
      for (const member of groupRoom.members.keys()) {
        if (member === socket.id) continue;
        io.to(member).emit('pad:sync', { text, by: peer.name });
      }
      return;
    }

    const room = rooms.forSocket(socket.id);
    const partnerId = rooms.partnerOf(socket.id);
    if (!room || !partnerId) return;
    room.pad = text;
    io.to(partnerId).emit('pad:sync', { text, by: peer.name });
  });

  // Someone opening the pad mid-conversation needs whatever is already there.
  socket.on('pad:request', () => {
    const groupRoom = groups.roomOf(socket.id);
    const room = groupRoom || rooms.forSocket(socket.id);
    if (room?.pad) socket.emit('pad:sync', { text: room.pad, by: null });
  });

  // ------------------------------------------------------ typed-to-spoken

  /**
   * Speaks a typed line into the conversation.
   *
   * This is what lets someone who cannot speak take part in a voice room: they
   * type, and every other participant's browser reads it aloud. The synthesis
   * happens on each listener's device, so it costs nothing and adds no delay
   * beyond the network hop.
   */
  socket.on('speak', async (payload = {}) => {
    const text = String(payload.text || '').slice(0, 500).trim();
    if (!text) return;

    const check = screenText(text);
    if (check.verdict === VERDICT.BLOCK) {
      socket.emit('chat:blocked', { reason: check.reason });
      return;
    }

    const groupRoom = groups.roomOf(socket.id);
    if (groupRoom) {
      for (const member of groupRoom.members.keys()) {
        if (member === socket.id) continue;
        io.to(member).emit('spoken', { text, author: peer.name, lang: peer.language });
      }
      socket.emit('group:chat', { from: 'me', author: peer.name, text, at: Date.now() });
      return;
    }

    const partnerId = rooms.partnerOf(socket.id);
    if (!partnerId) return;
    io.to(partnerId).emit('spoken', { text, author: peer.name, lang: peer.language });
    socket.emit('chat', { from: 'me', text, at: Date.now() });
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

  socket.on('soundboard:trigger', (payload = {}) => {
    const partnerId = rooms.partnerOf(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('soundboard:trigger', { name: payload.name });
    }
  });

  socket.on('game:start', (payload = {}) => {
    const room = rooms.forSocket(socket.id);
    const partnerId = rooms.partnerOf(socket.id);
    if (!room || !partnerId) return;

    if (payload.gameType === 'pitch-match') {
      room.game = newPitchMatchGame(socket.id, partnerId);
    } else if (payload.gameType === 'trivia') {
      room.game = newTriviaGame(socket.id, partnerId);
    } else if (payload.gameType === 'drawing') {
      room.game = newDrawingGame(socket.id, partnerId);
    } else {
      room.game = newGame(socket.id, partnerId);
      room.game.type = 'tic-tac-toe';
    }
    emitGame(room);
  });

  socket.on('game:move', (payload = {}) => {
    const room = rooms.forSocket(socket.id);
    if (!room?.game) return;

    let result;
    if (room.game.type === 'pitch-match') {
      result = submitPitchScore(room.game, socket.id, Number(payload.difference));
    } else if (room.game.type === 'trivia') {
      result = submitTriviaAnswer(room.game, socket.id, Number(payload.answerIndex));
    } else {
      result = applyMove(room.game, socket.id, Number(payload.cell));
    }

    if (!result || !result.ok) return;
    emitGame(room);
  });

  // Collaborative Drawing Board
  socket.on('draw:path', (payload = {}) => {
    const partnerId = rooms.partnerOf(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('draw:path', payload);
    }
  });

  socket.on('draw:clear', () => {
    const partnerId = rooms.partnerOf(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('draw:clear');
    }
  });

  // YouTube Watch Party Sync
  socket.on('watch:load', (payload = {}) => {
    const partnerId = rooms.partnerOf(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('watch:load', { videoId: payload.videoId, title: payload.title });
    }
  });

  socket.on('watch:state', (payload = {}) => {
    const partnerId = rooms.partnerOf(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('watch:state', { state: payload.state, time: payload.time });
    }
  });

  // Ambiance Soundscape Sync
  socket.on('soundscape:sync', (payload = {}) => {
    const partnerId = rooms.partnerOf(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('soundscape:sync', { sound: payload.sound, on: payload.on });
    }
  });

  // Themed Voice Lounges
  socket.on('lounges:list', () => {
    socket.emit('lounges:list', groups.getLoungeList());
  });

  socket.on('lounges:join', (payload = {}) => {
    if (!peer.ageConfirmed) {
      socket.emit('error:blocked', { reason: 'age_not_confirmed' });
      return;
    }
    matchmaker.dequeue(socket.id);
    leaveRoom(socket, 'switched');
    leaveGroup(socket, 'switched');

    const loungeId = String(payload.loungeId || '');
    const room = groups.joinLounge(loungeId, peer);
    if (!room) return;

    const roster = groups.roster(room);
    socket.emit('group:joined', {
      roomId: room.id,
      you: peer.id,
      title: room.title,
      isLounge: true,
      members: roster.filter((m) => m.id !== peer.id),
      capacity: 10
    });

    for (const member of room.members.keys()) {
      if (member === socket.id) continue;
      io.to(member).emit('group:peer-joined', {
        peer: { id: peer.id, name: peer.name, country: peer.country },
        size: room.members.size
      });
    }
    broadcastStats();
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
    leaveGroup(socket, 'disconnected');

    // Tear down any ring this socket was either end of, so the other side is
    // not left listening to a phone that will never be answered.
    for (const [ringId, ring] of pendingRings) {
      if (ring.fromSocket !== socket.id && ring.toSocket !== socket.id) continue;
      pendingRings.delete(ringId);
      const other = ring.fromSocket === socket.id ? ring.toSocket : ring.fromSocket;
      io.to(other).emit(ring.fromSocket === socket.id ? 'call:cancelled' : 'call:failed', {
        ringId,
        reason: 'unavailable'
      });
    }
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
    sharedInterests: shared,
    // Lets a either ring b again later without ever learning b's client id.
    callbackToken: issueCallbackToken(b.clientId, b.name)
  });
  io.to(b.id).emit('matched', {
    roomId: room.id,
    mode: room.mode,
    initiator: false,
    partner: { name: a.name, country: a.country },
    sharedInterests: shared,
    callbackToken: issueCallbackToken(a.clientId, a.name)
  });
  broadcastStats();
}

/** True when this client is free to receive a ring. */
function isReachable(clientId) {
  const socketId = online.get(clientId);
  if (!socketId) return null;
  if (rooms.forSocket(socketId)) return null;
  if (groups.roomOf(socketId)) return null;
  return socketId;
}

/**
 * Tells a waiting peer what is actually happening.
 *
 * A spinner with no information is indistinguishable from a broken app, which
 * matters most on a quiet server where waiting is normal. This reports the real
 * queue depth and names any filter that has been relaxed, so a long wait reads
 * as "nobody is here yet" rather than "this is broken".
 */
function emitWaiting(socket, peer) {
  const relaxed = relaxationFor(peer);
  socket.emit('waiting', {
    mode: peer.mode,
    queued: matchmaker.waitingIn(peer.mode),
    online: peers.size,
    waitedMs: Date.now() - peer.joinedAt,
    relaxedLabel: relaxed.label
  });
}

/**
 * Tells idle watchers that somebody has started looking for a call.
 *
 * Only peers who explicitly opted in are pinged, and only when they are neither
 * queued nor already in a room — otherwise this would interrupt the very
 * conversation it is advertising.
 */
function pingWatchers(exceptSocketId) {
  const notified = new Set();

  for (const [socketId, candidate] of peers) {
    if (socketId === exceptSocketId) continue;
    if (!candidate.notifyWhenOnline) continue;
    if (rooms.forSocket(socketId)) continue;
    if (matchmaker.pool.has(socketId)) continue;
    io.to(socketId).emit('someone:waiting', { waiting: matchmaker.size() });
    if (candidate.clientId) notified.add(candidate.clientId);
  }

  // Push reaches the people who opted in but have no socket open at all, which
  // is most of them — that is the whole point of the feature.
  pushWaitingWatchers(notified).catch(() => {});
}

/**
 * Rate-limited so a busy queue cannot turn into a stream of notifications.
 *
 * Somebody joining the queue every few seconds would otherwise buzz every
 * watcher every few seconds, which is how people turn notifications off and
 * never turn them back on.
 */
let lastWaitingPush = 0;
const WAITING_PUSH_COOLDOWN_MS = 15 * 60 * 1000;

async function pushWaitingWatchers(alreadyNotified) {
  if (!push.isConfigured()) return;
  if (Date.now() - lastWaitingPush < WAITING_PUSH_COOLDOWN_MS) return;
  lastWaitingPush = Date.now();

  for (const [clientId, peerRef] of watchers) {
    if (alreadyNotified.has(clientId)) continue;
    if (!peerRef) continue;
    await push.sendTo(clientId, {
      title: 'Friends Talk',
      body: 'Someone is looking for a call right now.',
      tag: 'someone-waiting',
      url: '/app'
    });
  }
}

/**
 * Clients who asked to be told when the queue is busy, remembered by client id
 * so the interest outlives the socket that expressed it.
 * @type {Map<string, boolean>}
 */
const watchers = new Map();

let sweepTimer = null;

function startSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    for (const [a, b] of matchmaker.sweep()) {
      if (peers.has(a.id) && peers.has(b.id)) pair(a, b);
    }
    // Refresh everyone still waiting so relaxation notices and queue depth
    // stay current without the client polling for them.
    for (const waiter of matchmaker.pool.values()) {
      const socket = io.sockets.sockets.get(waiter.id);
      if (socket) emitWaiting(socket, waiter);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/**
 * Removes a peer from their group room and tells the rest.
 *
 * Every remaining member has to be told individually, because each one holds
 * its own peer connection to the leaver and needs to tear that one down while
 * keeping the others alive.
 */
function leaveGroup(socket, reason) {
  const result = groups.leave(socket.id);
  if (!result) return;

  for (const member of result.room.members.keys()) {
    io.to(member).emit('group:peer-left', {
      id: socket.id,
      reason,
      size: result.room.members.size
    });
  }
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
    const isDrawer = room.game.drawer === memberId;
    io.to(memberId).emit('game:state', {
      type: room.game.type || 'tic-tac-toe',
      // Tic-tac-toe
      board: room.game.board,
      yourMark: room.game.marks ? room.game.marks[memberId] : null,
      // Pitch-match
      targetPitch: room.game.targetPitch,
      scores: room.game.scores,
      // Trivia
      questions: room.game.questions,
      currentIndex: room.game.currentIndex,
      answers: room.game.answers,
      // Drawing
      isDrawer,
      word: isDrawer ? room.game.word : null,
      // Shared
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
startSweep();

console.log(
  push.init()
    ? 'Push: notifications enabled.'
    : 'Push: no VAPID keys — notifications are OFF. Generate them with scripts/make-vapid.mjs.'
);

// Check the credential before announcing the feature, so the log tells the
// truth about what this process can actually do.
await voiceVerify();

if (voiceAvailable()) {
  console.log(`Voice: captions, translation, and spoken-word moderation enabled via ${voiceProvider()}.`);
} else if (voiceProvider()) {
  console.warn(
    `Voice: a ${voiceProvider()} key is set but ${voiceReason()} — ` +
    'captions and spoken-word moderation are OFF. Everything else works normally.'
  );
} else {
  console.log('Voice: no GEMINI_API_KEY or OPENAI_API_KEY — captions and spoken-word moderation are OFF.');
}

httpServer.listen(PORT, () => {
  console.log(`Friends Talk listening on http://localhost:${PORT}`);
});
