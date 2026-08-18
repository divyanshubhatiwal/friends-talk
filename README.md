# Wavelength

Anonymous **voice-first random chat**. One tap matches you with a stranger by voice — no camera,
no profile, no account. Text chat is included and can be upgraded to a voice call mid-conversation.

This is a complete, self-hosted implementation: marketing site, chat application, signaling server,
matchmaking, moderation, and legal page templates.

## Run it

```bash
npm install
npm start
```

Open <http://localhost:3000>.

To try a real call, open the app in **two different browsers** (or one normal window and one private
window) — two tabs of the same browser share a microphone and will fight over it.

## Database

Storage is MongoDB, pointed at an Atlas cluster via `MONGODB_URI` in `.env` (copy `.env.example`).
The database name is separate from anything else on the cluster, so collections never collide.

**If the database is unreachable the server still starts** and falls back to in-memory storage —
a dead cluster degrades the service rather than stopping it. The boot log says which mode is live:

```
Storage: connected to mongodb+srv://cluster0.xxxxx.mongodb.net/wavelength
Storage: database unavailable (…). Falling back to in-memory storage…
```

| Collection | Holds | Retention |
|---|---|---|
| `blocks` | who blocked whom | permanent |
| `friendships` | mutual friend links | 3 months after last activity |
| `friendMessages` | messages between friends | 2 weeks |
| `calls` | call **metadata** — participants, countries, duration | 1 month |
| `reports` | user and automatic moderation reports | 1 month |
| `bans` | suspensions, with their own expiry | until expiry |

Retention is enforced by **TTL indexes in the database**, not by application code that might never
run. The periods above are the ones published on `/privacy` — changing one means changing that page.

Nothing here stores conversation content. `calls` holds who was connected and for how long; audio is
peer-to-peer and never reaches the server, and random text messages are relayed in memory only.

Blocks are loaded from the database on connect and merged with whatever the device sent, so a block
survives clearing local storage or switching browsers. Five reports against one client within 24
hours triggers an automatic 24-hour suspension.

## Architecture

```
browser A ──┐                                    ┌── browser B
            │  socket.io: matchmaking + signaling │
            └──────────►  Node server  ◄──────────┘
                              │
            audio does NOT flow through here
            ▼
browser A ◄══════ WebRTC peer connection ══════► browser B
```

| Piece | File | What it does |
|---|---|---|
| HTTP + sockets | `server.js` | Serves the site, relays signaling, enforces the age gate |
| Matching | `src/matchmaker.js` | Scores every waiting peer; prefers shared interests, avoids rematches |
| Rooms & game | `src/rooms.js` | Live room registry and the tic-tac-toe state machine |
| Moderation | `src/moderation.js` | Screens text and images before delivery |
| Names | `src/names.js` | Throwaway two-word display names |
| Storage | `src/storage/mongo.js` | Connection, TTL indexes, never logs the URI |
| Data API | `src/storage/repository.js` | Blocks, friends, calls, reports, bans — with memory fallback |
| Client | `public/js/app.js` | WebRTC, pitch analysis, visualiser, all UI |

## Features

- Random **voice** matching over WebRTC (peer-to-peer audio, never recorded)
- Random **text** matching, with a both-sides-agree upgrade to voice
- Country filter (multi-select) and interest-tag matching
- Live microphone visualiser and call timer
- In-call chat, image sharing (screened), typing indicator
- In-call tic-tac-toe
- Mute · Next · Add friend · Report · Block (blocks persist per device)
- Call history — last five conversations
- Auto-call the next person
- Premium gender preference filter, estimated **in the browser** from voice pitch
- 18+ age gate, live online counter, responsive down to mobile

## Configuration

All optional — the server runs with none of it set.

| Variable | Purpose |
|---|---|
| `MONGODB_URI` | Connection string. Falls back to in-memory storage if unreachable |
| `MONGODB_DB` | Database name (default `wavelength`) |
| `MODERATION_TOKEN` | Bearer token for `GET /api/moderation/reports`; unset means the route 404s |
| `PORT` | HTTP port (default `3000`) |
| `TURN_URL` | TURN server URL, e.g. `turn:turn.example.com:3478` |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | TURN credentials |
| `OPENAI_API_KEY` | Enables image moderation via the OpenAI moderation endpoint |

```bash
PORT=8080 TURN_URL=turn:turn.example.com:3478 npm start
```

## Before running this publicly

1. **HTTPS is mandatory.** `getUserMedia` only works on `localhost` or a secure origin. Put this behind
   a TLS-terminating proxy.
2. **Add a TURN server.** STUN alone fails for roughly 10–20% of users behind strict NATs. `coturn` is
   the standard choice.
3. **Allowlist your server's IP in Atlas.** Network access there is per-IP; a deploy from a new host
   fails to connect and silently drops to in-memory storage. Watch the boot log after every deploy.
4. **Add rate limiting** on `find`, `chat`, and `image` — the current build trusts clients on volume.
5. **Fill in the legal pages.** `terms.html` and `privacy.html` are templates with placeholders for the
   operating entity and jurisdiction. Have a lawyer review them.
6. **Peer-to-peer means IP exposure** between participants. This is disclosed in the age gate and FAQ;
   keep it disclosed.
7. **Moderation is a starting point.** The text filter is regex-based. For production, add a real
   classifier and a human review queue.

## License

Yours to do with as you like.
