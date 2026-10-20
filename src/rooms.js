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
  // Science & Nature
  { q: "What is the fastest land animal in the world?", options: ["Cheetah", "Pronghorn", "Lion", "Peregrine Falcon"], answer: 0 },
  { q: "Which planet in our solar system has the most moons?", options: ["Saturn", "Jupiter", "Neptune", "Uranus"], answer: 0 },
  { q: "Which element has the chemical symbol 'Au'?", options: ["Silver", "Gold", "Argon", "Aluminum"], answer: 1 },
  { q: "What is the hardest natural substance on Earth?", options: ["Quartz", "Graphene", "Diamond", "Titanium"], answer: 2 },
  { q: "How many bones are in the adult human body?", options: ["186", "206", "216", "196"], answer: 1 },
  { q: "Which gas makes up about 78% of Earth's atmosphere?", options: ["Oxygen", "Carbon dioxide", "Nitrogen", "Helium"], answer: 2 },
  { q: "What is the largest organ in the human body?", options: ["Liver", "Brain", "Skin", "Lungs"], answer: 2 },
  { q: "What temperature (°C) does water boil at sea level?", options: ["90", "100", "110", "95"], answer: 1 },

  // Geography & World
  { q: "What is the capital city of Australia?", options: ["Sydney", "Melbourne", "Canberra", "Brisbane"], answer: 2 },
  { q: "Which country has the longest coastline in the world?", options: ["Russia", "Australia", "Canada", "Indonesia"], answer: 2 },
  { q: "What is the smallest country in the world by area?", options: ["Monaco", "Vatican City", "San Marino", "Liechtenstein"], answer: 1 },
  { q: "Which river is the longest in the world?", options: ["Amazon", "Mississippi", "Yangtze", "Nile"], answer: 3 },
  { q: "What is the national animal of Scotland?", options: ["Red Deer", "Unicorn", "Golden Eagle", "Highland Cow"], answer: 1 },

  // Tech & Internet
  { q: "In what year was the World Wide Web created?", options: ["1989", "1995", "1983", "1991"], answer: 0 },
  { q: "How many bits are in one byte?", options: ["4", "16", "8", "32"], answer: 2 },
  { q: "What does 'HTTP' stand for?", options: ["HyperText Transfer Protocol", "High Transfer Text Protocol", "HyperText Transmission Port", "Home Text Transfer Protocol"], answer: 0 },
  { q: "Who co-founded Apple alongside Steve Jobs?", options: ["Bill Gates", "Steve Wozniak", "Tim Cook", "Larry Page"], answer: 1 },
  { q: "What programming language was created by Brendan Eich in 10 days?", options: ["Java", "Python", "JavaScript", "TypeScript"], answer: 2 },

  // Pop Culture & Entertainment
  { q: "Who directed the movie 'Interstellar'?", options: ["Denis Villeneuve", "Christopher Nolan", "James Cameron", "Ridley Scott"], answer: 1 },
  { q: "Which video game franchise features the character 'Master Chief'?", options: ["Gears of War", "Destiny", "Halo", "Doom"], answer: 2 },
  { q: "What is the best-selling video game of all time?", options: ["Tetris", "Minecraft", "GTA V", "Wii Sports"], answer: 1 },
  { q: "Which band released the album 'Abbey Road'?", options: ["The Rolling Stones", "Pink Floyd", "Led Zeppelin", "The Beatles"], answer: 3 },
  { q: "In what year was the first iPhone released?", options: ["2005", "2006", "2007", "2008"], answer: 2 },

  // History
  { q: "In what year did the Berlin Wall fall?", options: ["1987", "1989", "1991", "1990"], answer: 1 },
  { q: "Who was the first person to walk on the Moon?", options: ["Buzz Aldrin", "Yuri Gagarin", "Neil Armstrong", "John Glenn"], answer: 2 },
  { q: "Which ancient wonder was located in Alexandria?", options: ["Hanging Gardens", "Colossus", "Lighthouse", "Temple of Artemis"], answer: 2 },

  // Random & Fun
  { q: "What is the most spoken language in the world by native speakers?", options: ["English", "Spanish", "Mandarin Chinese", "Hindi"], answer: 2 },
  { q: "How many hearts does an octopus have?", options: ["1", "2", "3", "4"], answer: 2 },
  { q: "What is the rarest blood type?", options: ["O negative", "A positive", "AB negative", "B negative"], answer: 2 },
  { q: "Which chess piece can only move diagonally?", options: ["Rook", "Knight", "Bishop", "Queen"], answer: 2 }
];

/**
 * How long a single trivia question stays open.
 *
 * Without this the round only advances when BOTH players answer, so one person
 * who wanders off, loses signal or simply never picks freezes the game for the
 * other one with no way forward. The clock is what makes it self-advancing.
 */
export const TRIVIA_QUESTION_MS = 20000;

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
    // Absolute time so every client counts down to the same instant rather
    // than each starting its own drifting timer.
    deadline: Date.now() + TRIVIA_QUESTION_MS,
    winner: null,
    finished: false
  };
}

/**
 * Moves to the next question, or ends the game.
 *
 * Shared by both paths that can end a round — everyone answered, or the clock
 * ran out — so the two can never disagree about scoring or when it finishes.
 */
function advanceTrivia(game) {
  const ids = Object.keys(game.scores);

  if (game.currentIndex + 1 < game.questions.length) {
    game.currentIndex += 1;
    for (const id of ids) game.answers[id] = null;
    game.deadline = Date.now() + TRIVIA_QUESTION_MS;
    return;
  }

  const [a, b] = ids;
  game.winner = game.scores[a] === game.scores[b]
    ? 'draw'
    : (game.scores[a] > game.scores[b] ? a : b);
  game.finished = true;
  game.deadline = null;
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

  // Everyone has answered — move on without waiting for the clock.
  const everyoneAnswered = Object.keys(game.scores)
    .every((id) => game.answers[id] !== null);
  if (everyoneAnswered) advanceTrivia(game);

  return { ok: true, game };
}

/**
 * Called when a question's clock expires.
 *
 * Anyone who did not answer simply scores nothing for that question; a missed
 * answer should cost the round, not the whole game.
 */
export function expireTriviaQuestion(game) {
  if (!game || game.finished || game.type !== 'trivia') return { ok: false };
  if (game.deadline && Date.now() < game.deadline - 250) return { ok: false };
  advanceTrivia(game);
  return { ok: true, game };
}

export function newDrawingGame(firstPlayerId, secondPlayerId) {
  const WORDS = [
    "Sunset", "Robot", "Guitar", "Pizza", "Castle", "Rocket", "Dolphin",
    "Volcano", "Bicycle", "Dragon", "Rainbow", "Lighthouse", "Astronaut",
    "Penguin", "Tornado", "Spaceship", "Waterfall", "Crown", "Sword",
    "Treasure", "Anchor", "Fireworks", "Cactus", "Jellyfish", "Snowflake",
    "Compass", "Helicopter", "Skateboard", "Dinosaur", "Mermaid"
  ];
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

export function newReflexGame(firstPlayerId, secondPlayerId) {
  // Random delay before buzzer turns green (between 1800ms and 4500ms)
  const delayMs = 1800 + Math.floor(Math.random() * 2700);
  const triggerAt = Date.now() + delayMs;

  return {
    type: 'reflex',
    round: 1,
    maxRounds: 3,
    triggerAt,
    scores: { [firstPlayerId]: 0, [secondPlayerId]: 0 },
    tapped: { [firstPlayerId]: null, [secondPlayerId]: null },
    roundWinner: null,
    winner: null,
    finished: false
  };
}

export function submitReflexBuzzer(game, playerId, clientTimestamp) {
  if (!game || game.finished || game.type !== 'reflex') return { ok: false };
  if (game.tapped[playerId] !== null) return { ok: false }; // already tapped this round

  const now = Date.now();
  const latency = now - game.triggerAt;

  // If tapped BEFORE green trigger -> False start penalty
  if (now < game.triggerAt) {
    game.tapped[playerId] = -1; // false start
  } else {
    game.tapped[playerId] = Math.max(1, latency);
  }

  const partnerId = Object.keys(game.tapped).find((id) => id !== playerId);
  
  // If this was first valid tap or false start
  if (game.tapped[playerId] > 0 && (game.tapped[partnerId] === null || game.tapped[partnerId] === -1)) {
    game.roundWinner = playerId;
    game.scores[playerId] = (game.scores[playerId] || 0) + 1;
  } else if (game.tapped[playerId] === -1 && game.tapped[partnerId] !== -1) {
    game.roundWinner = partnerId;
    game.scores[partnerId] = (game.scores[partnerId] || 0) + 1;
  }

  // Check if round should conclude or next round should trigger
  if (game.scores[playerId] >= 3) {
    game.winner = playerId;
    game.finished = true;
  } else if (game.scores[partnerId] >= 3) {
    game.winner = partnerId;
    game.finished = true;
  } else if (game.tapped[partnerId] !== null || game.roundWinner !== null) {
    // Both tapped or round awarded, schedule next round trigger
    game.round += 1;
    game.tapped[playerId] = null;
    game.tapped[partnerId] = null;
    game.triggerAt = Date.now() + 2000 + Math.floor(Math.random() * 2500);
  }

  return { ok: true, game };
}



