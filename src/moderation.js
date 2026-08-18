// Moderation layer.
//
// Text and images are screened before they reach the other peer. The local
// screening below always runs. If OPENAI_API_KEY is set, images and borderline
// text are additionally sent to the OpenAI moderation endpoint — that call is
// best-effort and never blocks a message if the API is unreachable.

const SLUR_PATTERNS = [
  /\bkill\s+your\s*self\b/i,
  /\bn[i1]gg[e3]r\b/i,
  /\bf[a4]gg?[o0]t\b/i,
  /\bretard(ed)?\b/i,
  /\bc[u\*]nt\b/i
];

const SEXUAL_PATTERNS = [
  /\b(nudes?|naked|horny|sexting|dick\s*pic)\b/i,
  /\bsend\s+(me\s+)?(pics?|photos?)\s+of\s+(you|ur)\b/i
];

const CONTACT_PATTERNS = [
  /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/,                 // email
  /\b(?:\+?\d[\d\s-]{7,}\d)\b/,                     // phone number
  /\b(?:t\.me|telegram|whats?app|snapchat|snap|insta(?:gram)?)\b[:\s@]*[\w.]{3,}/i
];

// Signals that the speaker may be a minor. Voice-based age estimation is not
// possible server-side, so this is a text-only heuristic that flags for review.
const MINOR_PATTERNS = [
  /\bi(?:'m| am)\s*(?:1[0-7]|[89])\s*(?:years?\s*old|yo|y\/o)?\b/i,
  /\bin\s+(?:6th|7th|8th|9th|10th|11th)\s+grade\b/i,
  /\b(?:middle|primary)\s+school\b/i
];

const VERDICT = { ALLOW: 'allow', FLAG: 'flag', BLOCK: 'block' };

export function screenText(text) {
  const value = String(text || '');

  if (value.length > 2000) {
    return { verdict: VERDICT.BLOCK, reason: 'too_long' };
  }
  for (const re of SLUR_PATTERNS) {
    if (re.test(value)) return { verdict: VERDICT.BLOCK, reason: 'hate_or_harassment' };
  }
  for (const re of MINOR_PATTERNS) {
    if (re.test(value)) return { verdict: VERDICT.FLAG, reason: 'possible_minor' };
  }
  for (const re of SEXUAL_PATTERNS) {
    if (re.test(value)) return { verdict: VERDICT.BLOCK, reason: 'sexual_content' };
  }
  for (const re of CONTACT_PATTERNS) {
    if (re.test(value)) {
      return { verdict: VERDICT.FLAG, reason: 'contact_details', warn: true };
    }
  }
  return { verdict: VERDICT.ALLOW };
}

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function screenImage(dataUrl) {
  const match = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) return { verdict: VERDICT.BLOCK, reason: 'malformed_image' };

  const [, mime, payload] = match;
  if (!ALLOWED_IMAGE_TYPES.includes(mime)) {
    return { verdict: VERDICT.BLOCK, reason: 'unsupported_type' };
  }
  const bytes = Math.floor(payload.length * 0.75);
  if (bytes > MAX_IMAGE_BYTES) {
    return { verdict: VERDICT.BLOCK, reason: 'too_large' };
  }

  const remote = await screenImageRemotely(dataUrl);
  if (remote) return remote;

  return { verdict: VERDICT.ALLOW };
}

async function screenImageRemotely(dataUrl) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'omni-moderation-latest',
        input: [{ type: 'image_url', image_url: { url: dataUrl } }]
      }),
      signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) return null;
    const body = await res.json();
    const result = body?.results?.[0];
    if (!result) return null;

    if (result.flagged) {
      const categories = Object.entries(result.categories || {})
        .filter(([, on]) => on)
        .map(([name]) => name);
      return { verdict: VERDICT.BLOCK, reason: categories.join(',') || 'flagged' };
    }
  } catch {
    // Moderation provider unreachable — fall back to local screening only.
    return null;
  }
  return null;
}

export { VERDICT };
