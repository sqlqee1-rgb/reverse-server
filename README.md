# Reverse duel server

Realtime 1v1 server for the Reverse puzzle game: duels, ranked matchmaking, leagues, seasons, world and country leaderboards. Node 18+.

- `GET /` — the game as a web app (iPhone: Safari → Share → Add to Home Screen)
- `GET /privacy` — privacy policy, `GET|POST /delete-account` — account deletion with the transfer code
- `GET /healthz` — status JSON
- `WS /ws` — game protocol v2 (hello → queue {mode: ranked|casual} / bot / room_create / room_join → start → move/ack …, top, profile, set_name …)

Server-authoritative: every move is replayed with `logic.js` (the same file the game uses). Ratings: `rank.js` (shared with the game). Social: `social.js` — friends, presence, duel invitations, world chat, private messages, reports and the owner's moderation chat. Bots: `bots.js` — 60 ranked bot accounts that take the game when nobody else is searching and play each other in the background. Storage: `store.js` — Postgres when `DATABASE_URL` is set, in-memory otherwise.

Env: `DATABASE_URL` (Render Postgres, Internal URL), `ADMIN_KEY` (owner code, casual games only).

```
npm install
npm test     # plays casual and ranked matches over real sockets
npm start    # PORT env, default 8080
```
