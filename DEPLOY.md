# Deploying Wavelength

Two paths. **Both require the server to be publicly hosted** — a TestFlight app is only a shell that
talks to your server, so hosting is step 1 either way.

---

## Step 1 — Host the server (required for both paths)

The server needs Node 18+, a persistent process, and **WebSocket support**. That last one rules out
plain serverless functions. Render, Railway, and Fly.io all work.

### What to set

| Variable | Value |
|---|---|
| `MONGODB_URI` | your Atlas connection string |
| `MONGODB_DB` | `wavelength` |
| `PORT` | whatever the host injects (the server already reads it) |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | see below — not optional in practice |

### Two things that will bite you

**Atlas network access.** Atlas allowlists by IP. Your new host's address is not on that list, so the
first deploy connects to nothing — and because the server deliberately falls back to in-memory
storage rather than crashing, *it will look like it is working*. Add the host's egress IPs in Atlas →
Network Access, or `0.0.0.0/0` if the host has no stable IP. Then check the boot log:

```
Storage: connected to mongodb+srv://…/wavelength     ← good
Storage: database unavailable (…) Falling back…      ← allowlist is wrong
```

**You need a TURN server.** STUN alone fails for roughly 10–20% of users, and mobile carrier NAT is
among the worst cases — which is exactly your phone-using friends. Without TURN those calls connect
to silence and never recover. Either run `coturn` on a small VPS or use a hosted provider
(Twilio, Metered, Cloudflare Calls). This is the single most common reason a working local build
fails for real users.

HTTPS is mandatory, not a nicety: `getUserMedia` refuses to run outside a secure context, so
microphone access silently fails on plain HTTP. Every host above terminates TLS for you.

---

## Path A — Just send your friends a link (recommended)

Once step 1 is done, you are finished. Send the URL.

It works on iPhone Safari, Android Chrome, and desktop. No install, no app store, no review, no
developer account, no Mac. On iOS your friends can tap Share → **Add to Home Screen** and get an
icon that launches fullscreen, which is most of what a native app gives you here.

Cost: hosting only. Time: minutes.

---

## Path B — TestFlight

### What this requires that you do not currently have

1. **A Mac.** Xcode compiles and signs the binary and is macOS-only. There is no Windows path — not
   WSL, not a toolchain. Options: a Mac, a rented cloud Mac (MacStadium, MacinCloud), or a macOS CI
   runner (GitHub Actions `macos-latest`, Codemagic, Bitrise).
2. **Apple Developer Program membership** — $99/year. TestFlight is not available on a free account.

Everything else is already prepared in this repo: the Xcode project, the Capacitor config, and the
`Info.plist` permission strings.

### Build

```bash
IOS_SERVER_URL=https://your-deployed-server.com npm run build:native
npx cap sync ios
npx cap open ios
```

The build refuses to run without `IOS_SERVER_URL`, and refuses anything that is not `https://` —
both produce an app that installs, opens, and then fails to connect to anything.

Then in Xcode: set your Team under Signing & Capabilities, pick "Any iOS Device", Product → Archive,
and Distribute App → TestFlight.

### Read this before you pay the $99

This app category draws real scrutiny, and two guidelines apply directly:

**Guideline 4.2, Minimum Functionality.** An app that is mainly a web view of a website gets
rejected. `build:native` already makes the app itself the launch screen rather than the marketing
page, which helps, but a wrapper is still a wrapper. Adding genuinely native behaviour — push
notifications, CallKit integration, background audio — is what moves this from "repackaged website"
to "app".

**Guideline 1.2, User-Generated Content.** Anonymous random chat is explicitly named. Apple requires
four things, and Wavelength already has all four: content filtering (`src/moderation.js`), a
reporting mechanism, the ability to block abusive users, and published contact information. Keep
them working and visible; they are the reason this has a chance of passing.

Expect a **17+ age rating**, and expect the age gate and moderation to be tested during review.

### The tester limit that actually matters

- **Internal testing** — up to 100 testers, **no Beta App Review**, builds available in minutes. But
  every tester must be added as a user on your App Store Connect team, which means each friend needs
  an Apple ID you invite to your account.
- **External testing** — up to 10,000 testers via a public link, but the first build requires **Beta
  App Review**, where the guidelines above get applied.

If the goal is "a few friends try it", internal testing is the fast lane. If it is "share a link
around", you are back to Path A, which does that today with no review at all.

---

## Recommendation

Do Path A now. Your friends can use it this evening, from their phones, without installing anything.

Path B is worth it when you want something Safari cannot give you — push notifications when a friend
comes online, or calls that survive locking the screen. Until then TestFlight adds a Mac, $99/year,
and an App Review queue without changing what your friends can actually do.
