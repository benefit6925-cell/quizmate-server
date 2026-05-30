const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { createServer } = require('http');
const express = require('express');
const { QuizRoom } = require('./rooms/QuizRoom');

const app = express();
const port = process.env.PORT || 2567;

// ── CORS: allow your GitHub Pages frontend (and local dev) to connect ──
app.use((req, res, next) => {
  const allowed = [
    'https://benefit6925-cell.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ];
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// ── Health check for UptimeRobot / Render ──
app.get('/health', (req, res) => res.send('OK'));

// ── Optional: room listing endpoint (useful for debugging) ──
app.get('/rooms', (req, res) => {
  try {
    const rooms = gameServer.matchMaker
      ? Object.values(gameServer.matchMaker.rooms || {}).map(r => ({
          roomId: r.roomId,
          clients: r.clients ? r.clients.length : 0,
          status: r.status || 'unknown'
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
    // FIX: Allow WebSocket connections from the frontend origin
    verifyClient: (info, next) => {
      const origin = info.req.headers.origin || '';
      const allowed = [
        'https://benefit6925-cell.github.io',
        'http://localhost:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
      ];
      // Allow if origin matches, or if no origin header (e.g. direct tool connections)
      const ok = !origin || allowed.includes(origin);
      next(ok, 403, 'Forbidden');
    }
  })
});

// ── Room definitions ──
gameServer.define('quiz_room', QuizRoom, {
  filterBy: ['roomId'] // Colyseus uses roomId to look up existing rooms by PIN
});

httpServer.listen(port, () => {
  console.log(`QuizMate server running on port ${port}`);
});
