// Speech pipeline.
//
// One transcription serves two purposes, which is why they live together:
//
//   captions    — the words are shown to the other person, optionally translated
//   moderation  — the same words are screened, so what people *say* is covered
//
// Screening text and images while leaving the primary channel of a voice app
// completely unmoderated is not a safety posture. This closes that.
//
// Two providers are supported. Gemini is preferred when both keys are present,
// because it accepts audio directly and can transcribe and translate in a
// single request; OpenAI needs Whisper for the audio and a second chat call for
// the translation.
//
// Everything here is best-effort. With no key configured the functions return
// null and the caller carries on with captions disabled — a missing API key
// must never stop two people from talking.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || 'gpt-4o-mini';

// A few seconds of Opus is tens of kilobytes. Anything much larger is either a
// misconfigured client or someone using the endpoint as a file upload.
const MAX_CLIP_BYTES = 1_000_000;

// Marker the model returns for a clip with no speech in it, so silence does not
// become a caption.
const NO_SPEECH = 'NO_SPEECH';

export function provider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return null;
}

/**
 * Credential health, established once at boot.
 *
 * A key being *present* is not the same as a key that *works* — an expired
 * OAuth token or a revoked key looks identical to a good one from the
 * environment. Without this check the app would offer a captions switch that
 * silently failed on every clip, which is worse than not offering it at all.
 */
const health = { checked: false, ok: false, reason: null };

export function isAvailable() {
  if (provider() === null) return false;
  return health.checked ? health.ok : true;
}

export function healthReason() {
  return health.reason;
}

/** One cheap round-trip to confirm the credential is accepted. */
export async function verify() {
  if (provider() === null) {
    Object.assign(health, { checked: true, ok: false, reason: 'no key configured' });
    return health;
  }

  try {
    const reply = provider() === 'gemini'
      ? await geminiText('Reply with exactly: OK')
      : await openaiTranslate('Reply with exactly: OK', 'OK');
    Object.assign(health, reply
      ? { checked: true, ok: true, reason: null }
      : { checked: true, ok: false, reason: 'the provider rejected the credential' });
  } catch (error) {
    Object.assign(health, { checked: true, ok: false, reason: error.message });
  }
  return health;
}

export const LANGUAGES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', ru: 'Russian', hi: 'Hindi', bn: 'Bengali', ar: 'Arabic',
  zh: 'Chinese', ja: 'Japanese', ko: 'Korean', tr: 'Turkish', pl: 'Polish',
  nl: 'Dutch', sv: 'Swedish', uk: 'Ukrainian', vi: 'Vietnamese', id: 'Indonesian'
};

/**
 * Turns a short audio clip into text.
 *
 * `language` is a hint, not a constraint — naming the speaker's own language
 * improves accuracy, but what was actually said still wins.
 */
export async function transcribe(buffer, { mimeType = 'audio/webm', language } = {}) {
  if (!buffer?.byteLength || buffer.byteLength > MAX_CLIP_BYTES) return null;

  const text = provider() === 'gemini'
    ? await geminiTranscribe(buffer, mimeType, language)
    : provider() === 'openai'
      ? await openaiTranscribe(buffer, mimeType, language)
      : null;

  if (!text || text.includes(NO_SPEECH) || isLikelySilence(text)) return null;
  return text;
}

/** Translates a caption. Returns null on any failure, so the original shows. */
export async function translate(text, targetLanguage) {
  if (!text || !LANGUAGES[targetLanguage]) return null;

  const instruction =
    `Translate this line of live conversation captioning into ${LANGUAGES[targetLanguage]}. ` +
    'Reply with the translation only — no quotes, no notes, no explanation. ' +
    'If it is already in that language, repeat it unchanged.';

  if (provider() === 'gemini') return geminiText(`${instruction}\n\n${text.slice(0, 500)}`);
  if (provider() === 'openai') return openaiTranslate(instruction, text);
  return null;
}

/** Generates custom icebreaker questions for matching interests. */
export async function generateIcebreaker(interests = []) {
  const list = Array.isArray(interests) && interests.length > 0 ? interests : ['general conversation', 'meeting new friends'];
  const prompt =
    `Generate three engaging, creative, or slightly deep icebreaker questions to start a friendly voice chat between two strangers who matched on these interests: ${list.join(', ')}. ` +
    'The questions should be quick, fun, open-ended, and avoid generic clichés. ' +
    'Reply with only the three numbered questions, one per line (e.g. "1. Question...\\n2. Question...\\n3. Question..."). Do not add any introduction, header, quotes, or notes.';

  if (provider() === 'gemini') return geminiText(prompt);
  if (provider() === 'openai') return openaiTranslate(prompt, "Icebreaker request");
  return null;
}


// ------------------------------------------------------------------- Gemini

async function geminiTranscribe(buffer, mimeType, language) {
  const hint = LANGUAGES[language] ? ` The speaker is most likely speaking ${LANGUAGES[language]}.` : '';
  const prompt =
    'Transcribe the speech in this audio clip. Reply with only the words that ' +
    `were spoken — no speaker labels, no timestamps, no commentary.${hint} ` +
    `If there is no intelligible speech, reply with exactly ${NO_SPEECH}.`;

  return geminiCall({
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: geminiAudioMime(mimeType), data: Buffer.from(buffer).toString('base64') } }
      ]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 256 }
  });
}

async function geminiText(prompt) {
  return geminiCall({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 256 }
  });
}

/**
 * Google issues two credential shapes and they do not authenticate the same way.
 *
 *   AIza…   a long-lived API key, sent as a ?key= query parameter
 *   AQ.… / ya29.…  a short-lived OAuth access token, sent as a Bearer header
 *
 * Sending one in the other's position fails with a 401 that looks exactly like
 * a bad key, so the shape is detected rather than assumed.
 */
export function geminiAuth() {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  const isApiKey = /^AIza[\w-]{10,}$/.test(key);
  return isApiKey
    ? { query: `?key=${encodeURIComponent(key)}`, headers: {} }
    : { query: '', headers: { Authorization: `Bearer ${key}` } };
}

async function geminiCall(body) {
  const auth = geminiAuth();
  try {
    const res = await fetch(
      `${GEMINI_URL}/${GEMINI_MODEL}:generateContent${auth.query}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000)
      }
    );

    if (!res.ok) {
      // Surface the reason once rather than failing silently forever — a wrong
      // key or an unsupported audio format looks identical from the UI.
      warnOnce(`Gemini request failed (${res.status}). Captions are degraded.`);
      return null;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Gemini does not accept every container MediaRecorder can produce.
 *
 * Chrome records WebM/Opus; Gemini's documented audio types are ogg, mp3, wav,
 * aac, aiff and flac. WebM and Ogg are both Opus containers, and declaring the
 * clip as ogg is what gets Chrome's output accepted. The client prefers real
 * audio/ogg where the browser offers it.
 */
function geminiAudioMime(mimeType) {
  const base = String(mimeType).split(';')[0].trim();
  if (base === 'audio/webm') return 'audio/ogg';
  return base || 'audio/ogg';
}

let warned = false;
function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn('Voice:', message);
}

// ------------------------------------------------------------------- OpenAI

async function openaiTranscribe(buffer, mimeType, language) {
  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), 'clip.webm');
    form.append('model', TRANSCRIBE_MODEL);
    form.append('response_format', 'json');
    if (language && LANGUAGES[language]) form.append('language', language);

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(12000)
    });

    if (!res.ok) return null;
    const body = await res.json();
    return String(body?.text || '').trim() || null;
  } catch {
    return null;
  }
}

async function openaiTranslate(instruction, text) {
  try {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: text.slice(0, 500) }
        ]
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (!res.ok) return null;
    const body = await res.json();
    return body?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- shared

// Speech models emit stock phrases on silence. A caption track that says
// "Thank you." during every pause is worse than no captions at all.
const SILENCE_ARTEFACTS = new Set([
  'you', 'thank you', 'thanks for watching', 'thank you.', 'bye', 'bye.',
  '.', '. .', 'thanks for watching!', 'you.', 'subscribe', 'silence',
  '[silence]', '(silence)', 'no speech'
]);

function isLikelySilence(text) {
  return SILENCE_ARTEFACTS.has(text.toLowerCase().trim());
}
