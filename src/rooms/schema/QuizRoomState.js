// ══════════════════════════════════════════════════════════════
// QuizRoomState.js  —  Colyseus Schema Definitions
//
// Every field defined here becomes a delta-patched state property.
// Colyseus automatically sends ONLY changed fields to clients —
// no more full playersUpdated broadcasts.
//
// Supports 100-500 concurrent players with minimal bandwidth.
// ══════════════════════════════════════════════════════════════

const {
  Schema,
  MapSchema,
  ArraySchema,
  type,
  defineTypes
} = require('@colyseus/schema');

// ── Player State ──────────────────────────────────────────────
// One instance per connected player. Changes to any field
// trigger an automatic patch to all subscribed clients.
class PlayerState extends Schema {
  constructor() {
    super();
    this.nickname       = '';
    this.score          = 0;
    this.correctCount   = 0;
    this.finished       = false;
    this.eliminated     = false;
    this.alive          = true;   // survival mode
    this.finishedAt     = 0;
    this.exited         = false;
    this.team           = '';     // 'A' | 'B' | '' for non-blitz
    this.blitzCorrectCount = 0;
    this.isHost         = false;
    this.answeredIndex  = -1;     // last question index answered (prevents double-submit)
  }
}
defineTypes(PlayerState, {
  nickname:           'string',
  score:              'number',
  correctCount:       'number',
  finished:           'boolean',
  eliminated:         'boolean',
  alive:              'boolean',
  finishedAt:         'number',
  exited:             'boolean',
  team:               'string',
  blitzCorrectCount:  'number',
  isHost:             'boolean',
  answeredIndex:      'number',
});

// ── Game Settings State ───────────────────────────────────────
class GameSettingsState extends Schema {
  constructor() {
    super();
    this.gameMode             = 'classic'; // classic | lightning | survival | blitz
    this.scoringMode          = 'standard';
    this.questionCount        = 20;
    this.timerDuration        = 120;
    this.blitzTimerDuration   = 12;
    this.survivalTimerDuration = 8;
    this.teamAName            = 'Team A';
    this.teamBName            = 'Team B';
  }
}
defineTypes(GameSettingsState, {
  gameMode:             'string',
  scoringMode:          'string',
  questionCount:        'number',
  timerDuration:        'number',
  blitzTimerDuration:   'number',
  survivalTimerDuration:'number',
  teamAName:            'string',
  teamBName:            'string',
});

// ── Root Room State ───────────────────────────────────────────
// This is what Colyseus patches to every client automatically.
// Think of it as the single source of truth for the entire room.
class QuizRoomState extends Schema {
  constructor() {
    super();

    // ── Phase Machine ──
    // Valid values: lobby | countdown | question | answer_reveal
    //               results | waiting_next_round | closed
    // Server sets this.state.phase = 'question' and ALL clients
    // instantly receive the patch and update their UI.
    this.phase            = 'lobby';

    // ── Round / Question Tracking ──
    this.roundNumber      = 0;
    this.questionIndex    = -1;   // -1 = not started
    this.remainingTime    = 0;    // seconds, ticks server-side
    this.questionStartedAt = 0;   // ms timestamp

    // ── Team Scores (blitz) ──
    this.teamScoreA       = 0;
    this.teamScoreB       = 0;
    this.blitzTeamCountA  = 0;
    this.blitzTeamCountB  = 0;
    this.inSuddenDeath    = false;

    // ── Settings ──
    this.settings         = new GameSettingsState();

    // ── Players ──
    // MapSchema<PlayerState> — each player.onChange() fires
    // a delta patch, not a full player list broadcast.
    this.players          = new MapSchema();
  }
}
defineTypes(QuizRoomState, {
  phase:            'string',
  roundNumber:      'number',
  questionIndex:    'number',
  remainingTime:    'number',
  questionStartedAt:'number',
  teamScoreA:       'number',
  teamScoreB:       'number',
  blitzTeamCountA:  'number',
  blitzTeamCountB:  'number',
  inSuddenDeath:    'boolean',
  settings:         GameSettingsState,
  players:          { map: PlayerState },
});

module.exports = { QuizRoomState, PlayerState, GameSettingsState };
