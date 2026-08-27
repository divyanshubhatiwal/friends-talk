// Web Push.
//
// Sends a notification to a person whose tab is closed. Everything here is
// best-effort: a push that fails must never disturb the call or the queue it
// was triggered from, so every send swallows its own errors.
//
// Without VAPID keys the module reports itself unconfigured and every send is
// a no-op, exactly like the speech provider — a missing key degrades a feature
// rather than breaking the server.

import webpush from 'web-push';
import * as store from './storage/repository.js';

let ready = false;

export function init() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    ready = false;
    return false;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:hello@friendstalk.fun',
    publicKey,
    privateKey
  );
  ready = true;
  return true;
}

export function isConfigured() {
  return ready;
}

/** The browser needs this to create a subscription; it is not a secret. */
export function publicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * Pushes to every device a client has registered.
 *
 * A 404 or 410 means that endpoint is permanently dead — the browser was
 * uninstalled, permission was revoked, or the endpoint rotated. Those are
 * deleted on sight, because the only way to discover a dead subscription is to
 * try it, and keeping it means retrying forever.
 */
export async function sendTo(clientId, payload) {
  if (!ready || !clientId) return 0;

  let subscriptions;
  try {
    subscriptions = await store.listPushSubscriptions(clientId);
  } catch {
    return 0;
  }
  if (!subscriptions.length) return 0;

  const body = JSON.stringify(payload);
  let delivered = 0;

  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(subscription, body, { TTL: 120 });
      delivered++;
    } catch (error) {
      const status = error?.statusCode;
      if (status === 404 || status === 410) {
        await store.deletePushSubscription(subscription.endpoint).catch(() => {});
      }
      // Any other failure is transient and deliberately ignored.
    }
  }));

  return delivered;
}
