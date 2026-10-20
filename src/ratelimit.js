// Sliding-window rate limiter.
//
// Each event type gets its own limiter with a max count per time window.
// The server checks `allow(socketId)` before processing an event; if the
// caller has exceeded the budget the event is silently dropped.
//
// Memory is bounded: entries are lazily pruned when checked, and the entire
// map is swept every minute so disconnected sockets do not accumulate.

export function createLimiter({ maxPerWindow = 10, windowMs = 60_000 } = {}) {
  /** @type {Map<string, number[]>} socketId -> sorted timestamps */
  const buckets = new Map();

  function allow(socketId) {
    const now = Date.now();
    const cutoff = now - windowMs;
    let timestamps = buckets.get(socketId);

    if (!timestamps) {
      timestamps = [];
      buckets.set(socketId, timestamps);
    }

    // Drop entries outside the window.
    while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();

    if (timestamps.length >= maxPerWindow) return false;

    timestamps.push(now);
    return true;
  }

  function remove(socketId) {
    buckets.delete(socketId);
  }

  // Prevent unbounded growth from sockets that disconnect without cleanup.
  const sweepInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [id, ts] of buckets) {
      if (!ts.length || ts[ts.length - 1] <= cutoff) buckets.delete(id);
    }
  }, 60_000);
  sweepInterval.unref?.();

  return { allow, remove };
}

// Pre-configured limiters for each event type. Import these directly.
export const limiters = {
  find:      createLimiter({ maxPerWindow: 6,  windowMs: 60_000 }),
  chat:      createLimiter({ maxPerWindow: 30, windowMs: 60_000 }),
  image:     createLimiter({ maxPerWindow: 5,  windowMs: 60_000 }),
  voiceClip: createLimiter({ maxPerWindow: 20, windowMs: 60_000 }),
  reaction:  createLimiter({ maxPerWindow: 30, windowMs: 60_000 }),
  jamNote:   createLimiter({ maxPerWindow: 60, windowMs: 60_000 }),
  prompt:    createLimiter({ maxPerWindow: 6,  windowMs: 60_000 })
};
