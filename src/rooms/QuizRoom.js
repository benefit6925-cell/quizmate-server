// ══════════════════════════════════════════════════════════════
// QuizRoom.js  —  Colyseus Room (State-Driven Architecture)
//
// ARCHITECTURE PRINCIPLES:
//   1. this.state (QuizRoomState) is the single source of truth.
//   2. Server owns ALL phase transitions, timers, and scoring.
//   3. Clients NEVER drive game progression — they only submit
//      answers and receive state patches.
//   4. room.onMessage() is used ONLY for:
//        - join acknowledgements / errors
//        - one-time notifications (confetti, toasts)
//        - answer submission (client → server)
//        - host commands (start, end, next round)
//   5. Player list sync is via MapSchema patches — zero
//      playersUpdated broadcasts for live score/status changes.
//
// PHASE MACHINE (server-authoritative):
//   lobby → countdown → question → answer_reveal
//   → question (loop) → results → waiting_next_round → lobby
//
// PERFORMANCE TARGET: 100–500 concurrent players
// ══════════════════════════════════════════════════════════════

const { Room }        = require('colyseus');
const { QuizRoomState, PlayerState, GameSettingsState } = require('./schema/QuizRoomState');

const MAX_PLAYERS         = 500;
const COUNTDOWN_DURATION  = 3;    // seconds before first question
const REVEAL_DURATION     = 4;    // seconds to show answer reveal
const RESULTS_DELAY       = 600;  // ms before showing results page
const RECONNECT_WINDOW    = 120;  // seconds a disconnected player can rejoin

class QuizRoom extends Room {

  // ════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════

  onCreate(options) {
    this.maxClients     = MAX_PLAYERS;
    this.setState(new QuizRoomState());

    // Non-schema server-side fields (not synced to clients)
    this.hostSessionId      = null;
    this.customQuestions    = [];
    this.activeQuestions    = [];
    this.blitzRound         = null;

    // Timer handles
    this._phaseTimer        = null;
    this._tickInterval      = null;
    this._blitzRevealTimer  = null;

    if (options.pin) this.roomId = options.pin.toUpperCase();

    // Apply initial settings if provided
    if (options.settings) this._applySettings(options.settings);

    this._registerHandlers();
    console.log(`[QuizRoom] Created: ${this.roomId}`);
  }

  onJoin(client, options) {
    const isHost      = !!options.isHost;
    const isReconnect = !!options.reconnect;
    const nick        = (options.nickname || 'Player').slice(0, 24);

    // ── Host join ──
    if (isHost) {
      this.hostSessionId = client.sessionId;

      // Host gets a PlayerState in the schema (isHost=true) so
      // admin dashboard can read room state via the same schema path.
      if (!this.state.players.get(client.sessionId)) {
        const hp = new PlayerState();
        hp.nickname = 'Host';
        hp.isHost   = true;
        this.state.players.set(client.sessionId, hp);
      }

      client.send('joinAck', {
        status:    this.state.phase,
        settings:  this._getSettingsPlain(),
        gameMode:  this.state.settings.gameMode,
        questions: this.customQuestions
      });

      console.log(`[QuizRoom] Host joined: ${this.roomId}`);
      return;
    }

    // ── Nickname uniqueness check (new joins only) ──
    if (!isReconnect) {
      const taken = [...this.state.players.values()].some(
        p => !p.isHost && !p.exited &&
             p.nickname.toLowerCase() === nick.toLowerCase()
      );
      if (taken) {
        client.send('joinError', { message: `❌ Nickname "${nick}" is already taken.` });
        return;
      }
    }

    // ── Restore or create PlayerState ──
    let player = this.state.players.get(client.sessionId);
    if (!player) {
      player = new PlayerState();
      player.nickname = nick;
      player.isHost   = false;

      // Auto-assign blitz team for balance
      if (this.state.settings.gameMode === 'blitz') {
        player.team = this.state.blitzTeamCountA <= this.state.blitzTeamCountB ? 'A' : 'B';
        if (player.team === 'A') this.state.blitzTeamCountA++;
        else                     this.state.blitzTeamCountB++;
      }

      this.state.players.set(client.sessionId, player);
    } else {
      // Reconnecting — just clear the exited flag
      player.exited = false;
    }

    // Allow client to reconnect within the window if they disconnect
    this.allowReconnection(client, RECONNECT_WINDOW);

    // ── Send acknowledgement ──
    // The client will also receive the full state patch automatically
    // via Colyseus state sync — the ack just tells it which page to show.
    const ackBase = {
      settings:     this._getSettingsPlain(),
      gameMode:     this.state.settings.gameMode,
      assignedTeam: player.team,
      teamAName:    this.state.settings.teamAName,
      teamBName:    this.state.settings.teamBName,
      countA:       this.state.blitzTeamCountA,
      countB:       this.state.blitzTeamCountB,
      score:        player.score,
      correctCount: player.correctCount,
      eliminated:   player.eliminated,
      finished:     player.finished,
      teamScoreA:   this.state.teamScoreA,
      teamScoreB:   this.state.teamScoreB,
    };

    if (this.state.phase === 'lobby' || this.state.phase === 'waiting_next_round') {
      client.send('joinAck', { ...ackBase, status: 'lobby' });

    } else if (this.state.phase !== 'lobby') {
      // Joined mid-game — send to waiting room
      // They'll see live leaderboard via schema patches
      client.send('joinAck', {
        ...ackBase,
        status:          'active',
        waiting:         true,
        activeQuestions: this.activeQuestions,
        startTime:       this.state.questionStartedAt,
        globalEndTime:   this._globalEndTime || null,
      });
    }

    console.log(`[QuizRoom] ${nick} joined ${this.roomId} (reconnect=${isReconnect})`);
  }

  onLeave(client, consented) {
    // Host leaving is handled gracefully — room persists until disposed
    if (client.sessionId === this.hostSessionId) return;

    const player = this.state.players.get(client.sessionId);
    if (player) {
      // Mark as disconnected but don't remove — reconnect window active
      // Schema patch fires automatically; client sees them as "offline"
      player.exited = !consented ? false : true; // keep alive for reconnect if unexpected
    }
  }

  onDispose() {
    this._clearAllTimers();
    console.log(`[QuizRoom] Disposed: ${this.roomId}`);
  }

  // ════════════════════════════════════════
  // MESSAGE HANDLERS
  // Only used for commands and one-time events.
  // State sync is via schema patches.
  // ════════════════════════════════════════

  _registerHandlers() {

    // ── HOST: Start game ──
    this.onMessage('startGame', (client, data) => {
      if (!this._isHost(client)) return;

      this.activeQuestions = data.questions || [];
      if (!this.activeQuestions.length) {
        client.send('hostError', { message: 'No questions loaded.' });
        return;
      }

      this._applySettings(data.settings || {});

      // Reset all player scores
      this.state.players.forEach((p) => {
        if (p.isHost) return;
        p.score             = 0;
        p.correctCount      = 0;
        p.finished          = false;
        p.eliminated        = false;
        p.alive             = true;
        p.finishedAt        = 0;
        p.blitzCorrectCount = 0;
        p.answeredIndex     = -1;
      });

      // Reset team scores
      this.state.teamScoreA    = 0;
      this.state.teamScoreB    = 0;
      this.state.inSuddenDeath = false;
      this.state.roundNumber++;

      // Re-balance blitz teams
      if (this.state.settings.gameMode === 'blitz') {
        this.state.blitzTeamCountA = 0;
        this.state.blitzTeamCountB = 0;
        this.state.players.forEach((p) => {
          if (p.isHost || p.exited) return;
          if (!p.team) {
            p.team = this.state.blitzTeamCountA <= this.state.blitzTeamCountB ? 'A' : 'B';
          }
          if (p.team === 'A') this.state.blitzTeamCountA++;
          else                this.state.blitzTeamCountB++;
        });
      }

      // Calculate server-authoritative start time and global end time
      const COUNTDOWN_MS = COUNTDOWN_DURATION * 1000 + 800; // countdown + buffer
      const startTime = Date.now() + COUNTDOWN_MS;
      const mode = this.state.settings.gameMode;
      this._globalEndTime = (mode === 'lightning')
        ? startTime + (this.state.settings.timerDuration * 1000)
        : null;

      // Broadcast the questions + timing (one-time; phase machine drives everything else)
      this.broadcast('gameStarted', {
        activeQuestions: this.activeQuestions,
        startTime,
        globalEndTime:   this._globalEndTime,
        settings:        this._getSettingsPlain(),
      });

      // Kick off phase machine
      this._startCountdown();
    });

    // ── HOST: End game ──
    this.onMessage('endGame', (client) => {
      if (!this._isHost(client)) return;
      this._endGame();
    });

    // ── HOST: Next round ──
    this.onMessage('nextRound', (client, data) => {
      if (!this._isHost(client)) return;
      this._resetRoom(data.settings || this._getSettingsPlain());
    });

    // ── HOST: Reset ──
    this.onMessage('resetGame', (client) => {
      if (!this._isHost(client)) return;
      this._resetRoom(this._getSettingsPlain());
    });

    // ── HOST: Update settings ──
    this.onMessage('updateSettings', (client, data) => {
      if (!this._isHost(client)) return;
      this._applySettings(data.settings || {});
      // Settings are now in schema — clients receive the patch automatically.
      // Send explicit message only so host UI can react immediately.
      client.send('settingsUpdated', { settings: this._getSettingsPlain() });
    });

    // ── PLAYER: Submit answer ──
    // Server validates: one answer per player per question.
    // Scoring is computed here — client score is IGNORED.
    this.onMessage('submitAnswer', (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isHost || player.eliminated || player.finished) return;

      const qi = data.questionIndex;

      // ── Duplicate submission guard ──
      // answeredIndex is stored in schema so reconnecting clients
      // can't resubmit questions they already answered.
      if (player.answeredIndex >= qi) return;
      player.answeredIndex = qi;

      const q = this.activeQuestions[qi];
      if (!q) return;

      const correct  = data.answer === q.answer;
      const mode     = this.state.settings.gameMode;
      const scoring  = this.state.settings.scoringMode;
      const timeSpent = (Date.now() - this.state.questionStartedAt) / 1000;

      // ── Server-side scoring ──
      if (correct) {
        player.correctCount++;
        let points = 1;
        if (mode === 'lightning') {
          points = timeSpent <= 5 ? 3 : timeSpent <= 10 ? 2 : 1;
        } else if (scoring === 'speed') {
          points = timeSpent <= 3 ? 3 : timeSpent <= 8 ? 2 : 1;
        }
        player.score += points;
      }

      // ── Survival: wrong answer = elimination ──
      if (mode === 'survival' && !correct) {
        player.eliminated = true;
        player.alive      = false;
        player.finishedAt = Date.now();
        // Schema patch fires automatically — spectators see it instantly
        this._checkAllFinished();
        return;
      }

      // Schema patch fires automatically — no broadcast needed
      this._checkAllFinished();
    });

    // ── PLAYER: Finished all questions ──
    this.onMessage('playerFinished', (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isHost || player.finished) return;

      player.finished    = true;
      player.finishedAt  = Date.now();
      // Score already computed server-side — ignore data.score

      this._checkAllFinished();
    });

    // ── PLAYER: Eliminated (survival timeout) ──
    this.onMessage('eliminatePlayer', (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isHost || player.eliminated) return;

      player.eliminated = true;
      player.alive      = false;
      player.finishedAt = Date.now();

      this._checkAllFinished();
    });

    // ── PLAYER: Exit lobby ──
    this.onMessage('playerExit', (client) => {
      const player = this.state.players.get(client.sessionId);
      if (player) player.exited = true;
    });

    // ── BLITZ: Answer submission ──
    // All vote aggregation happens server-side.
    this.onMessage('blitzAnswer', (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isHost) return;

      const qi = data.questionIndex;

      if (!this.blitzRound || this.blitzRound.questionIndex !== qi) {
        this.blitzRound = {
          questionIndex: qi,
          answers:      {},
          revealSent:   false,
        };
        // Start server-side reveal timeout for this question
        this._scheduleBlitzRevealTimeout(qi);
      }

      // One answer per player per question
      if (this.blitzRound.answers[client.sessionId]) return;

      this.blitzRound.answers[client.sessionId] = {
        sessionId: client.sessionId,
        team:      data.team || player.team || 'A',
        answer:    data.answer,
        timestamp: data.timestamp,
      };

      // Check if all active players have answered
      const active  = [...this.state.players.values()].filter(
        p => !p.isHost && !p.exited && !p.finished
      );
      const answered = Object.keys(this.blitzRound.answers).length;

      if (answered >= active.length && active.length > 0 && !this.blitzRound.revealSent) {
        this._sendBlitzReveal(qi);
      }
    });

    // ── BLITZ: Reactions (relay to teammates only) ──
    this.onMessage('blitzReaction', (client, data) => {
      const sender = this.state.players.get(client.sessionId);
      if (!sender) return;
      this.clients.forEach(c => {
        if (c.sessionId === client.sessionId) return;
        const p = this.state.players.get(c.sessionId);
        if (p && p.team === data.team) {
          c.send('blitzReaction', { emoji: data.emoji, team: data.team });
        }
      });
    });

    // ── BLITZ: Signals (relay to teammates only) ──
    this.onMessage('blitzSignal', (client, data) => {
      const sender = this.state.players.get(client.sessionId);
      if (!sender) return;
      this.clients.forEach(c => {
        if (c.sessionId === client.sessionId) return;
        const p = this.state.players.get(c.sessionId);
        if (p && p.team === data.team) {
          c.send('blitzSignal', {
            text: data.text, nickname: data.nickname, team: data.team
          });
        }
      });
    });

    // ── QUESTIONS: CRUD (host only) ──
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

    // ── BLITZ: Team selection (fallback — auto-assign is preferred) ──
    this.onMessage('selectTeam', (client, data) => {
      const player = this.state.players.get(client.sessionId);
      if (!player) return;
      const old  = player.team;
      player.team = data.team;
      if (old === 'A')      this.state.blitzTeamCountA = Math.max(0, this.state.blitzTeamCountA - 1);
      if (old === 'B')      this.state.blitzTeamCountB = Math.max(0, this.state.blitzTeamCountB - 1);
      if (data.team === 'A') this.state.blitzTeamCountA++;
      if (data.team === 'B') this.state.blitzTeamCountB++;
      // Schema patch fires automatically
    });
  }

  // ════════════════════════════════════════
  // PHASE MACHINE  (server-authoritative)
  //
  // The server sets this.state.phase and all clients
  // receive a delta patch and react accordingly.
  // No client can set a phase directly.
  // ════════════════════════════════════════

  _setPhase(phase) {
    this.state.phase = phase;
    console.log(`[QuizRoom] ${this.roomId} → phase: ${phase}`);
  }

  _startCountdown() {
    this._clearPhaseTimer();
    this._setPhase('countdown');
    this.state.remainingTime = COUNTDOWN_DURATION;

    // Tick the countdown
    let secs = COUNTDOWN_DURATION;
    this._tickInterval = setInterval(() => {
      secs--;
      this.state.remainingTime = Math.max(0, secs);
      if (secs <= 0) {
        clearInterval(this._tickInterval);
        this._tickInterval = null;
        this._startQuestion(0);
      }
    }, 1000);
  }

  _startQuestion(index) {
    const mode = this.state.settings.gameMode;

    if (index >= this.activeQuestions.length) {
      // All questions done
      if (mode === 'blitz') return; // blitz ends via _sendBlitzReveal
      this._endGame();
      return;
    }

    this._clearPhaseTimer();
    this._clearTickInterval();

    this.state.questionIndex    = index;
    this.state.questionStartedAt = Date.now();
    this._setPhase('question');

    // ── Determine per-question timer duration ──
    let dur = 0;
    if (mode === 'lightning')  dur = 8;
    else if (mode === 'survival') dur = this.state.settings.survivalTimerDuration || 8;
    else if (mode === 'blitz')  dur = this.state.settings.blitzTimerDuration || 12;
    // classic: global timer only — no per-question timer

    if (dur > 0) {
      this.state.remainingTime = dur;

      this._tickInterval = setInterval(() => {
        this.state.remainingTime = Math.max(0, this.state.remainingTime - 1);
        if (this.state.remainingTime <= 0) {
          clearInterval(this._tickInterval);
          this._tickInterval = null;
          this._onQuestionTimeout(index);
        }
      }, 1000);
    }
  }

  _onQuestionTimeout(index) {
    const mode = this.state.settings.gameMode;

    if (mode === 'survival') {
      // Eliminate all players who haven't answered this question
      this.state.players.forEach((player) => {
        if (player.isHost || player.eliminated || player.finished || player.exited) return;
        if (player.answeredIndex < index) {
          player.eliminated = true;
          player.alive      = false;
          player.finishedAt = Date.now();
        }
      });
      this._checkAllFinished();
      return;
    }

    if (mode === 'blitz') {
      // Force reveal for blitz questions that timed out
      if (this.blitzRound && !this.blitzRound.revealSent) {
        this._sendBlitzReveal(index);
      }
      return;
    }

    if (mode === 'lightning') {
      // Auto-advance to next question for lightning mode
      this._advanceQuestion(index);
    }
    // classic: global timer handles end-of-game
  }

  _advanceQuestion(currentIndex) {
    // Show brief answer reveal before next question
    this._setPhase('answer_reveal');
    this._phaseTimer = setTimeout(() => {
      this._startQuestion(currentIndex + 1);
    }, REVEAL_DURATION * 1000);
  }

  _endGame() {
    this._clearAllTimers();
    if (this.state.phase === 'results') return; // idempotent

    this._setPhase('results');
    this.broadcast('gameEnded', {});
    console.log(`[QuizRoom] Game ended: ${this.roomId}`);
  }

  _resetRoom(newSettings) {
    this._clearAllTimers();

    // Reset schema state
    this.state.phase            = 'lobby';
    this.state.questionIndex    = -1;
    this.state.remainingTime    = 0;
    this.state.teamScoreA       = 0;
    this.state.teamScoreB       = 0;
    this.state.blitzTeamCountA  = 0;
    this.state.blitzTeamCountB  = 0;
    this.state.inSuddenDeath    = false;
    this.state.questionStartedAt = 0;

    // Reset all player schema fields
    this.state.players.forEach((player) => {
      if (player.isHost) return;
      player.score             = 0;
      player.correctCount      = 0;
      player.finished          = false;
      player.eliminated        = false;
      player.alive             = true;
      player.finishedAt        = 0;
      player.exited            = false;
      player.blitzCorrectCount = 0;
      player.team              = '';
      player.answeredIndex     = -1;
    });

    this.activeQuestions = [];
    this.blitzRound      = null;
    this._globalEndTime  = null;

    if (newSettings) this._applySettings(newSettings);

    // Send round reset — clients get schema patch for phase + player resets automatically.
    // This message is kept for one-time UI actions (toast, page transition).
    this.broadcast('roundReset', {
      settings: this._getSettingsPlain(),
      players:  this._getPlayersPlain(),
    });

    console.log(`[QuizRoom] Reset: ${this.roomId}`);
  }

  // ════════════════════════════════════════
  // GLOBAL TIMER  (classic / lightning modes)
  // Ticks every second and updates remainingTime
  // in schema — clients display from state patch.
  // ════════════════════════════════════════

  _startGlobalTimer() {
    this._clearTickInterval();
    const dur = this.state.settings.timerDuration;
    this.state.remainingTime = dur;

    this._tickInterval = setInterval(() => {
      this.state.remainingTime = Math.max(0, this.state.remainingTime - 1);
      if (this.state.remainingTime <= 0) {
        clearInterval(this._tickInterval);
        this._tickInterval = null;
        this._endGame();
      }
    }, 1000);
  }

  // ════════════════════════════════════════
  // BLITZ REVEAL
  // All vote aggregation is server-side.
  // Result is broadcast once per question.
  // ════════════════════════════════════════

  _scheduleBlitzRevealTimeout(questionIndex) {
    if (this._blitzRevealTimer) clearTimeout(this._blitzRevealTimer);
    const dur = (this.state.settings.blitzTimerDuration || 12) * 1000 + 1000; // +1s grace
    this._blitzRevealTimer = setTimeout(() => {
      if (this.blitzRound && !this.blitzRound.revealSent) {
        this._sendBlitzReveal(questionIndex);
      }
    }, dur);
  }

  _sendBlitzReveal(questionIndex) {
    if (!this.blitzRound || this.blitzRound.revealSent) return;
    this.blitzRound.revealSent = true;

    if (this._blitzRevealTimer) {
      clearTimeout(this._blitzRevealTimer);
      this._blitzRevealTimer = null;
    }

    const q = this.activeQuestions[questionIndex];
    if (!q) return;

    const answers  = Object.values(this.blitzRound.answers);
    const aAnswers = answers.filter(a => a.team === 'A');
    const bAnswers = answers.filter(a => a.team === 'B');

    const majority = (teamAnswers) => {
      if (!teamAnswers.length) return { vote: -1, perfect: false, deadlock: false, votes: {} };
      const tally = {};
      teamAnswers.forEach(a => { tally[a.answer] = (tally[a.answer] || 0) + 1; });
      const maxCount = Math.max(...Object.values(tally));
      const top = Object.keys(tally).filter(k => tally[k] === maxCount).map(Number);
      if (top.length > 1) return { vote: -1, perfect: false, deadlock: true, votes: tally };
      const vote    = top[0];
      const perfect = teamAnswers.every(a => a.answer === q.answer);
      return { vote, perfect, deadlock: false, votes: tally };
    };

    const aRes    = majority(aAnswers);
    const bRes    = majority(bAnswers);
    const correct = q.answer;

    const aWin    = !aRes.deadlock && aRes.vote === correct;
    const bWin    = !bRes.deadlock && bRes.vote === correct;
    const aPoints = aRes.deadlock ? 0 : aRes.perfect ? 25 : aWin ? 10 : 0;
    const bPoints = bRes.deadlock ? 0 : bRes.perfect ? 25 : bWin ? 10 : 0;

    // ── Server-authoritative team score accumulation ──
    this.state.teamScoreA += aPoints;
    this.state.teamScoreB += bPoints;

    const isLastQuestion = questionIndex >= this.activeQuestions.length - 1;
    const isTie = isLastQuestion &&
                  this.state.teamScoreA === this.state.teamScoreB &&
                  !this.state.inSuddenDeath;

    this.broadcast('blitzReveal', {
      q:             questionIndex,
      questionText:  q.q,
      correctAnswer: correct,
      aVote:    aRes.vote,  aVotes:   aRes.votes,
      aDeadlock: aRes.deadlock, aPerfect: aRes.perfect, aPoints,
      bVote:    bRes.vote,  bVotes:   bRes.votes,
      bDeadlock: bRes.deadlock, bPerfect: bRes.perfect, bPoints,
      // Running totals — clients never accumulate, always trust these
      teamScoreA: this.state.teamScoreA,
      teamScoreB: this.state.teamScoreB,
    });

    // ── Sudden death (server-driven) ──
    if (isTie) {
      this.state.inSuddenDeath = true;
      setTimeout(() => {
        const sdQ       = this.activeQuestions[0];
        const sdWrapped = { ...sdQ, q: '⚡ SUDDEN DEATH: ' + sdQ.q };
        this.activeQuestions.push(sdWrapped);

        this.blitzRound = {
          questionIndex: this.activeQuestions.length - 1,
          answers:       {},
          revealSent:    false,
        };
        this._scheduleBlitzRevealTimeout(this.blitzRound.questionIndex);

        // Phase machine: advance to new question
        this.state.questionIndex = this.blitzRound.questionIndex;
        this._setPhase('question');

        this.broadcast('blitzSuddenDeath', {
          question:      sdWrapped,
          questionIndex: this.blitzRound.questionIndex,
        });
      }, (REVEAL_DURATION + 0.5) * 1000);

    } else if (isLastQuestion) {
      // Last question revealed, no tie — end the game
      setTimeout(() => this._endGame(), (REVEAL_DURATION + 0.5) * 1000);
    }
  }

  // ════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════

  _isHost(client) {
    return client.sessionId === this.hostSessionId;
  }

  _checkAllFinished() {
    if (this.state.phase === 'results') return;
    const active = [...this.state.players.values()].filter(
      p => !p.isHost && !p.exited
    );
    if (active.length > 0 && active.every(p => p.finished || p.eliminated)) {
      this.broadcast('allFinished', {});
      this._endGame();
    }
  }

  _applySettings(s) {
    if (!s) return;
    const st = this.state.settings;
    if (s.gameMode             !== undefined) st.gameMode             = s.gameMode;
    if (s.scoringMode          !== undefined) st.scoringMode          = s.scoringMode;
    if (s.questionCount        !== undefined) st.questionCount        = s.questionCount;
    if (s.timerDuration        !== undefined) st.timerDuration        = s.timerDuration;
    if (s.blitzTimerDuration   !== undefined) st.blitzTimerDuration   = s.blitzTimerDuration;
    if (s.survivalTimerDuration!== undefined) st.survivalTimerDuration= s.survivalTimerDuration;
    if (s.teamAName            !== undefined) st.teamAName            = s.teamAName;
    if (s.teamBName            !== undefined) st.teamBName            = s.teamBName;
  }

  _getSettingsPlain() {
    const s = this.state.settings;
    return {
      gameMode:              s.gameMode,
      scoringMode:           s.scoringMode,
      questionCount:         s.questionCount,
      timerDuration:         s.timerDuration,
      blitzTimerDuration:    s.blitzTimerDuration,
      survivalTimerDuration: s.survivalTimerDuration,
      teamAName:             s.teamAName,
      teamBName:             s.teamBName,
    };
  }

  _getPlayersPlain() {
    const out = {};
    this.state.players.forEach((p, id) => {
      if (!p.isHost) out[id] = {
        id, nickname: p.nickname, score: p.score,
        correctCount: p.correctCount, finished: p.finished,
        eliminated: p.eliminated, team: p.team,
        blitzCorrectCount: p.blitzCorrectCount,
        finishedAt: p.finishedAt,
      };
    });
    return out;
  }

  _clearPhaseTimer() {
    if (this._phaseTimer) { clearTimeout(this._phaseTimer); this._phaseTimer = null; }
  }

  _clearTickInterval() {
    if (this._tickInterval) { clearInterval(this._tickInterval); this._tickInterval = null; }
  }

  _clearAllTimers() {
    this._clearPhaseTimer();
    this._clearTickInterval();
    if (this._blitzRevealTimer) { clearTimeout(this._blitzRevealTimer); this._blitzRevealTimer = null; }
  }
}

module.exports = { QuizRoom };
