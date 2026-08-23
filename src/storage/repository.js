// The data API the server talks to.
//
// Every function here works with or without a database. If Mongo connects, the
// Mongo implementation is used; otherwise an in-memory one takes over with the
// same signatures and the process keeps serving calls. `isPersistent()` reports
// which is live so the operator can tell from the logs.

import { connect, describeTarget, expiresIn, RETENTION } from './mongo.js';

let db = null;
let persistent = false;

/** In-memory stand-ins, used only when there is no database. */
const memory = {
  blocks: new Map(),        // clientId -> Set(blockedId)
  friendships: new Map(),   // clientId -> Map(friendId -> {name, expiresAt})
  friendMessages: [],
  calls: [],
  reports: [],
  bans: new Map()
};

export async function init() {
  try {
    db = await connect();
    persistent = true;
    console.log(`Storage: connected to ${describeTarget()}`);
  } catch (error) {
    db = null;
    persistent = false;
    console.warn(
      `Storage: database unavailable (${error.message}). ` +
      'Falling back to in-memory storage — friends, blocks, and reports will ' +
      'not survive a restart.'
    );
  }
  return persistent;
}

export function isPersistent() {
  return persistent;
}

// -------------------------------------------------------------------- blocks

export async function addBlock(clientId, blockedId) {
  if (!clientId || !blockedId) return;

  if (db) {
    await db.collection('blocks').updateOne(
      { clientId, blockedId },
      { $setOnInsert: { clientId, blockedId, at: new Date() } },
      { upsert: true }
    );
    return;
  }
  if (!memory.blocks.has(clientId)) memory.blocks.set(clientId, new Set());
  memory.blocks.get(clientId).add(blockedId);
}

export async function listBlocks(clientId) {
  if (!clientId) return [];

  if (db) {
    const rows = await db.collection('blocks')
      .find({ clientId }, { projection: { blockedId: 1 } })
      .toArray();
    return rows.map((row) => row.blockedId);
  }
  return [...(memory.blocks.get(clientId) || [])];
}

// ---------------------------------------------------------------- friendships

export async function addFriend(clientId, friendId, name) {
  if (!clientId || !friendId) return;
  const expiresAt = expiresIn(RETENTION.friendship);

  if (db) {
    await db.collection('friendships').updateOne(
      { clientId, friendId },
      { $set: { name, expiresAt, lastSeenAt: new Date() }, $setOnInsert: { at: new Date() } },
      { upsert: true }
    );
    return;
  }
  if (!memory.friendships.has(clientId)) memory.friendships.set(clientId, new Map());
  memory.friendships.get(clientId).set(friendId, { name, expiresAt });
}

export async function listFriends(clientId) {
  if (!clientId) return [];

  if (db) {
    const rows = await db.collection('friendships')
      .find({ clientId }, { projection: { friendId: 1, name: 1, lastSeenAt: 1 } })
      .sort({ lastSeenAt: -1 })
      .limit(100)
      .toArray();
    return rows.map((row) => ({ clientId: row.friendId, name: row.name }));
  }
  const map = memory.friendships.get(clientId) || new Map();
  return [...map.entries()].map(([friendId, value]) => ({ clientId: friendId, name: value.name }));
}

/**
 * Removes a friendship in both directions.
 *
 * Blocking someone you were friends with has to sever the link as well —
 * leaving them in the friends list would keep offering a call button for
 * somebody you have just refused to hear from again.
 */
export async function removeFriend(clientId, friendId) {
  if (!clientId || !friendId) return;

  if (db) {
    await db.collection('friendships').deleteMany({
      $or: [
        { clientId, friendId },
        { clientId: friendId, friendId: clientId }
      ]
    });
    return;
  }
  memory.friendships.get(clientId)?.delete(friendId);
  memory.friendships.get(friendId)?.delete(clientId);
}

/** Pushes the expiry out whenever two friends actually talk again. */
export async function touchFriendship(clientId, friendId) {
  if (!db || !clientId || !friendId) return;
  await db.collection('friendships').updateOne(
    { clientId, friendId },
    { $set: { lastSeenAt: new Date(), expiresAt: expiresIn(RETENTION.friendship) } }
  );
}

// ------------------------------------------------------------ friend messages

export async function saveFriendMessage({ from, to, text }) {
  const doc = { from, to, text, at: new Date(), expiresAt: expiresIn(RETENTION.friendMessage) };

  if (db) {
    await db.collection('friendMessages').insertOne(doc);
    return;
  }
  memory.friendMessages.push(doc);
  if (memory.friendMessages.length > 1000) memory.friendMessages.shift();
}

export async function inboxFor(clientId) {
  if (!clientId) return [];

  if (db) {
    return db.collection('friendMessages')
      .find({ to: clientId })
      .sort({ at: -1 })
      .limit(50)
      .toArray();
  }
  return memory.friendMessages.filter((m) => m.to === clientId).slice(-50);
}

// --------------------------------------------------------------- call records

/**
 * Metadata only — who was connected and for how long. No audio, no transcript,
 * and no message contents are written here or anywhere else.
 */
export async function recordCall({ roomId, mode, participants, countries, startedAt, duration }) {
  const doc = {
    roomId,
    mode,
    participants,
    countries,
    startedAt: new Date(startedAt),
    endedAt: new Date(),
    durationMs: duration,
    expiresAt: expiresIn(RETENTION.call)
  };

  if (db) {
    await db.collection('calls').insertOne(doc);
    return;
  }
  memory.calls.unshift(doc);
  if (memory.calls.length > 500) memory.calls.pop();
}

export async function recentCalls(limit = 50) {
  if (db) {
    return db.collection('calls').find({}).sort({ startedAt: -1 }).limit(limit).toArray();
  }
  return memory.calls.slice(0, limit);
}

// -------------------------------------------------------------------- reports

export async function saveReport(entry) {
  const doc = { ...entry, at: new Date(), expiresAt: expiresIn(RETENTION.report) };

  if (db) {
    await db.collection('reports').insertOne(doc);
    return;
  }
  memory.reports.unshift(doc);
  if (memory.reports.length > 500) memory.reports.pop();
}

export async function recentReports(limit = 100) {
  if (db) {
    return db.collection('reports').find({}).sort({ at: -1 }).limit(limit).toArray();
  }
  return memory.reports.slice(0, limit);
}

/** How many times a given client has been reported inside the window. */
export async function reportCountFor(clientId, sinceMs = 24 * 60 * 60 * 1000) {
  if (!clientId) return 0;
  const since = new Date(Date.now() - sinceMs);

  if (db) {
    return db.collection('reports').countDocuments({ clientId, at: { $gte: since } });
  }
  return memory.reports.filter((r) => r.clientId === clientId && r.at >= since).length;
}

// ----------------------------------------------------------------------- bans

export async function banClient(clientId, { reason, seconds }) {
  if (!clientId) return;
  const doc = { clientId, reason, at: new Date(), expiresAt: expiresIn(seconds) };

  if (db) {
    await db.collection('bans').updateOne({ clientId }, { $set: doc }, { upsert: true });
    return;
  }
  memory.bans.set(clientId, doc);
}

export async function isBanned(clientId) {
  if (!clientId) return false;

  if (db) {
    const row = await db.collection('bans').findOne({ clientId });
    return Boolean(row && row.expiresAt > new Date());
  }
  const row = memory.bans.get(clientId);
  return Boolean(row && row.expiresAt > new Date());
}
