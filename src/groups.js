// Group rooms — small, ad-hoc voice rooms for three to five people.
//
// These are deliberately not matchmaking. One-to-one pairing asks "who is the
// best partner for this person"; a group room asks "where is there space".
// Somebody arriving alone opens a room and waits in it, which on a quiet server
// is far better than sitting in a queue: the next person to arrive lands in the
// same place instead of failing to be paired.
//
// Audio is a full mesh — every member holds a peer connection to every other.
// At five people that is four connections each, roughly 160 kbps of Opus
// upstream, which is comfortable. Video at this size would need a media server;
// audio does not, so there is no media infrastructure to run.

import { randomUUID } from 'node:crypto';

export const MAX_MEMBERS = 5;
const MIN_TO_KEEP_OPEN = 1;

export class GroupRegistry {
  constructor(maxMembers = MAX_MEMBERS) {
    this.maxMembers = maxMembers;
    /** @type {Map<string, object>} roomId -> room */
    this.rooms = new Map();
    /** @type {Map<string, string>} socketId -> roomId */
    this.bySocket = new Map();
  }

  /**
   * Places a peer into the best available room, opening one if needed.
   *
   * Preference order: a room sharing one of their interests, then the fullest
   * room that still has space, then a new room. Filling rooms before opening
   * new ones matters on a small server — three rooms of one person each is the
   * failure this feature exists to prevent.
   */
  findOrCreate(peer) {
    let best = null;
    let bestScore = -Infinity;

    for (const room of this.rooms.values()) {
      if (room.members.size >= this.maxMembers) continue;
      if (this.isBlockedIn(room, peer)) continue;

      let score = room.members.size * 10; // prefer fuller rooms
      const shared = room.topics.filter((topic) => peer.interests.includes(topic));
      score += shared.length * 25;

      if (score > bestScore) {
        bestScore = score;
        best = room;
      }
    }

    if (!best) {
      best = {
        id: randomUUID(),
        members: new Map(),
        topics: [],
        createdAt: Date.now()
      };
      this.rooms.set(best.id, best);
    }

    this.join(best, peer);
    return best;
  }

  /** Nobody should be dropped into a room with someone they blocked. */
  isBlockedIn(room, peer) {
    for (const member of room.members.values()) {
      if (peer.blocked.has(member.clientId)) return true;
      if (member.blocked.has(peer.clientId)) return true;
    }
    return false;
  }

  join(room, peer) {
    room.members.set(peer.id, peer);
    this.bySocket.set(peer.id, room.id);
    for (const interest of peer.interests) {
      if (!room.topics.includes(interest)) room.topics.push(interest);
    }
    return room;
  }

  leave(socketId) {
    const room = this.roomOf(socketId);
    if (!room) return null;

    room.members.delete(socketId);
    this.bySocket.delete(socketId);

    // An empty room is rubbish; a room with one person still waiting is not,
    // because the next arrival will join them rather than opening another.
    if (room.members.size < MIN_TO_KEEP_OPEN) {
      this.rooms.delete(room.id);
      return { room, closed: true };
    }
    return { room, closed: false };
  }

  roomOf(socketId) {
    const roomId = this.bySocket.get(socketId);
    return roomId ? this.rooms.get(roomId) : null;
  }

  /** What a client needs to render the participant list. */
  roster(room) {
    return [...room.members.values()].map((member) => ({
      id: member.id,
      name: member.name,
      country: member.country
    }));
  }

  stats() {
    let occupied = 0;
    let people = 0;
    for (const room of this.rooms.values()) {
      if (room.members.size) occupied++;
      people += room.members.size;
    }
    return { rooms: occupied, people };
  }
}
