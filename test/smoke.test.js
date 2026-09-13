/*
 * End-to-end smoke test for game.js. Run: node test/smoke.test.js
 *
 * Stubs just enough DOM and canvas for the real game.js to boot, then drives it
 * with a greedy player that clears levels, plus gesture/pause/restart paths.
 * Catches wiring and state-machine regressions that core.test.js cannot see,
 * without needing a browser.
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------ canvas stub */
const gradient = { addColorStop() {} };
const CTX_METHODS = [
  'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo',
  'arc', 'ellipse', 'rect', 'fill', 'stroke', 'clip', 'fillRect', 'strokeRect',
  'clearRect', 'translate', 'scale', 'rotate', 'setTransform', 'setLineDash',
  'fillText', 'strokeText', 'drawImage'
];
function makeCtx() {
  const ctx = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: () => ({ width: 10 })
  };
  for (const m of CTX_METHODS) ctx[m] = () => {};
  return ctx;
}

/* --------------------------------------------------------------- DOM stub */
const els = new Map();
const VIEWPORT = { w: 390, h: 844 };
// The HUD strip is measured by layout() to decide where the pipe starts.
const RECTS = { hud: { width: VIEWPORT.w, height: 46 } };

function makeEl(id, rect) {
  const listeners = new Map();
  let _text = '';
  const el = {
    id,
    get textContent() { return _text; },
    set textContent(v) { _text = String(v); },
    style: {},
    width: 0,
    height: 0,
    classes: new Set(id.startsWith('ov-') && id !== 'ov-menu' ? ['hidden'] : []),
    attrs: {},
    listeners,
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c)
    },
    setAttribute: (k, v) => { el.attrs[k] = v; },
    getAttribute: (k) => el.attrs[k],
    addEventListener: (t, fn) => {
      if (!listeners.has(t)) listeners.set(t, []);
      listeners.get(t).push(fn);
    },
    removeEventListener: () => {},
    getContext: () => makeCtx(),
    getBoundingClientRect: () => Object.assign(
      { width: VIEWPORT.w, height: VIEWPORT.h, left: 0, top: 0 },
      rect || RECTS[id] || null),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    innerHTML: '',
    fire(type, ev = {}) {
      const fns = listeners.get(type) || [];
      for (const fn of fns) fn(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev));
      return fns.length;
    }
  };
  return el;
}

global.self = global;
global.window = global;

const winListeners = new Map();
global.addEventListener = (t, fn) => {
  if (!winListeners.has(t)) winListeners.set(t, []);
  winListeners.get(t).push(fn);
};
global.removeEventListener = () => {};
global.fireWindow = (t, ev = {}) => {
  (winListeners.get(t) || []).forEach((fn) => fn(Object.assign({ preventDefault() {} }, ev)));
};

global.document = {
  hidden: false,
  _listeners: new Map(),
  documentElement: { clientWidth: VIEWPORT.w, clientHeight: VIEWPORT.h },
  body: (() => {
    const classes = new Set();
    return {
      appendChild() {},
      classes,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c)
      }
    };
  })(),
  // Detached elements (the safe-area probe, the offscreen background canvas)
  // report zero size, the way a real one with no layout would.
  createElement: (tag) => makeEl('<' + tag + '>', { width: 0, height: 0 }),
  getElementById(id) {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  },
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  },
  fire(t, ev = {}) {
    const fns = this._listeners.get(t) || [];
    for (const fn of fns) fn(Object.assign({ preventDefault() {} }, ev));
  }
};

const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

global.devicePixelRatio = 2;
// node defines navigator/location as getter-only globals; redefine them.
Object.defineProperty(global, 'navigator', {
  value: { serviceWorker: { register: () => Promise.resolve() } },
  configurable: true, writable: true
});
Object.defineProperty(global, 'location', {
  value: { protocol: 'http:', href: 'http://localhost/' },
  configurable: true, writable: true
});
global.ResizeObserver = class { observe() {} disconnect() {} };
global.AudioContext = class {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  resume() {}
  createOscillator() {
    return {
      type: '',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(n) { return n; }, start() {}, stop() {}
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(n) { return n; }
    };
  }
};

let now = 0;
global.performance = { now: () => now };
let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
global.setTimeout = ((fn) => 0);
global.setInterval = (() => 0);
global.clearTimeout = (() => {});
global.clearInterval = (() => {});

// Deterministic RNG: piece colours and level layouts must be reproducible or
// this test passes or fails at random. Override before the game is loaded.
let rngState = Number(process.env.CLOGGED_SEED || 20260912) >>> 0;
Math.random = () => ((rngState = (rngState * 1664525 + 1013904223) >>> 0) / 4294967296);

global.self.Core = require(path.join(ROOT, 'core.js'));
global.self.Scores = require(path.join(ROOT, 'scores.js'));
const C = global.self.Core;
const Sc = global.self.Scores;

/* ------------------------------------------------------------------ boot */
require(path.join(ROOT, 'game.js'));

const el = (id) => global.document.getElementById(id);
const visible = (id) => !el(id).classes.has('hidden');

function tick(ms = 16) {
  now += ms;
  const cb = rafCb;
  rafCb = null;
  if (cb) cb(now);
}

const problems = [];
function check(name, cond, detail) {
  if (!cond) problems.push(name + (detail ? ' — ' + detail : ''));
}

// getElementById creates stubs on demand, so a renamed or deleted element would
// otherwise fake success. Require each one to have been wired by the game.
[['btn-start', 'click'], ['btn-pause', 'click'], ['btn-sound', 'click'],
 ['btn-resume', 'click'], ['btn-new-game', 'click'], ['btn-pause-scores', 'click'],
 ['btn-retry', 'click'], ['btn-menu', 'click'], ['btn-next-level', 'click'],
 ['lv-up', 'click'], ['lv-down', 'click'],
 ['board', 'pointerdown'], ['board', 'pointermove'], ['board', 'pointerup']
].forEach(([id, ev]) => {
  check('#' + id + ' is wired for ' + ev, el(id).listeners.has(ev));
});

check('menu is visible at boot', visible('ov-menu'));
// The canvas fills the viewport via CSS; JS only sets the backing-store size.
check('board canvas got a pixel size', el('board').width > 0,
  'width=' + el('board').width);
check('board canvas is retina-backed for the viewport',
  el('board').width === Math.round(VIEWPORT.w * global.devicePixelRatio),
  el('board').width + ' vs ' + VIEWPORT.w * global.devicePixelRatio);
check('next preview is sized', el('next').width > 0, 'width=' + el('next').width);


/* ------------------------------------------------- greedy player + hooks */
// Grab the live board by intercepting a Core call the game makes every lock.
let liveBoard = null;
let pendingSpawn = false;
let liveColors = [0, 1];
const _find = C.findMatches;
C.findMatches = function (board, min) { liveBoard = board; return _find(board, min); };
// A signature slip here fails silently: called with the wrong argument order,
// pressureStep just returns 0 forever and the ramp quietly stops existing.
let pressureCalls = [];
const _pressureStep = C.pressureStep;
C.pressureStep = function (level, elapsed) {
  pressureCalls.push([level, elapsed]);
  return _pressureStep(level, elapsed);
};
let lockCount = 0;
const _lockPiece = C.lockPiece;
C.lockPiece = function (board, piece) { lockCount++; return _lockPiece(board, piece); };
let lastRotateDir = 0;
const _rotate = C.tryRotate;
C.tryRotate = function (board, piece, dir) { lastRotateDir = dir; return _rotate(board, piece, dir); };
const _spawn = C.spawnPiece;
C.spawnPiece = function (colors) { pendingSpawn = true; liveColors = colors.slice(); return _spawn(colors); };

function cloneBoard(b) {
  return b.map((c) => (c ? { color: c.color, type: c.type, link: c.link } : null));
}

// Runs of two or three that a future piece could extend into a match.
function setupBonus(b) {
  let pairs = 0, triples = 0;
  const scan = (get) => {
    let run = 1;
    for (let i = 1; i <= (get === rowGet ? C.W : C.H); i++) {
      const a = get(i - 1), n = get(i);
      if (a && n && a.color === n.color) run++;
      else {
        if (a && run === 2) pairs++;
        if (a && run === 3) triples++;
        run = 1;
      }
    }
  };
  let rowGet = null;
  for (let r = 0; r < C.H; r++) {
    const rr = r;
    rowGet = (i) => (i < C.W ? b[C.idx(i, rr)] : null);
    scan(rowGet);
  }
  for (let c = 0; c < C.W; c++) {
    const cc = c;
    const colGet = (i) => (i < C.H ? b[C.idx(cc, i)] : null);
    let run = 1;
    for (let i = 1; i <= C.H; i++) {
      const a = colGet(i - 1), n = colGet(i);
      if (a && n && a.color === n.color) run++;
      else {
        if (a && run === 2) pairs++;
        if (a && run === 3) triples++;
        run = 1;
      }
    }
  }
  return pairs * 6 + triples * 45;
}

function shapeCost(b) {
  let holes = 0, aggregate = 0, maxH = 0;
  for (let c = 0; c < C.W; c++) {
    let top = -1;
    for (let r = 0; r < C.H; r++) {
      if (b[C.idx(c, r)]) { top = r; break; }
    }
    if (top === -1) continue;
    const h = C.H - top;
    aggregate += h;
    if (h > maxH) maxH = h;
    for (let r = top + 1; r < C.H; r++) if (!b[C.idx(c, r)]) holes++;
  }
  return { holes, aggregate, maxH };
}

// Try every column x orientation, keep the placement that clears the most
// grime while keeping the stack low and hole-free.
function bestPlacement(board, colors) {
  const startClogs = C.countClogs(board);
  let best = null;
  for (let orient = 0; orient < 4; orient++) {
    const r0 = orient === 1 ? 1 : 0;
    for (let col = 0; col < C.W; col++) {
      const piece = { c: col, r: r0, orient, colors };
      if (!C.fits(board, piece)) continue;
      const sim = cloneBoard(board);
      const landed = { c: col, r: r0 + C.dropDistance(board, piece), orient, colors };
      C.lockPiece(sim, landed);
      const res = C.resolve(sim);
      const shape = shapeCost(sim);
      const cleared = startClogs - C.countClogs(sim);
      const score = cleared * 5000 + res.segments * 60 + res.chain * 150
        + setupBonus(sim)
        - shape.holes * 60 - shape.aggregate * 3 - shape.maxH * 12;
      if (!best || score > best.score) best = { score, orient, col };
    }
  }
  return best;
}

function driveMove(plan) {
  for (let i = 0; i < plan.orient; i++) global.document.fire('keydown', { key: 'x' });
  let cur = (C.W >> 1) - 1; // spawn anchor column
  while (cur < plan.col) { global.document.fire('keydown', { key: 'ArrowRight' }); cur++; }
  while (cur > plan.col) { global.document.fire('keydown', { key: 'ArrowLeft' }); cur--; }
  global.document.fire('keydown', { key: ' ' });
}

// Plays until the level clears, the game ends, or we run out of frames.
function playSmart(maxFrames) {
  let frames = 0;
  pendingSpawn = false;
  while (frames < maxFrames) {
    if (pendingSpawn && liveBoard) {
      pendingSpawn = false;
      const plan = bestPlacement(liveBoard, liveColors);
      if (plan) driveMove(plan);
    }
    tick(16);
    frames++;
    if (visible('ov-clear') || visible('ov-gameover')) break;
  }
  return {
    frames,
    cleared: visible('ov-clear'),
    over: visible('ov-gameover')
  };
}

/* --------------------------------------------------- play and win a level */
function startAt(level) {
  for (let i = 0; i < 25; i++) el('lv-down').fire('click');
  for (let i = 0; i < level; i++) el('lv-up').fire('click');
  el('btn-start').fire('click');
}

startAt(0);
check('starting hides the menu', !visible('ov-menu'));
check('level 0 seeds four grime', el('hud-clogs').textContent === '4',
  'clogs=' + el('hud-clogs').textContent);

// The greedy player is not a great player: it loses some runs outright. Retry
// the level a few times so this asserts "the game is winnable and the win path
// works", not "this particular run went well".
function clearLevel(attempts) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = playSmart(60000);
    if (last.cleared) return last;
    if (!last.over) return last; // ran out of frames; something is stuck
    el('btn-retry').fire('click');
    tick(16);
  }
  return last;
}

const run = clearLevel(6);
check('a capable player clears level 0', run.cleared,
  'over=' + run.over + ' frames=' + run.frames + ' clogs=' + el('hud-clogs').textContent);
check('clearing the level scored points', Number(el('hud-score').textContent) > 0,
  'score=' + el('hud-score').textContent);
check('level clear names the level', /Level 0 flushed/.test(el('clear-info').textContent),
  el('clear-info').textContent);
check('best score persisted', store.has('clogged.best'), [...store.keys()].join(','));
check('the HUD steps aside for the flush effect',
  global.document.body.classes.has('fx-active'));

const scoreAfterL0 = Number(el('hud-score').textContent);
el('btn-next-level').fire('click');
tick(16);
check('next level advances the counter', el('hud-level').textContent === '1',
  'level=' + el('hud-level').textContent);
check('next level keeps the running score',
  Number(el('hud-score').textContent) >= scoreAfterL0,
  'before=' + scoreAfterL0 + ' after=' + el('hud-score').textContent);
check('next level reseeds grime', el('hud-clogs').textContent === '8',
  'clogs=' + el('hud-clogs').textContent);
check('the HUD comes back for the next level',
  !global.document.body.classes.has('fx-active'));

const run2 = clearLevel(6);
check('the player also clears level 1', run2.cleared,
  'over=' + run2.over + ' clogs=' + el('hud-clogs').textContent);

/* ------------------------------------------------------ pause / gestures */
el('btn-next-level').fire('click');
for (let i = 0; i < 5; i++) tick(16);

el('btn-pause').fire('click');
check('pause overlay shows', visible('ov-pause'));
const frozen = el('hud-score').textContent;
for (let i = 0; i < 300; i++) tick(16);
check('paused game does not advance', el('hud-score').textContent === frozen,
  frozen + ' -> ' + el('hud-score').textContent);
el('btn-resume').fire('click');
check('resume hides the pause overlay', !visible('ov-pause'));

global.document.hidden = true;
global.document.fire('visibilitychange');
check('hiding the tab pauses', visible('ov-pause'));
global.document.hidden = false;
el('btn-resume').fire('click');
for (let i = 0; i < 20; i++) tick(16);

/* --------------------------------------------------------------- gestures */
// The pipe is the only controller now, so these paths carry the whole game.
const board = el('board');
check('the pipe listens for drags',
  board.listeners.has('pointerdown') && board.listeners.has('pointermove'),
  [...board.listeners.keys()].join(','));

// Drag sideways: the piece follows the finger without ending the run.
board.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
for (let x = 100; x <= 240; x += 20) {
  board.fire('pointermove', { pointerId: 1, clientX: x, clientY: 302 });
  tick(16);
}
board.fire('pointerup', { pointerId: 1, clientX: 240, clientY: 302 });
tick(16);
check('drag did not end the game', !visible('ov-gameover'));

// A tap spins counter-clockwise.
lastRotateDir = 0;
board.fire('pointerdown', { pointerId: 2, clientX: 150, clientY: 300 });
board.fire('pointerup', { pointerId: 2, clientX: 150, clientY: 300 });
tick(16);
check('tapping spins counter-clockwise', lastRotateDir === -1, 'dir=' + lastRotateDir);

// Swiping up spins the other way.
lastRotateDir = 0;
board.fire('pointerdown', { pointerId: 4, clientX: 150, clientY: 400 });
tick(16);
board.fire('pointermove', { pointerId: 4, clientX: 150, clientY: 280 });
board.fire('pointerup', { pointerId: 4, clientX: 150, clientY: 280 });
tick(16);
check('swiping up spins clockwise', lastRotateDir === 1, 'dir=' + lastRotateDir);

// A fast downward flick slams the piece home: a piece must lock. Counting
// locks rather than segments, since the landing may immediately clear a line.
const beforeFlick = lockCount;
board.fire('pointerdown', { pointerId: 3, clientX: 150, clientY: 180 });
tick(16); // 16ms later, 200px down => ~12px/ms, comfortably a flick
board.fire('pointermove', { pointerId: 3, clientX: 152, clientY: 380 });
board.fire('pointerup', { pointerId: 3, clientX: 152, clientY: 380 });
for (let i = 0; i < 40; i++) tick(16);
check('a downward flick slams the piece home', lockCount > beforeFlick,
  'locks ' + beforeFlick + ' -> ' + lockCount);

// Keyboard rotation matches: Z / ArrowUp counter-clockwise, X clockwise.
lastRotateDir = 0;
global.document.fire('keydown', { key: 'ArrowUp' });
check('ArrowUp spins counter-clockwise like a tap', lastRotateDir === -1, 'dir=' + lastRotateDir);
lastRotateDir = 0;
global.document.fire('keydown', { key: 'x' });
check('X spins clockwise', lastRotateDir === 1, 'dir=' + lastRotateDir);

/* ------------------------------------------------------------ sound toggle */
check('the sound button is wired', el('btn-sound').listeners.has('click'));
el('btn-sound').fire('click');
check('mute persists', store.get('clogged.muted') === 'true', store.get('clogged.muted'));
check('sound button reads off', el('btn-sound').textContent === 'Sound: off',
  el('btn-sound').textContent);
el('btn-sound').fire('click');
check('sound button reads on again', el('btn-sound').textContent === 'Sound: on',
  el('btn-sound').textContent);

/* ------------------------------------------------------------- pause menu */
el('btn-pause').fire('click');
check('the pause button opens the menu', visible('ov-pause'));
check('the pause menu shows the run so far',
  /Score .* level \d+/.test(el('pause-score').textContent), el('pause-score').textContent);
check('the pause menu offers resume', el('btn-resume').listeners.has('click'));
check('the pause menu offers a new game', el('btn-new-game').listeners.has('click'));
check('the pause menu offers high scores', el('btn-pause-scores').listeners.has('click'));
check('the pause menu offers the sound toggle', el('btn-sound').listeners.has('click'));

// High scores open over the pause menu and hand it back on close.
el('btn-pause-scores').fire('click');
check('high scores open from the pause menu', visible('ov-scores'));
check('the pause menu steps aside for them', !visible('ov-pause'));
const frozenWhileReading = el('hud-score').textContent;
for (let i = 0; i < 200; i++) tick(16);
check('the game stays paused behind the scores screen',
  el('hud-score').textContent === frozenWhileReading);
el('btn-scores-back').fire('click');
check('closing scores returns to the pause menu', visible('ov-pause'));
check('the scores screen closed', !visible('ov-scores'));

el('btn-resume').fire('click');
check('resume closes the pause menu', !visible('ov-pause'));

// Losing focus pauses, and must never toggle a paused game back on.
global.fireWindow('blur');
check('losing window focus pauses', visible('ov-pause'));
const frozenOnBlur = el('hud-score').textContent;
for (let i = 0; i < 200; i++) tick(16);
check('a blurred game does not advance', el('hud-score').textContent === frozenOnBlur);
global.fireWindow('blur');
check('a second blur does not resume the game', visible('ov-pause'));
global.document.hidden = true;
global.document.fire('visibilitychange');
check('hiding the tab while paused keeps it paused', visible('ov-pause'));
global.document.hidden = false;
el('btn-resume').fire('click');
check('resume works after a focus pause', !visible('ov-pause'));
for (let i = 0; i < 20; i++) tick(16);

/* --------------------------------------------------- new game / quit / lose */
const scoreBeforeNew = Number(el('hud-score').textContent);
const bestBeforeNew = Number(store.get('clogged.best') || 0);
el('btn-pause').fire('click');
el('btn-new-game').fire('click');
check('new game returns to the title screen', visible('ov-menu'));
// Starting over must bank the run first, or the score is silently lost.
check('new game does not discard the run from the best score',
  Number(store.get('clogged.best') || 0) >= Math.max(scoreBeforeNew, bestBeforeNew),
  'run=' + scoreBeforeNew + ' bestBefore=' + bestBeforeNew +
  ' bestAfter=' + store.get('clogged.best'));
el('btn-start').fire('click');
tick(16);
check('the new game starts from zero', el('hud-score').textContent === '0',
  el('hud-score').textContent);
check('the new game closes the overlays', !visible('ov-pause') && !visible('ov-menu'));

// A hopeless stack must end the game rather than hang.
startAt(20);
let over = false;
for (let i = 0; i < 40000 && !over; i++) {
  tick(16);
  if (i % 5 === 0) global.document.fire('keydown', { key: ' ' });
  over = visible('ov-gameover');
}
check('stacking to the top ends the game', over);
check('game over reports a score', /Score: \d+/.test(el('go-score').textContent),
  el('go-score').textContent);
el('btn-retry').fire('click');
tick(16);
check('retry restarts at the same level', el('hud-level').textContent === '20',
  el('hud-level').textContent);
check('retry clears the game-over overlay', !visible('ov-gameover'));

/* ---------------------------------------------------------------- pressure */
{
  check('the game asks for the pressure step while playing', pressureCalls.length > 0,
    'calls=' + pressureCalls.length);
  check('pressure is asked about a real level',
    pressureCalls.every(([lv]) => typeof lv === 'number' && lv >= 0 && lv <= C.MAX_LEVEL),
    JSON.stringify(pressureCalls[0]));
  check('pressure is asked about elapsed time, not undefined',
    pressureCalls.every(([, ms]) => typeof ms === 'number' && isFinite(ms) && ms >= 0),
    JSON.stringify(pressureCalls[0]));
  // A competent player clears a level in seconds, so stall one on purpose:
  // sit on level 0 without touching it for well past the grace period.
  startAt(0);
  pressureCalls = [];
  const holdMs = C.pressureGrace(0) + C.PRESSURE_STEP_MS * 2;
  for (let t = 0; t < holdMs && !visible('ov-gameover') && !visible('ov-clear'); t += 16) {
    tick(16);
  }
  const longest = pressureCalls.reduce((m, [, ms]) => Math.max(m, ms), 0);
  check('a stalled level runs past the grace period',
    longest > C.pressureGrace(0),
    'longest=' + Math.round(longest / 1000) + 's grace=' + Math.round(C.pressureGrace(0) / 1000) + 's');
  check('stalling that long does raise the pressure',
    _pressureStep(0, longest) > 0, 'step=' + _pressureStep(0, longest));
  check('but a full minute of it changes nothing at all',
    _pressureStep(0, C.pressureGrace(0) - 1) === 0);
  el('btn-pause').fire('click');
  el('btn-new-game').fire('click');
}

/* ------------------------------------------------------------ score history */
{
  const saved = () => Sc.sanitize(JSON.parse(store.get('clogged.history') || 'null'));

  // The losing run earlier in this test must have been filed exactly once.
  const afterLoss = saved();
  check('a finished run is recorded in history', afterLoss.runs.length > 0,
    'runs=' + afterLoss.runs.length);
  check('the recorded run has a score', afterLoss.runs.every((r) => r.s > 0));
  check('the recorded run has a timestamp', afterLoss.runs.every((r) => r.t > 0));
  check('the top table is populated', afterLoss.top.length > 0);
  check('the best score matches the table top',
    Sc.bestScore(afterLoss) === Number(store.get('clogged.best')),
    Sc.bestScore(afterLoss) + ' vs ' + store.get('clogged.best'));

  // Retrying after a game over must not file the same run a second time.
  const countBefore = saved().runs.length;
  el('btn-retry').fire('click');
  tick(16);
  check('retrying does not double-record the finished run',
    saved().runs.length === countBefore,
    countBefore + ' -> ' + saved().runs.length);

  // Advancing a level continues the same run, so it must not be filed.
  startAt(0);
  const midRun = saved().runs.length;
  const won = clearLevel(6);
  check('a level was cleared for the history check', won && won.cleared);
  el('btn-next-level').fire('click');
  tick(16);
  check('clearing a level does not end the run', saved().runs.length === midRun,
    midRun + ' -> ' + saved().runs.length);

  // Quitting mid-run banks it.
  for (let i = 0; i < 30; i++) tick(16);
  const beforeQuit = saved().runs.length;
  const quitScore = Number(el('hud-score').textContent);
  el('btn-pause').fire('click');
  el('btn-new-game').fire('click');
  check('quitting mid-run records it', saved().runs.length === beforeQuit + 1,
    beforeQuit + ' -> ' + saved().runs.length);
  const last = saved().runs[saved().runs.length - 1];
  check('the quit run kept its score', !!last && last.s === quitScore,
    (last ? last.s : 'no run recorded') + ' vs ' + quitScore);

  // Starting a fresh game from the menu must not re-file the quit run.
  const beforeReplay = saved().runs.length;
  el('btn-start').fire('click');
  tick(16);
  check('starting a new game does not re-record the last one',
    saved().runs.length === beforeReplay,
    beforeReplay + ' -> ' + saved().runs.length);
}

/* -------------------------------------------------------- score screen UI */
{
  el('btn-pause').fire('click');
  el('btn-new-game').fire('click');
  check('the scores button is wired', el('btn-scores').listeners.has('click'));
  el('btn-scores').fire('click');
  check('the scores screen opens', visible('ov-scores'));
  check('the menu is hidden behind it', !visible('ov-menu'));

  const table = el('top-body').innerHTML;
  check('the top table rendered rows', table.indexOf('<tr') === 0, table.slice(0, 60));
  check('the top table shows a rank', table.indexOf('class="rank"') > 0);
  check('the top table shows a score', table.indexOf('class="score"') > 0);

  const chart = el('chart-plot').innerHTML;
  check('the timeline rendered an svg', chart.indexOf('<svg') === 0, chart.slice(0, 40));
  check('the timeline draws a line', chart.indexOf('stroke="var(--chart-series)"') > 0);
  check('the timeline uses the validated series colour',
    chart.indexOf('fill="var(--chart-series)"') > 0);
  check('the timeline has an accessible table',
    chart.indexOf('class="visually-hidden"') > 0 && chart.indexOf('<caption>') > 0);
  check('the chart itself is hidden from screen readers',
    chart.indexOf('aria-hidden="true"') > 0);
  check('the timeline shows at most 25 points',
    (chart.match(/<circle /g) || []).length <= 25,
    String((chart.match(/<circle /g) || []).length));
  check('the timeline labels sparingly, not every point',
    (chart.match(/class="pt"/g) || []).length <= 2,
    String((chart.match(/class="pt"/g) || []).length));

  el('btn-scores-back').fire('click');
  check('closing the scores screen returns to the menu', visible('ov-menu'));
  check('the scores screen is closed', !visible('ov-scores'));
}

/* --------------------------------------------------------------- report */
if (problems.length) {
  console.error('SMOKE FAILED (' + problems.length + ')');
  problems.forEach((p) => console.error('  ✗ ' + p));
  process.exit(1);
}
console.log('smoke ok — boots, wins two levels, pauses, gestures, restarts, loses cleanly');
