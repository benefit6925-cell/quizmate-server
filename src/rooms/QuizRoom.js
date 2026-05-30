const { Room } = require('colyseus');

const MAX_PLAYERS = 50;

class QuizRoom extends Room {

  onCreate(options) {
    this.pin = options.pin;
    this.hostName = options.hostName;
    this.settings = options.settings || {};
    this.players = {};
    this.customQuestions = [];
    this.status = 'lobby';
    this.activeQuestions = [];
    this.startTime = null;

    this.onMessage('startGame', (client, data) => {
      if (client.sessionId !== this.hostSessionId) return;
      this.startGame(data.questions);
    });

    this.onMessage('submitAnswer', (client, data) => {
      this.handleAnswer(client.sessionId, data);
    });

    this.onMessage('endGame', (client) => {
      if (client.sessionId !== this.hostSessionId) return;
      this.status = 'ended';
      this.broadcast('gameEnded', {});
    });

    this.onMessage('updateSettings', (client, data) => {
      if (client.sessionId !== this.hostSessionId) return;
      this.settings = data.settings;
      this.broadcast('settingsUpdated', { settings: this.settings });
    });

    this.onMessage('nextRound', (client, data) => {
      if (client.sessionId !== this.hostSessionId) return;
      this.resetForNextRound(data.settings);
    });

    this.onMessage('addQuestion', (client, data) => {
      if (client.sessionId !== this.hostSessionId) return;
      this.customQuestions.push(data.question);
      this.broadcast('questionsUpdated', { questions: this.customQuestions });
    });

    this.onMessage('playerFinished', (client, data) => {
      const player = this.players[client.sessionId];
      if (!player) return;
      player.finished = true;
      player.finishedAt = Date.now();
      this.broadcast('playersUpdated', { players: this.players });
    });

    this.onMessage('eliminatePlayer', (client, data) => {
      const player = this.players[client.sessionId];
      if (!player) return;
      player.eliminated = true;
      this.broadcast('playersUpdated', { players: this.players });
    });
  }

  onJoin(client, options) {
    const { nickname, isHost } = options;

    if (isHost) {
      this.hostSessionId = client.sessionId;
      client.send('gameState', {
        status: this.status,
        settings: this.settings,
        players: this.players,
        customQuestions: this.customQuestions
      });
      return;
    }

    if (Object.keys(this.players).length >= MAX_PLAYERS) {
      throw new Error('Room is full');
    }

    const nickTaken = Object.values(this.players)
      .some(p => p.nickname.toLowerCase() === nickname.toLowerCase());
    if (nickTaken) throw new Error('Nickname taken');

    this.players[client.sessionId] = {
      id: client.sessionId,
      nickname,
      score: 0,
      correctCount: 0,
      answers: {},
      finished: false,
      eliminated: false,
      joinedAt: Date.now()
    };

    this.broadcast('playersUpdated', { players: this.players });

    client.send('gameState', {
      status: this.status,
      settings: this.settings,
      players: this.players,
      activeQuestions: this.activeQuestions,
      startTime: this.startTime
    });
  }

  onLeave(client, consented) {
    if (this.players[client.sessionId]) {
      this.players[client.sessionId].exited = true;
      this.broadcast('playersUpdated', { players: this.players });
    }
  }

  startGame(questions) {
    this.activeQuestions = questions;
    this.startTime = Date.now();
    this.status = 'active';
    this.broadcast('gameStarted', {
      activeQuestions: this.activeQuestions,
      startTime: this.startTime,
      settings: this.settings
    });
  }

  handleAnswer(sessionId, data) {
    const player = this.players[sessionId];
    if (!player) return;

    const { questionIndex, answer, score, correct } = data;
    player.answers[questionIndex] = answer;
    if (correct) player.correctCount++;
    player.score = score;

    const allDone = Object.values(this.players)
      .every(p => p.finished || p.eliminated || p.exited);
    if (allDone) this.broadcast('allFinished', {});

    this.broadcast('playersUpdated', { players: this.players });
  }

  resetForNextRound(newSettings) {
    this.settings = newSettings || this.settings;
    this.status = 'lobby';
    this.activeQuestions = [];
    this.startTime = null;
    Object.values(this.players).forEach(p => {
      p.score = 0;
      p.correctCount = 0;
      p.answers = {};
      p.finished = false;
      p.eliminated = false;
      p.finishedAt = null;
    });
    this.broadcast('roundReset', {
      settings: this.settings,
      players: this.players
    });
  }

  onDispose() {
    console.log('Room disposed:', this.pin);
  }
}

module.exports = { QuizRoom };