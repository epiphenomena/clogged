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
    const b = C.seedLevel(level, lcg(level + 1));
    eq('level ' + level + ' places the requested grime', C.countClogs(b), C.clogCount(level));
    eq('level ' + level + ' opens with no free match', C.findMatches(b).size, 0);
    const top = C.seedTopRow(level);
    const topRowsClear = b.slice(0, top * C.W).every(x => x === null);
    check('level ' + level + ' keeps everything above row ' + top + ' clear', topRowsClear);
    const noTriples = b.every((cell, i) =>
      !cell || C.runThrough(b, C.colOf(i), C.rowOf(i)) < 3);
    check('level ' + level + ' has no 3-in-a-line at seed', noTriples);
  }
}
{
  eq('level 0 grime count', C.clogCount(0), 4);
  check('grime count is capped', C.clogCount(C.MAX_LEVEL) <= 64);
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
    check('level ' + level + ' has room for its grime', C.clogCount(level) <= capacity * 0.8,
      C.clogCount(level) + ' of ' + capacity);
  }

  // Pressure: stalling on a level speeds the fall, up to a cap.
  const fresh = C.fallInterval(0, 0);
  check('pressure speeds the fall over time', C.fallInterval(0, 60000) < fresh,
    fresh + ' -> ' + C.fallInterval(0, 60000));
  check('pressure stops building at the cap',
    C.fallInterval(0, C.SPEED_RAMP_MS * 50) === C.fallInterval(0, C.SPEED_RAMP_MS * C.SPEED_RAMP_STEPS),
    String(C.fallInterval(0, C.SPEED_RAMP_MS * 50)));
  check('pressure ramp is gradual, not a cliff',
    C.fallInterval(0, C.SPEED_RAMP_MS) > fresh * 0.85,
    fresh + ' -> ' + C.fallInterval(0, C.SPEED_RAMP_MS));
  eq('pressure step counts elapsed time', C.pressureStep(C.SPEED_RAMP_MS * 3), 3);
  eq('pressure step is capped', C.pressureStep(C.SPEED_RAMP_MS * 99), C.SPEED_RAMP_STEPS);
  eq('a fresh level has no pressure', C.pressureStep(0), 0);
}

/* ---------------------------------------------------------------- report */
if (failures.length) {
  console.error('FAILED (' + failures.length + ' of ' + (passed + failures.length) + ')');
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('ok — ' + passed + ' assertions passed');
