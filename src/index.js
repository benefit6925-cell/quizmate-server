const { Server } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { createServer } = require('http');
const express = require('express');
const { QuizRoom } = require('./rooms/QuizRoom');

const app = express();
const port = process.env.PORT || 2567;

// Health check for UptimeRobot
app.get('/health', (req, res) => res.send('OK'));

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer })
});

gameServer.define('quiz_room', QuizRoom);

httpServer.listen(port, () => {
  console.log(`QuizMate server running on port ${port}`);
});