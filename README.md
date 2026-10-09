# Reverse duel server

Realtime 1v1 server for the Reverse puzzle game. Node 18+, one dependency (`ws`).

- `GET /healthz` — status JSON
- `WS /ws` — game protocol (hello → queue / bot / room_create / room_join → start → move/ack …)

Server-authoritative: every move is replayed with `logic.js` (the same file the game uses), clients predict locally and are corrected on hash mismatch.

```
npm install
npm test     # spins up the server and plays matches over real sockets
npm start    # PORT env, default 8080
```

Deploy: Render → New → Blueprint → this repo (`render.yaml`, Singapore, free plan).
