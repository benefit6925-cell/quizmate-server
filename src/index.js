// ══════════════════════════════════════════════════════════════
// index.js  —  QuizMate Server Entry Point
// ══════════════════════════════════════════════════════════════

const { Server }           = require('colyseus');
const { WebSocketTransport }= require('@colyseus/ws-transport');
const { createServer }     = require('http');
const express              = require('express');
const { QuizRoom }         = require('./rooms/QuizRoom');

const app  = express();
const port = process.env.PORT || 2567;

const ALLOWED_ORIGINS = [
  'https://benefit6925-cell.github.io',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.send('OK'));

// ── Room listing (debug) ──────────────────────────────────────
app.get('/rooms', (_req, res) => {
  try {
    const rooms = gameServer.matchMaker
      ? Object.values(gameServer.matchMaker.rooms || {}).map(r => ({
          roomId:  r.roomId,
          clients: r.clients ? r.clients.length : 0,
          phase:   r.state ? r.state.phase : 'unknown',
        }))
      : [];
    res.json({ rooms });
  } catch (e) {
    res.json({ rooms: [] });
  }
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    pingInterval: 10000,  // ping every 10s — keeps mobile/cellular connections alive
    pingMaxRetries: 5,    // drop after 5 missed pongs (~50s silence = truly dead); 3 was too aggressive for Nigerian mobile networks
    verifyClient: (info, next) => {
      const origin = info.req.headers.origin || '';
      const ok     = !origin || ALLOWED_ORIGINS.includes(origin);
      next(ok, 403, 'Forbidden');
    },
  }),
});

// ── Room definitions ──────────────────────────────────────────
gameServer.define('quiz_room', QuizRoom, {
  filterBy: ['roomId'],
});

httpServer.listen(port, () => {
  console.log(`QuizMate server running on port ${port}`);
});
