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
function makeEl(id) {
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
    getBoundingClientRect: () => ({ width: 390, height: 620, left: 0, top: 0 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
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
      type: '', frequency: { setValueAtTime() {} },
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
const C = global.self.Core;

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

check('menu is visible at boot', visible('ov-menu'));
check('board canvas got a pixel size', el('board').width > 0,
  'width=' + el('board').width);
check('board canvas has a css size', /px$/.test(el('board').style.width || ''),
  'style.width=' + el('board').style.width);


/* ------------------------------------------------- greedy player + hooks */
// Grab the live board by intercepting a Core call the game makes every lock.
let liveBoard = null;
let pendingSpawn = false;
let liveColors = [0, 1];
const _find = C.findMatches;
C.findMatches = function (board, min) { liveBoard = board; return _find(board, min); };
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

// Drag across the pipe, tap to rotate, flick down to drop.
const board = el('board');
board.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 300 });
for (let x = 100; x <= 240; x += 20) {
  board.fire('pointermove', { pointerId: 1, clientX: x, clientY: 302 });
  tick(16);
}
board.fire('pointerup', { pointerId: 1, clientX: 240, clientY: 302 });
tick(16);
check('drag did not end the game', !visible('ov-gameover'));

board.fire('pointerdown', { pointerId: 2, clientX: 150, clientY: 300 });
board.fire('pointerup', { pointerId: 2, clientX: 150, clientY: 300 });
tick(16);

const beforeFlick = Number(el('hud-score').textContent);
board.fire('pointerdown', { pointerId: 3, clientX: 150, clientY: 180 });
board.fire('pointermove', { pointerId: 3, clientX: 152, clientY: 340 });
board.fire('pointerup', { pointerId: 3, clientX: 152, clientY: 340 });
for (let i = 0; i < 40; i++) tick(16);
check('a downward flick hard-drops (score rises)',
  Number(el('hud-score').textContent) > beforeFlick,
  beforeFlick + ' -> ' + el('hud-score').textContent);

['ctl-left', 'ctl-right', 'ctl-down', 'ctl-cw', 'ctl-ccw'].forEach((id) => {
  el(id).fire('pointerdown', { pointerId: 9 });
  el(id).fire('pointerup', { pointerId: 9 });
});
for (let i = 0; i < 20; i++) tick(16);
check('thumb controls did not break the run', !visible('ov-gameover'));

el('btn-mute').fire('click');
check('mute persists', store.get('clogged.muted') === 'true', store.get('clogged.muted'));
check('mute glyph updates', el('btn-mute').textContent === '🔇', el('btn-mute').textContent);
el('btn-mute').fire('click');
check('unmute glyph restores', el('btn-mute').textContent === '🔊');

/* ------------------------------------------------- restart / quit / lose */
const scoreBeforeRestart = Number(el('hud-score').textContent);
const bestBeforeRestart = Number(store.get('clogged.best') || 0);
el('btn-pause').fire('click');
el('btn-restart').fire('click');
tick(16);
check('restart resets the score', el('hud-score').textContent === '0',
  el('hud-score').textContent);
check('restart closes overlays', !visible('ov-pause') && !visible('ov-menu'));
// Restarting must bank the run first, or the score is silently lost.
check('restart does not discard the run from the best score',
  Number(store.get('clogged.best') || 0) >= Math.max(scoreBeforeRestart, bestBeforeRestart),
  'run=' + scoreBeforeRestart + ' bestBefore=' + bestBeforeRestart +
  ' bestAfter=' + store.get('clogged.best'));

el('btn-pause').fire('click');
el('btn-quit').fire('click');
check('quit returns to menu', visible('ov-menu'));

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

/* --------------------------------------------------------------- report */
if (problems.length) {
  console.error('SMOKE FAILED (' + problems.length + ')');
  problems.forEach((p) => console.error('  ✗ ' + p));
  process.exit(1);
}
console.log('smoke ok — boots, wins two levels, pauses, gestures, restarts, loses cleanly');
