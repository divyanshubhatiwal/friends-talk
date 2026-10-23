// Realtime voice sessions with Gemini's Live API.
//
// Two features share this one relay:
//
//   AI partner       — you talk to a Gemini voice persona, for when nobody is
//                      online or you just want practice.
//   live translation — the voice you hear from a stranger is re-spoken in
//                      your language, a second or two behind them.
//
// Why the server relays instead of the browser connecting to Google directly:
// the API key never leaves the server, and every minute of audio is billed, so
// the server is where session length and concurrency can actually be capped.
// The cost is one extra network hop of ~32 KB/s up and ~48 KB/s down per
// session, which a small instance handles comfortably.
//
// Audio formats are fixed by the API: 16-bit little-endian mono PCM, 16 kHz in,
// 24 kHz out. The browser does the resampling, so this file only shuttles
// bytes and never decodes audio.

import WebSocket from 'ws';
import { geminiAuth, LANGUAGES } from './voice.js';

const LIVE_URL = process.env.GEMINI_LIVE_URL ||
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

const CHAT_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const TRANSLATE_MODEL = process.env.GEMINI_TRANSLATE_MODEL || 'gemini-3.5-live-translate-preview';

// Every second of a session costs money, so both limits default low and can be
// raised from the environment once real usage is known.
export const MAX_SESSION_MS = Number(process.env.AI_MAX_SESSION_MS) || 10 * 60_000;
const MAX_CONCURRENT = Number(process.env.AI_MAX_SESSIONS) || 20;

// A 100 ms chunk at 16 kHz is 3,200 bytes. Anything far larger is not a
// microphone; it is someone using the relay as a file upload.
const MAX_CHUNK_BYTES = 16_000;

// Setup that is never acknowledged means a wrong model name or a rejected
// key. Better to fail fast and say so than leave the user talking to nothing.
const SETUP_TIMEOUT_MS = 10_000;

let active = 0;

export function liveStats() {
  return { active, max: MAX_CONCURRENT };
}

/**
 * AI personas. Each one is a voice and a brief, not a script: the instruction
 * sets tone and boundaries and leaves the conversation to the model.
 */
export const PERSONAS = {
  friend: {
    name: 'Nova',
    emoji: '😊',
    label: 'Friendly stranger',
    voice: 'Kore',
    brief: 'You are Nova, a warm, curious person in your twenties chatting with a stranger on a voice app. ' +
      'Ask about their day and interests, share small relatable opinions, and keep it light and natural.'
  },
  debate: {
    name: 'Rex',
    emoji: '🔥',
    label: 'Debate partner',
    voice: 'Fenrir',
    brief: 'You are Rex, a sharp, good-humoured debater. Invite the user to pick any topic, then take the ' +
      'opposing side and argue it respectfully but firmly. Push back on weak points and concede good ones.'
  },
  tutor: {
    name: 'Mira',
    emoji: '📚',
    label: 'Language coach',
    voice: 'Aoede',
    brief: 'You are Mira, a patient language coach. Ask which language the user wants to practise, then ' +
      'converse in it at their level. Gently correct important mistakes by repeating the sentence correctly, ' +
      'then carry on the conversation.'
  },
  listener: {
    name: 'Sage',
    emoji: '🌙',
    label: 'Late-night listener',
    voice: 'Charon',
    brief: 'You are Sage, a calm and kind listener. Let the user lead; reflect back what you hear and ask ' +
      'gentle follow-up questions. You are not a therapist and do not diagnose. If the user mentions ' +
      'self-harm or being in danger, encourage them to contact local emergency services or a crisis line.'
  },
  traveller: {
    name: 'Kai',
    emoji: '🌍',
    label: 'World traveller',
    voice: 'Puck',
    brief: 'You are Kai, an enthusiastic traveller who has been to many countries. Swap stories, ask where ' +
      'the user is from and what it is like there, and recommend food, places and customs.'
  }
};

const SHARED_RULES =
  ' This is a spoken conversation: reply in one to three short sentences, sound natural, never use lists ' +
  'or markdown. Reply in the language the user speaks. You are an AI and say so if asked. Keep everything ' +
  'suitable for a general audience; decline sexual, hateful or dangerous requests briefly and change the subject. ' +
  'Never ask for or encourage sharing personal contact details. Start by greeting the user in one short sentence.';

function chatSetup(personaKey) {
  const persona = PERSONAS[personaKey] || PERSONAS.friend;
  return {
    setup: {
      model: `models/${CHAT_MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: persona.voice } } }
      },
      systemInstruction: { parts: [{ text: persona.brief + SHARED_RULES }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  };
}

/** The dedicated speech-to-speech translation model: keeps the speaker's tone. */
function translateSetup(target) {
  return {
    setup: {
      model: `models/${TRANSLATE_MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        translationConfig: { targetLanguageCode: target, echoTargetLanguage: false }
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  };
}

/**
 * Fallback when the translate model is not available on this key: a general
 * live model told to act purely as an interpreter. Slightly more prone to
 * answering a question instead of translating it, hence the blunt instruction.
 */
function interpreterSetup(target) {
  const language = LANGUAGES[target] || 'English';
  return {
    setup: {
      model: `models/${CHAT_MODEL}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
      },
      systemInstruction: {
        parts: [{
          text: `You are a simultaneous interpreter, not a participant. Everything you hear is someone else ` +
            `speaking. Translate it into ${language} and speak only the translation, in the first person, ` +
            `matching the speaker's tone. Never answer questions, never add comments, never greet. ` +
            `If the speech is already in ${language}, repeat it unchanged. If there is no speech, stay silent.`
        }]
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  };
}

function connect(setupMessage, handlers) {
  const auth = geminiAuth();
  const ws = new WebSocket(`${LIVE_URL}${auth.query}`, { headers: auth.headers });
  let ready = false;

  const setupTimer = setTimeout(() => {
    if (!ready) ws.terminate();
  }, SETUP_TIMEOUT_MS);

  ws.on('open', () => ws.send(JSON.stringify(setupMessage)));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.setupComplete) {
      ready = true;
      clearTimeout(setupTimer);
      handlers.onReady();
      return;
    }

    const content = msg.serverContent;
    if (!content) {
      if (msg.goAway) handlers.onGoAway?.();
      return;
    }

    if (content.interrupted) handlers.onInterrupted();

    for (const part of content.modelTurn?.parts || []) {
      const data = part.inlineData?.data;
      if (data) handlers.onAudio(Buffer.from(data, 'base64'));
    }

    if (content.inputTranscription?.text) handlers.onTranscript('in', content.inputTranscription.text);
    if (content.outputTranscription?.text) handlers.onTranscript('out', content.outputTranscription.text);
    if (content.turnComplete) handlers.onTurnComplete();
  });

  ws.on('close', (code, reason) => {
    clearTimeout(setupTimer);
    handlers.onClose({ ready, code, reason: reason?.toString() || '' });
  });

  ws.on('error', () => { /* the close event that follows carries the outcome */ });

  return {
    ws,
    isReady: () => ready,
    /** A complete text turn, e.g. to have the model speak first. */
    sendText(text) {
      if (!ready || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true }
      }));
    },
    sendAudio(buffer) {
      if (!ready || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        realtimeInput: { audio: { data: buffer.toString('base64'), mimeType: 'audio/pcm;rate=16000' } }
      }));
    },
    close() {
      try { ws.close(); } catch { /* already closed */ }
    }
  };
}

/**
 * Opens one realtime session.
 *
 * Returns null when the concurrency cap is reached, so the caller can tell the
 * user "busy, try again" instead of starting something that will be refused.
 *
 * handlers: onReady(), onAudio(Buffer pcm24k), onTranscript(dir, text),
 *           onInterrupted(), onTurnComplete(), onEnd(reason)
 */
export function openSession({ kind, persona, target }, handlers) {
  if (active >= MAX_CONCURRENT) return null;
  active += 1;

  let ended = false;
  let conn = null;
  let triedFallback = false;

  const lifetime = setTimeout(() => finish('time_limit'), MAX_SESSION_MS);

  function finish(reason) {
    if (ended) return;
    ended = true;
    active -= 1;
    clearTimeout(lifetime);
    conn?.close();
    handlers.onEnd(reason);
  }

  function start(setupMessage) {
    conn = connect(setupMessage, {
      onReady() {
        handlers.onReady();
        // The model only speaks when spoken to. An AI partner that sits in
        // silence until you say something feels broken, so prompt a greeting.
        if (kind === 'chat') conn.sendText('(The user has just joined the call. Greet them now.)');
      },
      onAudio: handlers.onAudio,
      onTranscript: handlers.onTranscript,
      onInterrupted: handlers.onInterrupted,
      onTurnComplete: handlers.onTurnComplete,
      onClose({ ready, code, reason }) {
        if (ended) return;
        // The dedicated translation model is a preview and may not be enabled
        // for every key. If its setup is refused, fall back once to the
        // general model acting as an interpreter.
        if (!ready && kind === 'translate' && !triedFallback) {
          triedFallback = true;
          console.warn(`Live: ${TRANSLATE_MODEL} refused (${code} ${reason}); using ${CHAT_MODEL} as interpreter.`);
          start(interpreterSetup(target));
          return;
        }
        if (!ready) console.warn(`Live: setup failed (${code} ${reason}).`);
        finish(ready ? 'closed' : 'unavailable');
      }
    });
  }

  start(kind === 'translate' ? translateSetup(target) : chatSetup(persona));

  return {
    sendAudio(chunk) {
      if (ended || !chunk?.byteLength || chunk.byteLength > MAX_CHUNK_BYTES) return;
      conn?.sendAudio(Buffer.from(chunk));
    },
    end: () => finish('ended')
  };
}
