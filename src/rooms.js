// Live room bookkeeping. Rooms exist only while two peers are connected —
// nothing here is persisted, and no audio ever touches the server.

import { randomUUID } from 'node:crypto';

export class RoomRegistry {
  constructor() {
    /** @type {Map<string, object>} roomId -> room */
    this.rooms = new Map();
    /** @type {Map<string, string>} socketId -> roomId */
    this.bySocket = new Map();
  }

  create(a, b, mode) {
    const id = randomUUID();
    const room = {
      id,
      mode,
      members: [a.id, b.id],
      startedAt: Date.now(),
      game: null
    };
    this.rooms.set(id, room);
    this.bySocket.set(a.id, id);
    this.bySocket.set(b.id, id);
    return room;
  }

  get(roomId) {
    return this.rooms.get(roomId);
  }

  forSocket(socketId) {
    const roomId = this.bySocket.get(socketId);
    return roomId ? this.rooms.get(roomId) : null;
  }

  partnerOf(socketId) {
    const room = this.forSocket(socketId);
    if (!room) return null;
    return room.members.find((id) => id !== socketId) || null;
  }

  destroy(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    for (const memberId of room.members) this.bySocket.delete(memberId);
    this.rooms.delete(roomId);
    return room;
  }

  size() {
    return this.rooms.size;
  }
}

// Tic-tac-toe, the in-call ice-breaker. Board is a flat array of 9 cells.
const WINNING_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

export function newGame(firstPlayerId, secondPlayerId) {
  return {
    board: Array(9).fill(null),
    marks: { [firstPlayerId]: 'X', [secondPlayerId]: 'O' },
    turn: firstPlayerId,
    winner: null,
    finished: false
  };
}

export function applyMove(game, playerId, cell) {
  if (!game || game.finished) return { ok: false, error: 'game_over' };
  if (game.turn !== playerId) return { ok: false, error: 'not_your_turn' };
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return { ok: false, error: 'bad_cell' };
  if (game.board[cell] !== null) return { ok: false, error: 'cell_taken' };

  const mark = game.marks[playerId];
  game.board[cell] = mark;

  for (const [x, y, z] of WINNING_LINES) {
    if (game.board[x] && game.board[x] === game.board[y] && game.board[y] === game.board[z]) {
      game.winner = mark;
      game.finished = true;
    }
  }
  if (!game.finished && game.board.every((c) => c !== null)) {
    game.finished = true; // draw
  }
  if (!game.finished) {
    game.turn = Object.keys(game.marks).find((id) => id !== playerId);
  }
  return { ok: true, game };
}

export function newPitchMatchGame(firstPlayerId, secondPlayerId) {
  // Generate a random target pitch between 110Hz (low male) and 270Hz (high female)
  const targetPitch = 110 + Math.floor(Math.random() * 160);
  return {
    type: 'pitch-match',
    targetPitch,
    scores: { [firstPlayerId]: null, [secondPlayerId]: null },
    turn: firstPlayerId,
    winner: null,
    finished: false
  };
}

export function submitPitchScore(game, playerId, difference) {
  if (!game || game.finished) return { ok: false };
  if (game.turn !== playerId) return { ok: false };
  if (typeof difference !== 'number' || isNaN(difference)) return { ok: false };

  game.scores[playerId] = difference;

  const partnerId = Object.keys(game.scores).find((id) => id !== playerId);
  if (game.scores[partnerId] !== null) {
    // Both players have submitted their scores!
    const diffA = game.scores[playerId];
    const diffB = game.scores[partnerId];

    if (Math.abs(diffA - diffB) < 0.1) {
      game.winner = 'draw';
    } else {
      // The one with the smaller absolute pitch difference wins!
      game.winner = diffA < diffB ? playerId : partnerId;
    }
    game.finished = true;
  } else {
    // Pass turn to the other player
    game.turn = partnerId;
  }

  return { ok: true, game };
}

