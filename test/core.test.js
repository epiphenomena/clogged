/* Tests for the pure game core. Run: node test/core.test.js */
'use strict';
const C = require('../core.js');

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

const seg = (color, link) => ({ color, type: 'segment', link: link || null });
const clog = (color) => ({ color, type: 'clog', link: null });

function put(board, c, r, cell) { board[C.idx(c, r)] = cell; return board; }
function at(board, c, r) { return board[C.idx(c, r)]; }
// Deterministic PRNG so seeding tests are reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/* ------------------------------------------------------------ matching */
{
  const b = C.makeBoard();
  for (let c = 0; c < 4; c++) put(b, c, 10, seg(1));
  const hits = C.findMatches(b);
  eq('horizontal run of 4 matches', hits.size, 4);
}
{
  const b = C.makeBoard();
  for (let c = 0; c < 3; c++) put(b, c, 10, seg(1));
  eq('run of 3 does not match', C.findMatches(b).size, 0);
}
{
  const b = C.makeBoard();
  for (let r = 5; r < 10; r++) put(b, 2, r, clog(0));
  eq('vertical run of 5 matches', C.findMatches(b).size, 5);
}
{
  const b = C.makeBoard();
  for (let c = 0; c < 4; c++) put(b, c, 10, seg(2));
  for (let r = 7; r < 10; r++) put(b, 3, r, seg(2));
  const hits = C.findMatches(b);
  eq('cell in both axes counted once', hits.size, 7);
}
{
  const b = C.makeBoard();
  put(b, 0, 10, seg(0)); put(b, 1, 10, seg(1));
  put(b, 2, 10, seg(0)); put(b, 3, 10, seg(0));
  eq('mixed colours do not match', C.findMatches(b).size, 0);
}
{
  // A run must not wrap from the end of one row to the start of the next.
  const b = C.makeBoard();
  put(b, 6, 8, seg(1)); put(b, 7, 8, seg(1));
  put(b, 0, 9, seg(1)); put(b, 1, 9, seg(1));
  eq('runs do not wrap across rows', C.findMatches(b).size, 0);
}

/* ------------------------------------------------- clearing and orphaning */
{
  const b = C.makeBoard();
  for (let c = 0; c < 4; c++) put(b, c, 10, clog(1));
  // A vertical coupler whose lower half sits in the matched row.
  put(b, 2, 9, seg(2, 'down'));
  put(b, 2, 10, seg(1, 'up'));
  // (2,10) is part of the run, so it gets replaced by the coupler half.
  const hits = C.findMatches(b);
  const got = C.clearMatches(b, hits);
  eq('clog count from mixed clear', got.clogs, 3);
  eq('segment count from mixed clear', got.segments, 1);
  eq('surviving half is orphaned', at(b, 2, 9).link, null);
  check('cleared cells are emptied', at(b, 0, 10) === null && at(b, 2, 10) === null);
}
{
  // Both halves cleared together: no dangling link, no crash.
  const b = C.makeBoard();
  put(b, 0, 10, seg(1, 'right'));
  put(b, 1, 10, seg(1, 'left'));
  put(b, 2, 10, seg(1)); put(b, 3, 10, seg(1));
  C.clearMatches(b, C.findMatches(b));
  eq('whole row cleared', b.filter(Boolean).length, 0);
}

/* ------------------------------------------------------------- gravity */
{
  const b = C.makeBoard();
  put(b, 3, 2, seg(0));
  C.settle(b);
  check('lone segment falls to floor', at(b, 3, C.H - 1) !== null && at(b, 3, 2) === null);
}
{
  const b = C.makeBoard();
  put(b, 3, 5, clog(0));
  C.settle(b);
  check('grime never falls', at(b, 3, 5) !== null);
}
{
  // Horizontal coupler with only one supported half must not tip or split.
  const b = C.makeBoard();
  put(b, 3, C.H - 1, clog(0));
  put(b, 3, 8, seg(1, 'right'));
  put(b, 4, 8, seg(2, 'left'));
  C.settle(b);
  eq('coupler rests on the taller side', C.rowOf(b.indexOf(at(b, 3, C.H - 2))), C.H - 2);
  check('coupler halves stay level', at(b, 3, C.H - 2) !== null && at(b, 4, C.H - 2) !== null);
}
{
  // Orphaned single falls past the row where its old partner stopped.
  const b = C.makeBoard();
  put(b, 5, C.H - 1, clog(0));
  put(b, 4, 6, seg(1));
  C.settle(b);
  check('orphan falls to its own column floor', at(b, 4, C.H - 1) !== null);
}
{
  const b = C.makeBoard();
  put(b, 2, 4, seg(1, 'down'));
  put(b, 2, 5, seg(2, 'up'));
  C.settle(b);
  check('vertical coupler keeps its order',
    at(b, 2, C.H - 2).color === 1 && at(b, 2, C.H - 1).color === 2);
}

/* ------------------------------------------------------------- cascades */
{
  // Only the bottom row matches at first. Clearing it drops three segments one
  // row and a fourth from higher up, which together form the second match.
  const b = C.makeBoard();
  for (let c = 0; c < 4; c++) put(b, c, C.H - 1, seg(0));
  for (let c = 0; c < 3; c++) put(b, c, C.H - 2, seg(1));
  put(b, 3, C.H - 3, seg(1));
  eq('only one run is live at the start', C.findMatches(b).size, 4);
  const res = C.resolve(b);
  eq('cascade runs two chain steps', res.chain, 2);
  eq('cascade clears everything', b.filter(Boolean).length, 0);
}
{
  const b = C.makeBoard();
  put(b, 0, 0, seg(0));
  const res = C.resolve(b);
  eq('no match means no chain', res.chain, 0);
}

/* --------------------------------------------------------------- pieces */
{
  const p = C.spawnPiece([0, 1]);
  const cells = C.pieceCells(p);
  eq('spawn is horizontal', cells[1].c - cells[0].c, 1);
  eq('anchor links right', cells[0].link, 'right');
  eq('partner links back', cells[1].link, 'left');
}
{
  const b = C.makeBoard();
  const p = { c: C.W - 1, r: 5, orient: 1, colors: [0, 1] }; // vertical, flush right
  const rotated = C.tryRotate(b, p, 1);
  check('rotation kicks off the right wall', rotated !== null);
  const cells = C.pieceCells(rotated);
  check('kicked piece is in bounds', cells.every(c => C.inBounds(c.c, c.r)));
}
{
  const b = C.makeBoard();
  const p = { c: 3, r: 0, orient: 0, colors: [0, 1] };
  const rotated = C.tryRotate(b, p, 1); // would need row -1
  check('rotation at the ceiling kicks down instead of failing', rotated !== null);
  check('no cell above the board', C.pieceCells(rotated).every(c => c.r >= 0));
}
{
  const b = C.makeBoard();
  const p = C.spawnPiece([0, 1]);
  eq('drop distance on an empty board', C.dropDistance(b, p), C.H - 1);
  const dropped = C.tryMove(b, p, 0, C.dropDistance(b, p));
  C.lockPiece(b, dropped);
  check('locked piece sits on the floor',
    at(b, 3, C.H - 1) !== null && at(b, 4, C.H - 1) !== null);
  eq('locked halves keep their link', at(b, 3, C.H - 1).link, 'right');
  eq('locked cells are segments', at(b, 3, C.H - 1).type, 'segment');
}
{
  const b = C.makeBoard();
  put(b, 3, 0, seg(0));
  check('blocked spawn is detected', C.fits(b, C.spawnPiece([0, 1])) === false);
}

/* -------------------------------------------------------------- seeding */
{
  for (let level = 0; level <= C.MAX_LEVEL; level++) {
    const { board: b, pending } = C.seedLevel(level, lcg(level + 1));
    eq('level ' + level + ' seeds and queues its whole quota',
      C.countClogs(b) + pending.length, C.clogTotal(level));
    eq('level ' + level + ' starts with only a readable handful',
      C.countClogs(b), Math.min(C.clogTotal(level), C.clogSeedCount(level)));
    eq('level ' + level + ' opens with no free match', C.findMatches(b).size, 0);
    const top = C.seedTopRow(level);
    const topRowsClear = b.slice(0, top * C.W).every(x => x === null);
    check('level ' + level + ' keeps everything above row ' + top + ' clear', topRowsClear);
    const noTriples = b.every((cell, i) =>
      !cell || C.runThrough(b, C.colOf(i), C.rowOf(i)) < 3);
    check('level ' + level + ' has no 3-in-a-line at seed', noTriples);

    // No colour may run away with a level.
    const tally = [0, 0, 0];
    b.forEach((cell) => { if (cell) tally[cell.color]++; });
    pending.forEach((c) => { tally[c]++; });
    const spread = Math.max(...tally) - Math.min(...tally);
    check('level ' + level + ' spreads its colours evenly', spread <= 1,
      'tally=' + tally.join(','));
  }
}
{
  eq('level 0 clog count', C.clogTotal(0), 4);
  check('the clog count is capped', C.clogTotal(C.MAX_LEVEL) <= 40);

  // Difficulty must climb, but gently.
  check('each level adds only a couple of clogs',
    C.clogTotal(5) - C.clogTotal(4) <= 2,
    C.clogTotal(4) + ' -> ' + C.clogTotal(5));
  check('a mid level is far lighter than it used to be', C.clogTotal(10) < 44,
    'total=' + C.clogTotal(10));
  check('clog totals never decrease with level',
    Array.from({ length: C.MAX_LEVEL }, (_, i) => C.clogTotal(i + 1) >= C.clogTotal(i))
      .every(Boolean));

  // Later levels hold more of their quota back rather than showing it all.
  check('a hard level opens with fewer clogs than it holds',
    C.clogSeedCount(C.MAX_LEVEL) < C.clogTotal(C.MAX_LEVEL),
    C.clogSeedCount(C.MAX_LEVEL) + ' of ' + C.clogTotal(C.MAX_LEVEL));
  check('an easy level has nothing held back',
    C.clogSeedCount(0) === C.clogTotal(0));
  check('arrivals come faster on harder levels',
    C.dripEvery(C.MAX_LEVEL) < C.dripEvery(0),
    C.dripEvery(0) + ' -> ' + C.dripEvery(C.MAX_LEVEL));
  check('arrivals are never every single piece', C.dripEvery(C.MAX_LEVEL) >= 2);
}

/* ------------------------------------------------------- colour balance */
{
  const rand = lcg(11);
  for (const n of [0, 1, 2, 3, 7, 12, 40]) {
    const list = C.balancedColors(n, rand);
    eq('balanced colours returns ' + n + ' entries', list.length, n);
    const tally = [0, 0, 0];
    list.forEach((c) => tally[c]++);
    check('a run of ' + n + ' is evenly spread',
      n === 0 || Math.max(...tally) - Math.min(...tally) <= 1, tally.join(','));
    check('every entry is a real colour',
      list.every((c) => c >= 0 && c < C.COLORS), list.join(','));
  }
  // Which colour gets a remainder should not always be the same one. (Seeds are
  // spread widely on purpose: consecutive lcg seeds share almost the same first
  // value, which would make this look broken when it is not.)
  const spares = new Set();
  const spread = lcg(20260918);
  for (let i = 0; i < 40; i++) {
    const t = [0, 0, 0];
    C.balancedColors(4, spread).forEach((c) => t[c]++);
    spares.add(t.indexOf(2));
  }
  check('the spare colour varies between levels', spares.size > 1,
    [...spares].join(','));
}

/* ------------------------------------------------------------- arrivals */
{
  const b = C.makeBoard();
  eq('a clog falls to the floor of an empty column', C.dripLanding(b, 3), C.H - 1);

  put(b, 3, C.H - 1, clog(0));
  eq('it rests on whatever is already there', C.dripLanding(b, 3), C.H - 2);

  for (let r = 0; r < C.H; r++) put(b, 5, r, seg(1));
  eq('a full column takes no more', C.dripLanding(b, 5), -1);
  eq('an out-of-range column is refused', C.dripLanding(b, 99), -1);

  // It should settle low, not perch on top of the tallest pile.
  const board2 = C.makeBoard();
  for (let r = 1; r < C.H; r++) put(board2, 0, r, seg(0));
  const col = C.dripColumn(board2, lcg(5));
  check('arrivals avoid the tallest column', col !== 0, 'col=' + col);
  check('the chosen column has room', C.dripLanding(board2, col) >= 3,
    'landing=' + C.dripLanding(board2, col));

  // One clear column among shallow ones must win: a clog that lands high is
  // one nothing can ever be stacked under.
  const board5 = C.makeBoard();
  for (let c = 0; c < C.W; c++) {
    if (c === 4) continue;
    for (let r = 6; r < C.H; r++) put(board5, c, r, seg(1));
  }
  const runs = new Set();
  for (let seed = 1; seed < 40; seed++) runs.add(C.dripColumn(board5, lcg(seed * 7919)));
  check('arrivals head for the one deep column', runs.size === 1 && runs.has(4),
    'columns chosen=' + [...runs].join(','));

  // Among equally deep columns it should not always pick the same one.
  const board6 = C.makeBoard();
  for (let c = 0; c < C.W; c++) put(board6, c, C.H - 1, seg(0));
  const varied = new Set();
  for (let seed = 1; seed < 60; seed++) varied.add(C.dripColumn(board6, lcg(seed * 7919)));
  check('level ground still varies the column', varied.size > 2,
    'columns chosen=' + [...varied].join(','));

  // With everything nearly full it still finds the deepest option.
  const board3 = C.makeBoard();
  for (let c = 0; c < C.W; c++) {
    for (let r = (c === 6 ? 4 : 1); r < C.H; r++) put(board3, c, r, seg(2));
  }
  eq('when the pipe is packed it picks the deepest column',
    C.dripColumn(board3, lcg(3)), 6);

  const board4 = C.makeBoard();
  check('placing an arrival works', C.placeClog(board4, 2, 9, 1));
  eq('the arrival becomes a clog', board4[C.idx(2, 9)].type, 'clog');
  eq('the arrival keeps its colour', board4[C.idx(2, 9)].color, 1);
  eq('an arrival never falls afterwards',
    (C.settle(board4), C.rowOf(board4.indexOf(board4[C.idx(2, 9)]))), 9);
  check('placing off the board is refused', !C.placeClog(board4, 2, -1, 0));
}
{
  check('speed increases with level', C.fallInterval(5) < C.fallInterval(0));
  check('speed has a floor', C.fallInterval(99) >= 70);
}

/* ------------------------------------------------- seed depth and pressure */
{
  // Clogs start low and only climb as levels get harder.
  check('level 0 grime sits in the bottom of the pipe', C.seedTopRow(0) >= 11,
    'topRow=' + C.seedTopRow(0));
  check('harder levels allow grime higher up', C.seedTopRow(20) < C.seedTopRow(0));
  check('grime never reaches the spawn rows', C.seedTopRow(20) >= 5,
    'topRow=' + C.seedTopRow(20));

  // Every level must have room to place its full complement without the
  // no-3-in-a-line rule starving the placement loop.
  for (let level = 0; level <= C.MAX_LEVEL; level++) {
    const capacity = (C.H - C.seedTopRow(level)) * C.W;
    check('level ' + level + ' has room for the clogs it seeds',
      C.clogSeedCount(level) <= capacity * 0.8,
      C.clogSeedCount(level) + ' of ' + capacity);
  }

  // Pressure is for stalling, so ordinary play must never feel it.
  const grace = C.pressureGrace(0);
  const fresh = C.fallInterval(0, 0);
  eq('a fresh level has no pressure', C.pressureStep(0, 0), 0);
  eq('no pressure part way through the grace period',
    C.pressureStep(0, grace / 2), 0);
  eq('no pressure right up to the end of the grace period',
    C.pressureStep(0, grace - 1), 0);
  check('a full minute of grace at least', grace >= 60000, 'grace=' + grace);
  check('speed is untouched during the grace period',
    C.fallInterval(0, grace - 1) === fresh,
    fresh + ' -> ' + C.fallInterval(0, grace - 1));

  // Harder levels legitimately take longer, so they get longer before it bites.
  check('a harder level gets more grace', C.pressureGrace(20) > C.pressureGrace(0),
    C.pressureGrace(0) + ' -> ' + C.pressureGrace(20));
  eq('no pressure on a long level inside its own grace',
    C.pressureStep(20, C.pressureGrace(0) + 1000), 0);

  // Then it builds, one gentle step at a time.
  eq('pressure starts when the grace period ends', C.pressureStep(0, grace), 1);
  eq('pressure rises one step per interval',
    C.pressureStep(0, grace + C.PRESSURE_STEP_MS * 3), 4);
  eq('pressure is capped', C.pressureStep(0, grace + C.PRESSURE_STEP_MS * 999),
    C.PRESSURE_MAX_STEPS);
  check('pressure speeds the fall once it starts',
    C.fallInterval(0, grace + C.PRESSURE_STEP_MS) < fresh,
    fresh + ' -> ' + C.fallInterval(0, grace + C.PRESSURE_STEP_MS));

  // Each step is a nudge, not a cliff.
  check('one step changes the fall by only a few percent',
    C.fallInterval(0, grace) > fresh * 0.9,
    fresh + ' -> ' + C.fallInterval(0, grace));
  const maxed = C.fallInterval(0, grace + C.PRESSURE_STEP_MS * 999);
  check('even fully wound up it stays under twice the speed',
    maxed > fresh / 2, fresh + ' -> ' + maxed);
  check('fully wound up is still faster than the start', maxed < fresh,
    fresh + ' -> ' + maxed);

  // Reaching the cap should take minutes of stalling, not seconds.
  const toCap = grace + C.PRESSURE_STEP_MS * (C.PRESSURE_MAX_STEPS - 1);
  check('reaching full pressure takes over four minutes', toCap > 240000,
    'toCap=' + Math.round(toCap / 1000) + 's');
}

/* ---------------------------------------------------------------- report */
if (failures.length) {
  console.error('FAILED (' + failures.length + ' of ' + (passed + failures.length) + ')');
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('ok — ' + passed + ' assertions passed');
