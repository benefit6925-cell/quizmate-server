const { Room } = require('colyseus');

const MAX_PLAYERS = 50;

class QuizRoom extends Room {

  onCreate(options) {
    this.maxClients = MAX_PLAYERS;
    this.hostSessionId = null;
    this.customQuestions = [];
    this.activeQuestions = [];
    this.status = 'lobby';
    this.startTime = null;
    this.globalEndTime = null;
    this.settings = options.settings || {};
    this.players = {};
    this.gameEndTimer = null;
    this.blitzRound = null;
    this.blitzTeamCountA = 0;
    this.blitzTeamCountB = 0;

    if (options.pin) this.roomId = options.pin.toUpperCase();

    this._registerHandlers();
    console.log(`[QuizRoom] Created: ${this.roomId}`);
  }

  _registerHandlers() {

    this.onMessage('startGame', (client, data) => {
      if (!this._isHost(client)) return;
      this.settings = data.settings || this.settings;
      this.activeQuestions = data.questions || [];
      this.startTime = data.startTime || Date.now();
      this.globalEndTime = data.globalEndTime || null;
      this.status = 'active';
      this.blitzRound = null;

      // Reset scores but keep host out of player list
      Object.values(this.players).forEach(p => {
        if (p.isHost) return;
        p.score = 0; p.correctCount = 0; p.finished = false;
        p.eliminated = false; p.finishedAt = 0; p.blitzCorrectCount = 0;
        p.answers = {};
      });

      this.broadcast('gameStarted', {
        activeQuestions: this.activeQuestions,
        startTime: this.startTime,
        globalEndTime: this.globalEndTime,
        settings: this.settings
      });

      this._clearTimers();
      const mode = this.settings.gameMode || 'classic';
      if (mode === 'classic' || mode === 'survival') {
        const dur = (this.settings.timerDuration || 120) * 1000;
        this.gameEndTimer = setTimeout(() => this._serverEndGame(), dur);
      } else if (mode === 'lightning' && this.globalEndTime) {
        const remaining = Math.max(0, this.globalEndTime - Date.now());
        this.gameEndTimer = setTimeout(() => this._serverEndGame(), remaining);
      }
    });

    this.onMessage('endGame', (client) => {
      if (!this._isHost(client)) return;
      this._serverEndGame();
    });

    this.onMessage('resetGame', (client) => {
      if (!this._isHost(client)) return;
      this._resetRoom(this.settings);
    });

    this.onMessage('nextRound', (client, data) => {
      if (!this._isHost(client)) return;
      this._resetRoom(data.settings || this.settings);
    });

    this.onMessage('updateSettings', (client, data) => {
      if (!this._isHost(client)) return;
      this.settings = data.settings || this.settings;
      this.broadcast('settingsUpdated', { settings: this.settings });
    });

    this.onMessage('submitAnswer', (client, data) => {
      const p = this.players[client.sessionId];
      if (!p || p.isHost) return;
      p.answers = p.answers || {};
      p.answers[data.questionIndex] = data.answer;
      if (data.correct) p.correctCount++;
      p.score = data.score;
      if (data.eliminated) p.eliminated = true;
      this._broadcastPlayers();
    });

    this.onMessage('playerFinished', (client, data) => {
      const p = this.players[client.sessionId];
      if (!p || p.isHost) return;
      p.score = data.score;
      p.correctCount = data.correctCount;
      p.finished = true;
      p.finishedAt = Date.now();
      this._broadcastPlayers();
      this._checkAllFinished();
    });

    this.onMessage('eliminatePlayer', (client, data) => {
      const p = this.players[client.sessionId];
      if (!p || p.isHost) return;
      p.score = data.score;
      p.correctCount = data.correctCount;
      p.eliminated = true;
      p.finishedAt = Date.now();
      this._broadcastPlayers();
      this._checkAllFinished();
    });

    this.onMessage('playerExit', (client) => {
      const p = this.players[client.sessionId];
      if (p) { p.exited = true; this._broadcastPlayers(); }
    });

    this.onMessage('blitzAnswer', (client, data) => {
      const player = this.players[client.sessionId];
      if (!player || player.isHost) return;
      const qi = data.questionIndex;

      if (!this.blitzRound || this.blitzRound.questionIndex !== qi) {
        this.blitzRound = { questionIndex: qi, answers: {}, revealSent: false };
      }

      if (!this.blitzRound.answers[client.sessionId]) {
        this.blitzRound.answers[client.sessionId] = {
          sessionId: client.sessionId,
          team: data.team || player.team || 'A',
          answer: data.answer,
          timestamp: data.timestamp
        };
      }

      const activePlayers = Object.values(this.players).filter(
        p => !p.isHost && !p.exited && !p.finished
      );
      const answered = Object.keys(this.blitzRound.answers).length;
      if (answered >= activePlayers.length && activePlayers.length > 0 && !this.blitzRound.revealSent) {
        this._sendBlitzReveal(qi);
      }
    });

    this.onMessage('blitzReaction', (client, data) => {
      this.clients.forEach(c => {
        if (c.sessionId === client.sessionId) return;
        const p = this.players[c.sessionId];
        if (p && p.team === data.team) {
          c.send('blitzReaction', { emoji: data.emoji, team: data.team });
        }
      });
    });

    this.onMessage('blitzSignal', (client, data) => {
      this.clients.forEach(c => {
        if (c.sessionId === client.sessionId) return;
        const p = this.players[c.sessionId];
        if (p && p.team === data.team) {
          c.send('blitzSignal', { text: data.text, nickname: data.nickname, team: data.team });
        }
      });
    });

    this.onMessage('updateBlitzScore', (client, data) => {
      const p = this.players[client.sessionId];
      if (!p || p.isHost) return;
      p.score = data.score;
      p.blitzCorrectCount = data.blitzCorrectCount;
      this._broadcastPlayers();
    });

    this.onMessage('blitzFinished', (client, data) => {
      const p = this.players[client.sessionId];
      if (!p || p.isHost) return;
      p.score = data.score;
      p.blitzCorrectCount = data.blitzCorrectCount;
      p.team = data.blitzTeam;
      p.teamScoreA = data.teamScoreA;
      p.teamScoreB = data.teamScoreB;
      p.finished = true;
      p.finishedAt = Date.now();
      this._broadcastPlayers();
    });

    this.onMessage('addQuestion', (client, data) => {
      if (!this._isHost(client)) return;
      this.customQuestions.push(data.question);
      this.broadcast('questionsUpdated', { questions: this.customQuestions });
    });

    this.onMessage('updateQuestion', (client, data) => {
      if (!this._isHost(client)) return;
      const idx = this.customQuestions.findIndex(q => q.id === data.question.id);
      if (idx !== -1) this.customQuestions[idx] = data.question;
      this.broadcast('questionsUpdated', { questions: this.customQuestions });
    });

    this.onMessage('deleteQuestion', (client, data) => {
      if (!this._isHost(client)) return;
      this.customQuestions = this.customQuestions.filter(q => q.id !== data.id);
      this.broadcast('questionsUpdated', { questions: this.customQuestions });
    });

    this.onMessage('clearQuestions', (client) => {
      if (!this._isHost(client)) return;
      this.customQuestions = [];
      this.broadcast('questionsUpdated', { questions: [] });
    });

    this.onMessage('selectTeam', (client, data) => {
      const p = this.players[client.sessionId];
      if (!p) return;
      const old = p.team;
      p.team = data.team;
      if (old === 'A') this.blitzTeamCountA = Math.max(0, this.blitzTeamCountA - 1);
      if (old === 'B') this.blitzTeamCountB = Math.max(0, this.blitzTeamCountB - 1);
      if (data.team === 'A') this.blitzTeamCountA++;
      if (data.team === 'B') this.blitzTeamCountB++;
      this._broadcastPlayers();
    });
  }

  onJoin(client, options) {
    const isHost = !!options.isHost;
    const isReconnect = !!options.reconnect;

    if (isHost) {
      // Host does NOT get added to players list — host is separate
      this.hostSessionId = client.sessionId;
      client.send('joinAck', {
        status: this.status,
        settings: this.settings,
        gameMode: this.settings.gameMode || 'classic',
        questions: this.customQuestions
      });
      // Send current players to host
      this._broadcastPlayers();
      console.log(`[QuizRoom] Host joined: ${this.roomId}`);
      return;
    }

    const nick = (options.nickname || 'Player').slice(0, 24);

    // Check nickname taken
    if (!isReconnect) {
      const taken = Object.values(this.players).some(
        p => !p.exited && p.nickname.toLowerCase() === nick.toLowerCase()
      );
      if (taken) {
        client.send('joinError', { message: `❌ Nickname "${nick}" is already taken.` });
        return;
      }
    }

    // Restore or create player
    let player = this.players[client.sessionId];
    if (!player) {
      let team = '';
      if ((this.settings.gameMode || 'classic') === 'blitz') {
        team = this.blitzTeamCountA <= this.blitzTeamCountB ? 'A' : 'B';
        if (team === 'A') this.blitzTeamCountA++; else this.blitzTeamCountB++;
      }
      player = {
        id: client.sessionId, nickname: nick, isHost: false,
        score: 0, correctCount: 0, finished: false, eliminated: false,
        finishedAt: 0, exited: false, team,
        blitzCorrectCount: 0, answers: {}
      };
      this.players[client.sessionId] = player;
    }

    if (this.status === 'active') {
      client.send('joinAck', {
        status: 'active', waiting: true,
        settings: this.settings,
        eliminated: player.eliminated,
        finished: player.finished,
        score: player.score,
        correctCount: player.correctCount,
        gameMode: this.settings.gameMode,
        team: player.team,
        teamAName: this.settings.teamAName,
        teamBName: this.settings.teamBName,
        activeQuestions: this.activeQuestions,
        startTime: this.startTime
      });
    } else {
      client.send('joinAck', {
        status: 'lobby',
        settings: this.settings,
        gameMode: this.settings.gameMode || 'classic',
        assignedTeam: player.team,
        teamAName: this.settings.teamAName || 'Team A',
        teamBName: this.settings.teamBName || 'Team B',
        countA: this.blitzTeamCountA,
        countB: this.blitzTeamCountB
      });
    }

    this.allowReconnection(client, 60);
    this._broadcastPlayers();
    console.log(`[QuizRoom] ${nick} joined ${this.roomId}`);
  }

  onLeave(client, consented) {
    if (client.sessionId === this.hostSessionId) return;
    this._broadcastPlayers();
  }

  onDispose() {
    this._clearTimers();
    console.log(`[QuizRoom] Disposed: ${this.roomId}`);
  }

  _isHost(client) {
    return client.sessionId === this.hostSessionId;
  }

  _broadcastPlayers() {
    // Only send actual players, never the host
    const playersOnly = {};
    Object.entries(this.players).forEach(([id, p]) => {
      if (!p.isHost) playersOnly[id] = p;
    });
    this.broadcast('playersUpdated', { players: playersOnly });
  }

  _checkAllFinished() {
    if (this.status !== 'active') return;
    const active = Object.values(this.players).filter(p => !p.isHost && !p.exited);
    if (active.length > 0 && active.every(p => p.finished || p.eliminated)) {
      this.broadcast('allFinished', {});
    }
  }

  _serverEndGame() {
    this._clearTimers();
    if (this.status === 'ended') return;
    this.status = 'ended';
    this.broadcast('gameEnded', {});
    console.log(`[QuizRoom] Game ended: ${this.roomId}`);
  }

  _resetRoom(newSettings) {
    this._clearTimers();
    this.status = 'lobby';
    this.activeQuestions = [];
    this.startTime = null;
    this.globalEndTime = null;
    this.blitzRound = null;
    this.blitzTeamCountA = 0;
    this.blitzTeamCountB = 0;
    if (newSettings) this.settings = newSettings;

    Object.values(this.players).forEach(p => {
      if (p.isHost) return;
      p.score = 0; p.correctCount = 0; p.finished = false;
      p.eliminated = false; p.finishedAt = 0; p.exited = false;
      p.blitzCorrectCount = 0; p.team = ''; p.answers = {};
    });

    const playersOnly = {};
    Object.entries(this.players).forEach(([id, p]) => {
      if (!p.isHost) playersOnly[id] = p;
    });

    this.broadcast('roundReset', { settings: this.settings, players: playersOnly });
    console.log(`[QuizRoom] Reset: ${this.roomId}`);
  }

  _clearTimers() {
    if (this.gameEndTimer) { clearTimeout(this.gameEndTimer); this.gameEndTimer = null; }
    if (this.blitzRound && this.blitzRound.revealTimer) {
      clearTimeout(this.blitzRound.revealTimer);
    }
  }

  _sendBlitzReveal(questionIndex) {
    if (!this.blitzRound || this.blitzRound.revealSent) return;
    this.blitzRound.revealSent = true;
    if (this.blitzRound.revealTimer) clearTimeout(this.blitzRound.revealTimer);

    const q = this.activeQuestions[questionIndex];
    if (!q) return;

    const answers = Object.values(this.blitzRound.answers);
    const aAnswers = answers.filter(a => a.team === 'A');
    const bAnswers = answers.filter(a => a.team === 'B');

    const majority = (teamAnswers) => {
      if (!teamAnswers.length) return { vote: -1, perfect: false, deadlock: false, votes: {} };
      const tally = {};
      teamAnswers.forEach(a => { tally[a.answer] = (tally[a.answer] || 0) + 1; });
      const maxCount = Math.max(...Object.values(tally));
      const top = Object.keys(tally).filter(k => tally[k] === maxCount).map(Number);
      if (top.length > 1) return { vote: -1, perfect: false, deadlock: true, votes: tally };
      const vote = top[0];
      const perfect = teamAnswers.every(a => a.answer === q.answer);
      return { vote, perfect, deadlock: false, votes: tally };
    };

    const aRes = majority(aAnswers);
    const bRes = majority(bAnswers);
    const correct = q.answer;

    const aWin = !aRes.deadlock && aRes.vote === correct;
    const bWin = !bRes.deadlock && bRes.vote === correct;
    const aPoints = aRes.deadlock ? 0 : aRes.perfect ? 25 : aWin ? 10 : 0;
    const bPoints = bRes.deadlock ? 0 : bRes.perfect ? 25 : bWin ? 10 : 0;

    this.broadcast('blitzReveal', {
      q: questionIndex,
      questionText: q.q,
      correctAnswer: correct,
      aVote: aRes.vote, aVotes: aRes.votes, aDeadlock: aRes.deadlock,
      aPerfect: aRes.perfect, aPoints,
      bVote: bRes.vote, bVotes: bRes.votes, bDeadlock: bRes.deadlock,
      bPerfect: bRes.perfect, bPoints
    });
  }
}

module.exports = { QuizRoom };
