// Matching engine.
//
// Everyone waiting sits in a single pool. When a peer joins the pool we score
// every other waiter against them and take the best mutually-compatible one.
// Scoring prefers shared interests, then longer wait time, so nobody starves.

const MODES = new Set(['voice', 'text']);
const RECENT_PARTNER_MEMORY = 6;

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
    let bestScore = -1;

    for (const candidate of this.pool.values()) {
      if (candidate.id === peer.id) continue;
      const score = this.score(peer, candidate);
      if (score < 0) continue;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  // Returns -1 for an impossible pairing, otherwise a preference score.
  score(a, b) {
    if (a.mode !== b.mode) return -1;
    if (a.clientId === b.clientId) return -1;
    if (a.blocked.has(b.clientId) || b.blocked.has(a.clientId)) return -1;
    if (!this.countryAllows(a, b) || !this.countryAllows(b, a)) return -1;
    if (!this.genderAllows(a, b) || !this.genderAllows(b, a)) return -1;

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
    if (!viewer.countries.length) return true;
    return viewer.countries.includes(candidate.country);
  }

  // Gender preference is a premium filter and is always an estimate, never a
  // guarantee — an unknown estimate is allowed through rather than dropped.
  genderAllows(viewer, candidate) {
    if (!viewer.premium) return true;
    if (!viewer.genderPreference || viewer.genderPreference === 'any') return true;
    if (!candidate.gender || candidate.gender === 'unknown') return true;
    return candidate.gender === viewer.genderPreference;
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
