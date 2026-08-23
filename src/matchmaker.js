// Matching engine.
//
// Everyone waiting sits in a single pool. When a peer joins the pool we score
// every other waiter against them and take the best mutually-compatible one.
// Scoring prefers shared interests, then longer wait time, so nobody starves.

const MODES = new Set(['voice', 'text']);
const RECENT_PARTNER_MEMORY = 6;

/**
 * Filters loosen the longer someone waits.
 *
 * A filter that matches nobody is indistinguishable, from the user's side,
 * from a broken app: you press call and stare at a spinner forever. On a small
 * server that is the normal case, not the edge case. So after a few seconds we
 * quietly drop the preferences the user is least likely to care about, in
 * order, and tell them we did it.
 *
 * Blocks and mode are never relaxed — those are rules, not preferences.
 */
const RELAXATION = [
  { after: 0,     ignoreGender: false, ignoreCountry: false, label: null },
  { after: 12000, ignoreGender: true,  ignoreCountry: false, label: 'gender preference' },
  { after: 25000, ignoreGender: true,  ignoreCountry: true,  label: 'country filter' }
];

export function relaxationFor(peer, now = Date.now()) {
  const waited = now - peer.joinedAt;
  let current = RELAXATION[0];
  for (const step of RELAXATION) {
    if (waited >= step.after) current = step;
  }
  return current;
}

export class Matchmaker {
  constructor() {
    /** @type {Map<string, object>} socketId -> waiter */
    this.pool = new Map();
    /** @type {Map<string, string[]>} clientId -> recent partner clientIds */
    this.recent = new Map();
  }

  enqueue(peer) {
    if (!MODES.has(peer.mode)) return null;
    this.pool.set(peer.id, peer);

    const partner = this.findPartner(peer);
    if (!partner) return null;

    this.pool.delete(peer.id);
    this.pool.delete(partner.id);
    this.rememberPair(peer, partner);
    return partner;
  }

  dequeue(socketId) {
    this.pool.delete(socketId);
  }

  size() {
    return this.pool.size;
  }

  findPartner(peer) {
    let best = null;
    let bestScore = -Infinity;

    for (const candidate of this.pool.values()) {
      if (candidate.id === peer.id) continue;
      const score = this.score(peer, candidate);
      // null means the pairing is forbidden. A negative number is merely
      // undesirable, and still beats leaving both people in the queue.
      if (score === null) continue;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  /**
   * Returns null for a forbidden pairing, otherwise a preference score that
   * may legitimately be negative.
   *
   * Null and "low score" have to stay distinct. The anti-rematch penalty below
   * is a preference, not a rule: when two people are the only ones waiting,
   * pairing them again is far better than leaving them both in the queue
   * forever, which is what treating any negative score as forbidden used to do.
   */
  score(a, b) {
    if (a.mode !== b.mode) return null;
    if (a.clientId === b.clientId) return null;
    if (a.blocked.has(b.clientId) || b.blocked.has(a.clientId)) return null;
    if (!this.countryAllows(a, b) || !this.countryAllows(b, a)) return null;
    if (!this.genderAllows(a, b) || !this.genderAllows(b, a)) return null;

    let score = 0;

    const shared = a.interests.filter((tag) => b.interests.includes(tag));
    score += shared.length * 40;

    // Both sides filtered on country and both are satisfied — reward it.
    if (a.countries.length && b.countries.length) score += 10;

    const waited = Date.now() - Math.min(a.joinedAt, b.joinedAt);
    score += Math.min(Math.floor(waited / 1000), 60);

    // Gently avoid rematching the last few people this client spoke to.
    const seen = this.recent.get(a.clientId) || [];
    if (seen.includes(b.clientId)) score -= 200;

    return score;
  }

  countryAllows(viewer, candidate) {
    if (relaxationFor(viewer).ignoreCountry) return true;
    if (!viewer.countries.length) return true;
    return viewer.countries.includes(candidate.country);
  }

  // Gender preference is a premium filter and is always an estimate, never a
  // guarantee — an unknown estimate is allowed through rather than dropped.
  genderAllows(viewer, candidate) {
    if (!viewer.premium) return true;
    if (relaxationFor(viewer).ignoreGender) return true;
    if (!viewer.genderPreference || viewer.genderPreference === 'any') return true;
    if (!candidate.gender || candidate.gender === 'unknown') return true;
    return candidate.gender === viewer.genderPreference;
  }

  /**
   * Re-attempt matching for everyone already waiting.
   *
   * Matching otherwise only runs when someone joins the queue, so two people
   * whose filters relax past each other would both sit there indefinitely with
   * nobody to trigger a retry. The server runs this on a timer.
   */
  sweep() {
    const pairs = [];
    for (const peer of [...this.pool.values()]) {
      if (!this.pool.has(peer.id)) continue; // already paired earlier in this sweep
      const partner = this.findPartner(peer);
      if (!partner) continue;
      this.pool.delete(peer.id);
      this.pool.delete(partner.id);
      this.rememberPair(peer, partner);
      pairs.push([peer, partner]);
    }
    return pairs;
  }

  /** Queue depth for a mode, so waiting can show a real number. */
  waitingIn(mode) {
    let count = 0;
    for (const peer of this.pool.values()) if (peer.mode === mode) count++;
    return count;
  }

  rememberPair(a, b) {
    this.remember(a.clientId, b.clientId);
    this.remember(b.clientId, a.clientId);
  }

  remember(clientId, partnerId) {
    const list = this.recent.get(clientId) || [];
    list.unshift(partnerId);
    this.recent.set(clientId, list.slice(0, RECENT_PARTNER_MEMORY));
  }

  forget(clientId) {
    this.recent.delete(clientId);
  }
}
