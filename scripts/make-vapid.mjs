// Generates the VAPID key pair that signs push notifications.
//
//   node scripts/make-vapid.mjs
//
// Writes the pair into .env if it is not already there, and prints only the
// public key — the private key signs pushes and must never be shown or shared.
//
// Regenerating invalidates every existing subscription: browsers hold a key
// bound to the one they subscribed with, so everybody silently stops receiving
// notifications. Generate once, then keep the pair stable and set the same
// values in production.

import webpush from 'web-push';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(root, '.env');

const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

if (/^VAPID_PRIVATE_KEY=.+/m.test(existing)) {
  const publicKey = /^VAPID_PUBLIC_KEY=(.+)$/m.exec(existing)?.[1]?.trim();
  console.log('VAPID keys already exist in .env — leaving them alone.');
  console.log('public key:', publicKey);
  console.log('\nDelete both VAPID_ lines first if you genuinely want new ones,');
  console.log('and expect every current subscriber to stop receiving pushes.');
  process.exit(0);
}

const keys = webpush.generateVAPIDKeys();
const subject = process.env.VAPID_SUBJECT || 'mailto:hello@friendstalk.fun';

const block = [
  '',
  '# Web Push. The public key is served to browsers; the private key signs',
  '# pushes and must never leave the server. Regenerating them invalidates',
  '# every existing subscription, so keep them stable.',
  `VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `VAPID_PRIVATE_KEY=${keys.privateKey}`,
  `VAPID_SUBJECT=${subject}`,
  ''
].join('\n');

writeFileSync(envPath, existing.trimEnd() + '\n' + block);

console.log('VAPID keys written to .env');
console.log('public key:', keys.publicKey);
console.log('private key: (written to .env, not printed)');
console.log('\nSet all three VAPID_ values in your host\'s environment too,');
console.log('or production will run with notifications disabled.');
