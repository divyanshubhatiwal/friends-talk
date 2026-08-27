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

  // Curated Themed Voice Lounges
  static THEMED_LOUNGES = [
    { id: 'lounge-cafe', name: 'The Late Night Café', desc: 'Chill vibes, coffee murmurs, and casual life chats', icon: '☕', tags: ['chill', 'coffee', 'casual'] },
    { id: 'lounge-devs', name: 'Devs & Terminal', desc: 'Code, tech talk, open source, and startups', icon: '💻', tags: ['coding', 'tech', 'ai'] },
    { id: 'lounge-gaming', name: 'Gaming & Anime Hub', desc: 'Co-op games, seasonal anime, and recommendations', icon: '🎮', tags: ['gaming', 'anime', 'manga'] },
    { id: 'lounge-language', name: 'Global Language Exchange', desc: 'Practice languages with native speakers worldwide', icon: '🌍', tags: ['english', 'spanish', 'japanese'] },
    { id: 'lounge-midnight', name: 'Midnight Confessions', desc: 'Deep thoughts, late night philosophy, and safe venting', icon: '🌙', tags: ['deep', 'night', 'philosophy'] }
  ];

  getLoungeList() {
    return GroupRegistry.THEMED_LOUNGES.map((lounge) => {
      const room = this.rooms.get(lounge.id);
      return {
        ...lounge,
        membersCount: room ? room.members.size : 0,
        capacity: 10
      };
    });
  }

  joinLounge(loungeId, peer) {
    const valid = GroupRegistry.THEMED_LOUNGES.find((l) => l.id === loungeId);
    if (!valid) return null;

    let room = this.rooms.get(loungeId);
    if (!room) {
      room = {
        id: loungeId,
        isLounge: true,
        title: valid.name,
        members: new Map(),
        topics: valid.tags,
        createdAt: Date.now()
      };
      this.rooms.set(loungeId, room);
    }

    room.members.set(peer.id, peer);
    this.bySocket.set(peer.id, room.id);
    return room;
  }
}

