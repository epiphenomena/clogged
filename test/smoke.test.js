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
global.self.Save = require(path.join(ROOT, 'save.js'));
const C = global.self.Core;
const Sc = global.self.Scores;
const Sv = global.self.Save;

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
// The player simulates placements on throwaway copies; only the game's own
// calls identify the real board.
let simulating = false;
const _find = C.findMatches;
C.findMatches = function (board, min) {
  if (!simulating) liveBoard = board;
  return _find(board, min);
};
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
// Sideways movement is what the swipe-down fix is about, so it has to be
// observable: every accepted horizontal step lands here.
let sideSteps = 0;
let downSteps = 0;
const _tryMove = C.tryMove;
C.tryMove = function (board, piece, dc, dr) {
  const next = _tryMove(board, piece, dc, dr);
  if (next && !simulating) {
    if (dc !== 0) sideSteps++;
    if (dr > 0) downSteps++;
  }
  return next;
};
let lastRotateDir = 0;
const _rotate = C.tryRotate;
C.tryRotate = function (board, piece, dir) { lastRotateDir = dir; return _rotate(board, piece, dir); };
// Catch the board the moment a level is built, so it is accurate before the
// first piece has even landed.
const _seed = C.seedLevel;
C.seedLevel = function (level, rand) {
  const built = _seed(level, rand);
  if (!simulating) liveBoard = built.board;
  return built;
};
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
  simulating = true;
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
  simulating = false;
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
check('level 0 seeds four clogs', el('hud-clogs').textContent === '4',
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
check('next level reseeds its clogs',
  el('hud-clogs').textContent === String(C.clogTotal(1)),
  'clogs=' + el('hud-clogs').textContent + ' want=' + C.clogTotal(1));
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

// A fast sideways swipe droops a little on the way across, and that droop must
// not read as a slam.
const beforeSwipe = lockCount;
board.fire('pointerdown', { pointerId: 6, clientX: 60, clientY: 240 });
tick(16);
board.fire('pointermove', { pointerId: 6, clientX: 300, clientY: 300 });
board.fire('pointerup', { pointerId: 6, clientX: 300, clientY: 300 });
tick(16);
check('a fast sideways swipe is not a slam', lockCount === beforeSwipe,
  'locks ' + beforeSwipe + ' -> ' + lockCount);

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

// Aim sideways, then keep dragging down without lifting. A thumb travelling
// down a phone screen arcs — here 5px sideways for every 14px down — and that
// arc must not slide the coupling out of the column it was just aimed at.
// Done on the coupling that follows the slam, pinned to the left wall first so
// the result cannot depend on where the previous one happened to be: without
// that, a piece already against the right wall absorbs the unwanted step and
// the test passes for the wrong reason.
check('a new coupling arrives after the slam', pendingSpawn);
sideSteps = 0;
for (let i = 0; i < 8; i++) global.document.fire('keydown', { key: 'ArrowLeft' });
check('the new coupling is live and walks to the wall', sideSteps > 0,
  'side steps=' + sideSteps);

board.fire('pointerdown', { pointerId: 5, clientX: 120, clientY: 120 });
tick(16);
for (let x = 140; x <= 200; x += 20) {          // aim: two columns to the right
  board.fire('pointermove', { pointerId: 5, clientX: x, clientY: 120 });
  tick(16);
}
sideSteps = 0;
downSteps = 0;
for (let i = 1; i <= 8; i++) {
  board.fire('pointermove', { pointerId: 5, clientX: 200 + i * 5, clientY: 120 + i * 14 });
  tick(16);   // 14px per frame is 0.875px/ms — a drag, well short of a flick
}
check('a slow drag down does not slide the coupling sideways', sideSteps === 0,
  'side steps=' + sideSteps);
// ...and it is still a soft drop, or the assertion above would pass on a
// control that had simply stopped working.
check('a slow drag down still walks the coupling downward', downSteps >= 2,
  'down steps=' + downSteps);
board.fire('pointerup', { pointerId: 5, clientX: 240, clientY: 232 });
tick(16);

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

/* ------------------------------------------------------------ clog arrivals */
{
  // A hard level holds most of its clogs back and washes them in during play.
  startAt(12);
  const total = C.clogTotal(12);
  check('the HUD counts clogs still to come',
    Number(el('hud-clogs').textContent) === total,
    el('hud-clogs').textContent + ' want=' + total);
  check('the board opens with only a handful of them',
    liveBoard && C.countClogs(liveBoard) === C.clogSeedCount(12),
    'on board=' + (liveBoard ? C.countClogs(liveBoard) : '?'));
  check('a hard level holds some back', C.clogSeedCount(12) < total,
    C.clogSeedCount(12) + ' of ' + total);

  // Play on: arrivals should land and become part of the board.
  const onBoardAtStart = C.countClogs(liveBoard);
  let sawMore = false, frames = 0;
  pendingSpawn = false;
  while (frames < 40000 && !visible('ov-gameover') && !visible('ov-clear')) {
    if (pendingSpawn && liveBoard) {
      pendingSpawn = false;
      const plan = bestPlacement(liveBoard, liveColors);
      if (plan) driveMove(plan);
    }
    tick(16);
    frames++;
    if (C.countClogs(liveBoard) > onBoardAtStart) { sawMore = true; break; }
  }
  check('clogs wash in while the level is played', sawMore,
    'started=' + onBoardAtStart + ' now=' + C.countClogs(liveBoard));
  check('arrivals land as clogs, not as couplings',
    liveBoard.filter((c) => c && c.type === 'clog').length > 0);

  // They must settle low rather than perch on top of a stack.
  const highest = liveBoard.reduce((best, cell, i) =>
    cell && cell.type === 'clog' ? Math.min(best, C.rowOf(i)) : best, C.H);
  check('arrivals do not stack up near the ceiling', highest >= 2,
    'topmost clog row=' + highest);

  el('btn-pause').fire('click');
  el('btn-new-game').fire('click');
}

/* ------------------------------------- a level is not over until all arrive */
{
  // Wipe the visible clogs while the queue still holds plenty. The level must
  // stay open: "no clogs on the board" is not the same as "level cleared".
  startAt(12);
  const queued = C.clogTotal(12) - C.clogSeedCount(12);
  check('this level really does hold clogs back', queued > 0, 'queued=' + queued);
  for (let i = 0; i < liveBoard.length; i++) {
    if (liveBoard[i] && liveBoard[i].type === 'clog') liveBoard[i] = null;
  }
  check('the board now has no clogs on it', C.countClogs(liveBoard) === 0,
    'left=' + C.countClogs(liveBoard));

  let f = 0;
  while (f < 6000 && !visible('ov-clear') && !visible('ov-gameover')) {
    global.document.fire('keydown', { key: ' ' });
    tick(16);
    f++;
  }
  check('an empty board does not clear the level while clogs are queued',
    !visible('ov-clear'),
    'cleared after ' + f + ' frames with ' + queued + ' still to arrive');

  if (visible('ov-gameover')) el('btn-menu').fire('click');
  else { el('btn-pause').fire('click'); el('btn-new-game').fire('click'); }
}

/* ---------------------------------------------------------- suspended games */
{
  const LIMITS = { cells: C.W * C.H, cols: C.W, colors: C.COLORS, maxLevel: C.MAX_LEVEL };
  const stored = () => Sv.decode(JSON.parse(store.get('clogged.save') || 'null'), LIMITS);

  startAt(6);
  for (let i = 0; i < 40; i++) tick(16);
  const mid = stored();
  check('a game in progress is written down', !!mid,
    'raw=' + String(store.get('clogged.save')).slice(0, 40));
  check('the snapshot knows the level', mid && mid.level === 6, 'level=' + (mid && mid.level));
  check('the snapshot carries a board',
    mid && mid.board.length === C.W * C.H);
  check('the snapshot keeps the clogs',
    mid && C.countClogs(mid.board) > 0, 'clogs=' + (mid && C.countClogs(mid.board)));
  check('the snapshot carries the queue', mid && Array.isArray(mid.pending));
  check('the snapshot has a coupling in play', mid && !!mid.piece);

  // Play on, then pause: the snapshot must move with the game.
  for (let i = 0; i < 12; i++) { global.document.fire('keydown', { key: ' ' }); tick(16); }
  for (let i = 0; i < 60; i++) tick(16);
  el('btn-pause').fire('click');
  const paused = stored();
  check('pausing refreshes the snapshot', !!paused);
  check('the refreshed snapshot moved on',
    paused && mid && (paused.score !== mid.score || paused.locks !== mid.locks),
    'locks ' + (mid && mid.locks) + ' -> ' + (paused && paused.locks));

  // Pausing must write a *fresh* snapshot. Without this the assertion above is
  // satisfied by the one written when the coupling spawned, and a pause that
  // silently records nothing looks identical to one that works.
  el('btn-resume').fire('click');
  // Wait for a fresh coupling, so the soft drops below cannot land it and tip
  // the game into a cascade, where the board is briefly inconsistent and no
  // snapshot is taken.
  pendingSpawn = false;
  for (let i = 0; i < 4000 && !pendingSpawn; i++) tick(16);
  for (let i = 0; i < 3; i++) { global.document.fire('keydown', { key: 'ArrowDown' }); tick(16); }
  const liveNow = Number(el('hud-score').textContent);
  const staleSnapshot = stored();
  check('soft dropping moved the score past the last snapshot',
    !!staleSnapshot && liveNow > staleSnapshot.score,
    'live=' + liveNow + ' snapshot=' + (staleSnapshot && staleSnapshot.score));
  el('btn-pause').fire('click');
  const fresh = stored();
  check('pausing records the score as it stands right now',
    !!fresh && fresh.score === liveNow,
    'snapshot=' + (fresh && fresh.score) + ' live=' + liveNow);

  // Losing focus writes one too.
  el('btn-resume').fire('click');
  for (let i = 0; i < 30; i++) tick(16);
  global.fireWindow('blur');
  check('losing focus writes a snapshot', !!stored());

  // Resuming restores the run and leaves it paused, not mid-fall.
  const before = stored();
  check('there is a snapshot to restore from', !!before);
  el('btn-new-game').fire('click');   // banks the run and drops its save
  check('abandoning a run clears its snapshot', stored() === null,
    'raw=' + String(store.get('clogged.save')).slice(0, 40));

  // Put a snapshot back and resume from the title screen.
  // The title screen re-reads storage whenever it comes back into view.
  el('btn-menu').fire('click');
  if (before) store.set('clogged.save', JSON.stringify(Sv.encode({
    level: before.level, score: before.score, board: before.board, piece: before.piece,
    next: before.next, pending: before.pending, sinceDrip: before.sinceDrip,
    elapsed: before.elapsed, pressure: before.pressure, locks: before.locks,
    recorded: before.recorded
  })));
  el('btn-scores').fire('click');
  el('btn-scores-back').fire('click');
  check('the resume button appears when a game is waiting',
    !el('btn-resume-saved').classes.has('hidden'));
  check('the resume button says what it resumes',
    /Level \d+/.test(el('resume-sub').textContent), el('resume-sub').textContent);

  el('btn-resume-saved').fire('click');
  check('resuming lands on the pause menu, not mid-fall', visible('ov-pause'));
  check('the restored score is back',
    !!before && Number(el('hud-score').textContent) === before.score,
    el('hud-score').textContent + ' want=' + (before && before.score));
  check('the restored level is back',
    !!before && Number(el('hud-level').textContent) === before.level,
    el('hud-level').textContent + ' want=' + (before && before.level));
  const frozenOnResume = el('hud-score').textContent;
  for (let i = 0; i < 120; i++) tick(16);
  check('a resumed game waits for the player',
    el('hud-score').textContent === frozenOnResume);

  el('btn-resume').fire('click');
  for (let i = 0; i < 60; i++) tick(16);
  check('a resumed game plays on', !visible('ov-pause'));
  check('the resumed board still has its clogs',
    C.countClogs(liveBoard) + Number(el('hud-clogs').textContent) > 0);

  // A corrupt record must never boot the game into a broken state.
  el('btn-pause').fire('click');
  el('btn-new-game').fire('click');
  store.set('clogged.save', '{"v":2,"board":"nonsense"}');
  el('btn-scores').fire('click');
  el('btn-scores-back').fire('click');
  check('a corrupt snapshot offers no resume',
    el('btn-resume-saved').classes.has('hidden'));
  store.set('clogged.save', 'not json at all');
  el('btn-scores').fire('click');
  el('btn-scores-back').fire('click');
  check('unparseable storage offers no resume',
    el('btn-resume-saved').classes.has('hidden'));
  store.delete('clogged.save');
}

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
  // Stalling has to be acted out. A competent player clears a level in seconds,
  // and a player who does nothing at all tops out in under a minute — every
  // piece lands in the same column. So play slowly instead: let each coupling
  // fall on its own, steering it to a fresh column so the pipe stays low.
  startAt(0);
  pressureCalls = [];
  const want = C.pressureGrace(0) + C.PRESSURE_STEP_MS;
  let longest = 0, spread = 0;
  pendingSpawn = false;
  for (let f = 0; f < 30000 && longest <= want; f++) {
    if (pendingSpawn) {
      pendingSpawn = false;
      spread = (spread + 3) % (C.W - 1);
      let cur = (C.W >> 1) - 1;
      while (cur < spread) { global.document.fire('keydown', { key: 'ArrowRight' }); cur++; }
      while (cur > spread) { global.document.fire('keydown', { key: 'ArrowLeft' }); cur--; }
    }
    tick(16);
    if (visible('ov-gameover') || visible('ov-clear')) break;
    longest = pressureCalls.reduce((m, [, ms]) => Math.max(m, ms), 0);
  }
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
