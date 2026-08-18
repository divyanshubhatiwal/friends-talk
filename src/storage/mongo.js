// MongoDB connection.
//
// The URI is read from the environment and never hard-coded, because a
// connection string for anything but a local server carries a username and
// password.
//
// One client for the process. The driver keeps its own connection pool, so
// opening a client per request would build pools that never get reused.
//
// Connecting is best-effort: if the database is unreachable the caller falls
// back to in-memory storage rather than refusing to start. A random chat
// service losing its friends list is bad; refusing to connect two strangers
// because a database is down is worse.

import { MongoClient } from 'mongodb';

const DEFAULT_URI = 'mongodb://127.0.0.1:27017';
const DEFAULT_DB = 'wavelength';

const DAY = 24 * 60 * 60;

/**
 * Retention is enforced by the database, not by application code that might
 * never run. Each TTL index expires documents at the time stored in a Date
 * field, which is why every collection below carries an `expiresAt` Date
 * alongside whatever numeric timestamp the application uses.
 *
 * The periods here are the ones published in the privacy policy. Changing one
 * means changing that page too.
 */
const INDEXES = {
  blocks: [
    { key: { clientId: 1, blockedId: 1 }, unique: true, name: 'pair_unique' },
    { key: { clientId: 1 }, name: 'by_client' }
  ],
  friendships: [
    { key: { clientId: 1, friendId: 1 }, unique: true, name: 'pair_unique' },
    { key: { clientId: 1 }, name: 'by_client' },
    // 3 months after the friendship was last active.
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }
  ],
  friendMessages: [
    { key: { to: 1, at: -1 }, name: 'inbox' },
    // 2 weeks.
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }
  ],
  calls: [
    { key: { startedAt: -1 }, name: 'recent' },
    // 1 month.
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }
  ],
  reports: [
    { key: { at: -1 }, name: 'recent' },
    { key: { clientId: 1 }, name: 'by_client' },
    // 1 month.
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }
  ],
  bans: [
    { key: { clientId: 1 }, unique: true, name: 'client_unique' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl' }
  ]
};

export const RETENTION = {
  friendship: 90 * DAY,
  friendMessage: 14 * DAY,
  call: 30 * DAY,
  report: 30 * DAY
};

let client = null;
let database = null;
let connecting = null;

export function mongoUri() {
  return process.env.MONGODB_URI || DEFAULT_URI;
}

export function mongoDbName() {
  return process.env.MONGODB_DB || DEFAULT_DB;
}

/** Never logs the URI itself — it contains a password. */
export function describeTarget() {
  const uri = mongoUri();
  const scheme = uri.startsWith('mongodb+srv://') ? 'mongodb+srv' : 'mongodb';
  const host = uri.replace(/^mongodb(\+srv)?:\/\//, '').split('@').pop().split('/')[0];
  return `${scheme}://${host}/${mongoDbName()}`;
}

export async function connect() {
  if (database) return database;
  if (connecting) return connecting;

  connecting = (async () => {
    client = new MongoClient(mongoUri(), {
      // Fail fast rather than hanging the boot on an unreachable cluster.
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
    await client.connect();
    database = client.db(mongoDbName());
    await ensureIndexes(database);
    return database;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function ensureIndexes(db) {
  for (const [name, specs] of Object.entries(INDEXES)) {
    const collection = db.collection(name);
    for (const spec of specs) {
      const { key, ...options } = spec;
      // An index that already exists with different options throws rather than
      // silently keeping the old definition; surface that instead of hiding it.
      await collection.createIndex(key, options);
    }
  }
}

export async function close() {
  if (client) await client.close();
  client = null;
  database = null;
}

export function expiresIn(seconds) {
  return new Date(Date.now() + seconds * 1000);
}
