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
    const diffA = game.scores[playerId];
    const diffB = game.scores[partnerId];

    if (Math.abs(diffA - diffB) < 0.1) {
      game.winner = 'draw';
    } else {
      game.winner = diffA < diffB ? playerId : partnerId;
    }
    game.finished = true;
  } else {
    game.turn = partnerId;
  }

  return { ok: true, game };
}

// Trivia Question Bank for in-call trivia battle
const TRIVIA_BANK = [
  {
    q: "What is the fastest land animal in the world?",
    options: ["Cheetah", "Pronghorn", "Lion", "Peregrine Falcon"],
    answer: 0
  },
  {
    q: "Which planet in our solar system has the most moons?",
    options: ["Saturn", "Jupiter", "Neptune", "Uranus"],
    answer: 0
  },
  {
    q: "In what year was the World Wide Web created?",
    options: ["1989", "1995", "1983", "1991"],
    answer: 0
  },
  {
    q: "Which element has the chemical symbol 'Au'?",
    options: ["Silver", "Gold", "Argon", "Aluminum"],
    answer: 1
  },
  {
    q: "What is the national animal of Scotland?",
    options: ["Red Deer", "Unicorn", "Golden Eagle", "Highland Cow"],
    answer: 1
  },
  {
    q: "Who directed the movie 'Interstellar'?",
    options: ["Denis Villeneuve", "Christopher Nolan", "James Cameron", "Ridley Scott"],
    answer: 1
  },
  {
    q: "What is the capital city of Australia?",
    options: ["Sydney", "Melbourne", "Canberra", "Brisbane"],
    answer: 2
  },
  {
    q: "How many bits are in one byte?",
    options: ["4", "16", "8", "32"],
    answer: 2
  },
  {
    q: "Which video game franchise features the character 'Master Chief'?",
    options: ["Gears of War", "Destiny", "Halo", "Doom"],
    answer: 2
  },
  {
    q: "What is the hardest natural substance on Earth?",
    options: ["Quartz", "Graphene", "Diamond", "Titanium"],
    answer: 2
  }
];

export function newTriviaGame(firstPlayerId, secondPlayerId) {
  // Pick 5 unique random questions
  const shuffled = [...TRIVIA_BANK].sort(() => Math.random() - 0.5);
  const questions = shuffled.slice(0, 5);

  return {
    type: 'trivia',
    questions,
    currentIndex: 0,
    scores: { [firstPlayerId]: 0, [secondPlayerId]: 0 },
    answers: { [firstPlayerId]: null, [secondPlayerId]: null },
    winner: null,
    finished: false
  };
}

export function submitTriviaAnswer(game, playerId, answerIndex) {
  if (!game || game.finished || game.type !== 'trivia') return { ok: false };
  if (game.answers[playerId] !== null) return { ok: false }; // already answered this round

  const currentQ = game.questions[game.currentIndex];
  if (!currentQ) return { ok: false };

  game.answers[playerId] = answerIndex;
  if (answerIndex === currentQ.answer) {
    game.scores[playerId] = (game.scores[playerId] || 0) + 100;
  }

  const partnerId = Object.keys(game.scores).find((id) => id !== playerId);
  if (game.answers[partnerId] !== null) {
    // Both players answered current question! Move to next or finish
    if (game.currentIndex + 1 < game.questions.length) {
      game.currentIndex += 1;
      game.answers[playerId] = null;
      game.answers[partnerId] = null;
    } else {
      // Game completed!
      const scoreA = game.scores[playerId];
      const scoreB = game.scores[partnerId];
      if (scoreA === scoreB) {
        game.winner = 'draw';
      } else {
        game.winner = scoreA > scoreB ? playerId : partnerId;
      }
      game.finished = true;
    }
  }

  return { ok: true, game };
}

export function newDrawingGame(firstPlayerId, secondPlayerId) {
  const WORDS = ["Sunset", "Robot", "Guitar", "Pizza", "Castle", "Rocket", "Dolphin", "Volcano", "Bicycle", "Dragon"];
  const randomWord = WORDS[Math.floor(Math.random() * WORDS.length)];

  return {
    type: 'drawing',
    drawer: firstPlayerId,
    guesser: secondPlayerId,
    word: randomWord,
    strokes: [],
    finished: false
  };
}


