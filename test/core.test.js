/* Tests for the pure game core. Run: node test/core.test.js */
'use strict';
const C = require('../core.js');
const W = C.BASE_W, H = C.BASE_H;   // the pipe the game opens with

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

function put(board, c, r, cell) { board[C.idx(board, c, r)] = cell; return board; }
function at(board, c, r) { return board[C.idx(board, c, r)]; }
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
  check('lone segment falls to floor', at(b, 3, H - 1) !== null && at(b, 3, 2) === null);
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
  put(b, 3, H - 1, clog(0));
  put(b, 3, 8, seg(1, 'right'));
  put(b, 4, 8, seg(2, 'left'));
  C.settle(b);
  eq('coupler rests on the taller side', C.rowOf(b, b.indexOf(at(b, 3, H - 2))), H - 2);
  check('coupler halves stay level', at(b, 3, H - 2) !== null && at(b, 4, H - 2) !== null);
}
{
  // Orphaned single falls past the row where its old partner stopped.
  const b = C.makeBoard();
  put(b, 5, H - 1, clog(0));
  put(b, 4, 6, seg(1));
  C.settle(b);
  check('orphan falls to its own column floor', at(b, 4, H - 1) !== null);
}
{
  const b = C.makeBoard();
  put(b, 2, 4, seg(1, 'down'));
  put(b, 2, 5, seg(2, 'up'));
  C.settle(b);
  check('vertical coupler keeps its order',
    at(b, 2, H - 2).color === 1 && at(b, 2, H - 1).color === 2);
}

/* ------------------------------------------------------------- cascades */
{
  // Only the bottom row matches at first. Clearing it drops three segments one
  // row and a fourth from higher up, which together form the second match.
  const b = C.makeBoard();
  for (let c = 0; c < 4; c++) put(b, c, H - 1, seg(0));
  for (let c = 0; c < 3; c++) put(b, c, H - 2, seg(1));
  put(b, 3, H - 3, seg(1));
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
  const b = C.makeBoard();
  const p = C.spawnPiece(b, [0, 1]);
  const cells = C.pieceCells(p);
  eq('spawn is horizontal', cells[1].c - cells[0].c, 1);
  eq('anchor links right', cells[0].link, 'right');
  eq('partner links back', cells[1].link, 'left');
}

/* Rotating in a confined space. One case per bullet of the documented rule,
   so the README and the kick list cannot drift apart. */
{
  // Flush against the right wall: the pair pulls back off it rather than
  // failing or hopping over it.
  const b = C.makeBoard();
  const p = { c: W - 1, r: 5, orient: 1, colors: [0, 1] }; // standing, right wall
  const rotated = C.tryRotate(b, p, -1);                     // partner wants the wall
  check('rotation kicks off the right wall', rotated !== null);
  eq('the wall kick shifts exactly one column', rotated.c, W - 2);
  check('kicked piece is in bounds',
    C.pieceCells(rotated).every(c => C.inBounds(b, c.c, c.r)));

  // And off the left wall, the same distance the other way.
  const q = { c: 0, r: 5, orient: 1, colors: [0, 1] };
  const left = C.tryRotate(b, q, 1);                         // partner wants column -1
  check('rotation kicks off the left wall', left !== null);
  eq('the left wall kick shifts one column', left.c, 1);
}
{
  // Standing up while resting on the floor: the pair lifts a row.
  const b = C.makeBoard();
  const p = { c: 3, r: H - 1, orient: 0, colors: [0, 1] }; // lying on the floor
  const up = C.tryRotate(b, p, -1);                          // partner wants the row below
  check('a coupling on the floor can still stand up', up !== null);
  eq('the floor kick lifts exactly one row', up.r, H - 2);
  eq('the anchor keeps its column', up.c, 3);
}
{
  // A kick never gains a row. Blocked above and pinched on both sides, the
  // rotation is refused — it does not drop into the gap below.
  const b = C.makeBoard();
  put(b, 3, 4, seg(0));   // directly above the anchor
  put(b, 2, 4, seg(0));   // and above both sideways kicks
  put(b, 4, 4, seg(0));
  const p = { c: 3, r: 5, orient: 0, colors: [0, 1] };
  eq('a rotation that would need to fall a row is refused', C.tryRotate(b, p, 1), null);

  // The row below is genuinely free, which is what makes this a real test.
  check('the cell it declined to drop into is empty', at(b, 3, 6) === null);
}
{
  // The one exception: at the mouth of the pipe there is no row above to
  // borrow, so a coupling there drops a row in order to stand up.
  const b = C.makeBoard();
  const p = { c: 3, r: 0, orient: 0, colors: [0, 1] };
  const rotated = C.tryRotate(b, p, 1);   // would otherwise need row -1
  check('rotation at the mouth still turns', rotated !== null);
  eq('it drops exactly one row', rotated.r, 1);
  check('no cell above the board', C.pieceCells(rotated).every(c => c.r >= 0));
}
{
  // A one-wide well: no room either side at the piece's row or the row above,
  // so the coupling stays lying down whichever way it is turned.
  const b = C.makeBoard();
  for (const c of [2, 4]) for (let r = H - 3; r < H; r++) put(b, c, r, seg(0));
  const p = { c: 3, r: H - 2, orient: 1, colors: [0, 1] }; // standing in the well
  eq('a standing coupling cannot lie down in a one-wide well',
    C.tryRotate(b, p, 1), null);
  eq('nor the other way round', C.tryRotate(b, p, -1), null);

  // Lower the well by a row and the same turn happens above it.
  const shallow = C.makeBoard();
  for (const c of [2, 4]) for (let r = H - 2; r < H; r++) put(shallow, c, r, seg(0));
  const over = C.tryRotate(shallow, p, 1);
  check('a coupling turns a row higher when the well is shallow', over !== null);
  eq('and only one row higher', over.r, H - 3);
}
{
  const b = C.makeBoard();
  const p = C.spawnPiece(b, [0, 1]);
  eq('drop distance on an empty board', C.dropDistance(b, p), H - 1);
  const dropped = C.tryMove(b, p, 0, C.dropDistance(b, p));
  C.lockPiece(b, dropped);
  check('locked piece sits on the floor',
    at(b, 3, H - 1) !== null && at(b, 4, H - 1) !== null);
  eq('locked halves keep their link', at(b, 3, H - 1).link, 'right');
  eq('locked cells are segments', at(b, 3, H - 1).type, 'segment');
}
{
  const b = C.makeBoard();
  put(b, 3, 0, seg(0));
  check('blocked spawn is detected', C.fits(b, C.spawnPiece(b, [0, 1])) === false);
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
    const top = C.seedTopRow(level, b.h);
    const topRowsClear = b.slice(0, top * b.w).every(x => x === null);
    check('level ' + level + ' keeps everything above row ' + top + ' clear', topRowsClear);
    const noTriples = b.every((cell, i) =>
      !cell || C.runThrough(b, C.colOf(b, i), C.rowOf(b, i)) < 3);
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
  eq('a clog falls to the floor of an empty column', C.dripLanding(b, 3), H - 1);

  put(b, 3, H - 1, clog(0));
  eq('it rests on whatever is already there', C.dripLanding(b, 3), H - 2);

  for (let r = 0; r < H; r++) put(b, 5, r, seg(1));
  eq('a full column takes no more', C.dripLanding(b, 5), -1);
  eq('an out-of-range column is refused', C.dripLanding(b, 99), -1);

  // It should settle low, not perch on top of the tallest pile.
  const board2 = C.makeBoard();
  for (let r = 1; r < H; r++) put(board2, 0, r, seg(0));
  const col = C.dripColumn(board2, lcg(5));
  check('arrivals avoid the tallest column', col !== 0, 'col=' + col);
  check('the chosen column has room', C.dripLanding(board2, col) >= 3,
    'landing=' + C.dripLanding(board2, col));

  // One clear column among shallow ones must win: a clog that lands high is
  // one nothing can ever be stacked under.
  const board5 = C.makeBoard();
  for (let c = 0; c < W; c++) {
    if (c === 4) continue;
    for (let r = 6; r < H; r++) put(board5, c, r, seg(1));
  }
  const runs = new Set();
  for (let seed = 1; seed < 40; seed++) runs.add(C.dripColumn(board5, lcg(seed * 7919)));
  check('arrivals head for the one deep column', runs.size === 1 && runs.has(4),
    'columns chosen=' + [...runs].join(','));

  // Among equally deep columns it should not always pick the same one.
  const board6 = C.makeBoard();
  for (let c = 0; c < W; c++) put(board6, c, H - 1, seg(0));
  const varied = new Set();
  for (let seed = 1; seed < 60; seed++) varied.add(C.dripColumn(board6, lcg(seed * 7919)));
  check('level ground still varies the column', varied.size > 2,
    'columns chosen=' + [...varied].join(','));

  // With everything nearly full it still finds the deepest option.
  const board3 = C.makeBoard();
  for (let c = 0; c < W; c++) {
    for (let r = (c === 6 ? 4 : 1); r < H; r++) put(board3, c, r, seg(2));
  }
  eq('when the pipe is packed it picks the deepest column',
    C.dripColumn(board3, lcg(3)), 6);

  // Catching on the way down: a clog brushing past a neighbour can wedge there.
  {
    const b7 = C.makeBoard();
    // A tower in column 4 gives column 3 something to rub against on the way.
    for (let r = 9; r < H; r++) put(b7, 4, r, seg(1));
    const landing = C.dripLanding(b7, 3);
    const snags = C.dripSnagRows(b7, 3, landing);
    check('there are places to catch on', snags.length > 0, 'snags=' + snags.join(','));
    check('every catch point is beside something',
      snags.every((r) => b7[C.idx(b7, 4, r)] || (r > 0 && b7[C.idx(b7, 2, r)])), snags.join(','));
    check('no catch point is above the reachable band',
      snags.every((r) => r >= C.snagMinRow(b7.h)), snags.join(','));
    check('no catch point is at or below the resting row',
      snags.every((r) => r < landing), 'landing=' + landing + ' snags=' + snags.join(','));

    // Over many arrivals it should sometimes catch and sometimes fall through.
    const seen = new Set();
    for (let i = 1; i < 200; i++) seen.add(C.dripTarget(b7, 3, lcg(i * 7919)));
    check('clogs sometimes fall all the way', seen.has(landing),
      'targets=' + [...seen].join(','));
    check('clogs sometimes catch partway down',
      [...seen].some((r) => r < landing), 'targets=' + [...seen].join(','));
    check('a caught clog is never above the reachable band',
      [...seen].every((r) => r >= C.snagMinRow(b7.h)), [...seen].join(','));
  }
  {
    // Nothing to brush against: it must fall all the way, every time.
    const b8 = C.makeBoard();
    put(b8, 6, H - 1, clog(2));
    const landing = C.dripLanding(b8, 6);
    eq('an empty neighbourhood offers nothing to catch on',
      C.dripSnagRows(b8, 6, landing).length, 0);
    const targets = new Set();
    for (let i = 1; i < 60; i++) targets.add(C.dripTarget(b8, 6, lcg(i * 7919)));
    check('with nothing alongside it always lands on the stack',
      targets.size === 1 && targets.has(landing), [...targets].join(','));
  }
  {
    // High neighbours are not catch points: a clog up there could never be cleared.
    const b9 = C.makeBoard();
    for (let r = 0; r < 6; r++) put(b9, 2, r, seg(0));
    const landing = C.dripLanding(b9, 1);
    eq('a clog will not catch high up in the pipe',
      C.dripSnagRows(b9, 1, landing).length, 0);
  }
  {
    const b10 = C.makeBoard();
    for (let r = 0; r < H; r++) put(b10, 0, r, seg(0));
    eq('a full column has no target', C.dripTarget(b10, 0, lcg(1)), -1);
  }

  const board4 = C.makeBoard();
  check('placing an arrival works', C.placeClog(board4, 2, 9, 1));
  eq('the arrival becomes a clog', board4[C.idx(board4, 2, 9)].type, 'clog');
  eq('the arrival keeps its colour', board4[C.idx(board4, 2, 9)].color, 1);
  eq('an arrival never falls afterwards',
    (C.settle(board4), C.rowOf(board4, board4.indexOf(board4[C.idx(board4, 2, 9)]))), 9);
  check('placing off the board is refused', !C.placeClog(board4, 2, -1, 0));
}
{
  const h = C.BASE_H;
  check('speed increases with level', C.fallInterval(5, 0, h) < C.fallInterval(0, 0, h));
  check('the opening level is not a crawl', C.fallInterval(0, 0, h) <= 560,
    C.fallInterval(0, 0, h) + 'ms per row');
  check('the last level is still readable',
    C.fallInterval(C.MAX_LEVEL, 0, C.dimsFor(C.MAX_LEVEL).h) >= 120,
    C.fallInterval(C.MAX_LEVEL, 0, C.dimsFor(C.MAX_LEVEL).h) + 'ms per row');
  check('speed has a floor', C.fallInterval(99, 0, h) >= C.FALL_FLOOR_MS * 0.6);

  // Every level is at least as quick as the one before, across the changes of
  // pipe size as well as within them.
  let prev = Infinity;
  for (let level = 0; level <= C.MAX_LEVEL; level++) {
    const ms = C.fallInterval(level, 0, C.dimsFor(level).h);
    check('level ' + level + ' is no slower than the one before it', ms <= prev,
      ms + ' vs ' + prev);
    prev = ms;
  }

  // A taller pipe has smaller rows, so a coupling crosses the screen in about
  // the same time rather than trudging down half again as many of them.
  const narrow = C.fallInterval(9, 0, 20) * 20;
  const wide = C.fallInterval(10, 0, 24) * 24;
  check('a coupling takes a similar time to cross either pipe',
    Math.abs(narrow - wide) / narrow < 0.25, Math.round(narrow) + 'ms vs ' + Math.round(wide) + 'ms');
}

/* -------------------------------------------------------- the pipe's size */
{
  const open = C.dimsFor(0);
  eq('the game opens on the pipe it always did',
    open.w + 'x' + open.h, C.BASE_W + 'x' + C.BASE_H);
  check('the pipe widens once the early levels are behind you',
    C.dimsFor(5).w > C.dimsFor(4).w);
  check('and widens again later on', C.dimsFor(10).w > C.dimsFor(5).w);

  for (let level = 0; level <= C.MAX_LEVEL; level++) {
    const d = C.dimsFor(level);
    eq('level ' + level + ' keeps the pipe twice as tall as it is wide', d.h, d.w * 2);
    check('level ' + level + ' fits the sizes a snapshot can hold',
      d.w <= C.MAX_W && d.h <= C.MAX_H, d.w + 'x' + d.h);
    check('the pipe never narrows as the levels go up',
      d.w >= C.dimsFor(Math.max(0, level - 1)).w);
  }

  // A board knows its own size, and everything derived from it agrees.
  const board = C.seedLevel(12, lcg(9)).board;
  eq('a seeded board carries its width', board.w, C.dimsFor(12).w);
  eq('a seeded board is exactly as long as it should be',
    board.length, board.w * board.h);
  eq('a coupling spawns mid-pipe whatever the pipe',
    C.spawnPiece(board, [0, 1]).c, (board.w >> 1) - 1);

  // Losing that geometry has to be loud: a silent fallback would leave every
  // index calculation quietly wrong.
  let threw = false;
  try { C.idx(board.filter(() => true), 0, 0); } catch (e) { threw = true; }
  check('a board that has lost its dimensions is refused, not guessed at', threw);

  const copy = C.cloneBoard(board);
  eq('a clone keeps the width', copy.w, board.w);
  eq('a clone keeps the contents', C.countClogs(copy), C.countClogs(board));
  copy[copy.length - 1] = null;
  eq('a clone does not share cells with its original',
    C.countClogs(C.cloneBoard(board)), C.countClogs(board));

  // The rules themselves have to hold on the wider pipe, not just the first one.
  const big = C.makeBoard(12, 24);
  for (let c = 0; c < 4; c++) put(big, c, 23, seg(1));
  eq('a run of four clears on the wide pipe', C.findMatches(big).size, 4);

  const edge = C.makeBoard(12, 24);
  put(edge, 10, 20, seg(1)); put(edge, 11, 20, seg(1));
  put(edge, 0, 21, seg(1)); put(edge, 1, 21, seg(1));
  eq('runs still do not wrap across rows when the pipe is wider',
    C.findMatches(edge).size, 0);

  const falling = C.makeBoard(12, 24);
  put(falling, 11, 2, seg(0));
  C.settle(falling);
  check('gravity reaches the floor of the wide pipe', at(falling, 11, 23) !== null);

  const standing = { c: 11, r: 10, orient: 1, colors: [0, 1] };
  eq('rotation kicks off the far wall of the wide pipe',
    C.tryRotate(falling, standing, -1).c, 10);

  // Arrivals only snag in the lower half, wherever that half happens to be.
  check('the snag line follows the pipe', C.snagMinRow(24) > C.snagMinRow(16));
  eq('the snag line is the middle of the pipe', C.snagMinRow(24), 12);
}

/* ------------------------------------------------- seed depth and pressure */
{
  // Clogs are wedged into the bottom of the pipe, and the band they may occupy
  // only creeps upward. Seeding them high is what made them unclearable.
  for (let level = 0; level <= C.MAX_LEVEL; level++) {
    const d = C.dimsFor(level);
    const top = C.seedTopRow(level, d.h);
    check('level ' + level + ' seeds nothing above the bottom of the pipe',
      top >= d.h * 0.6, 'topRow=' + top + ' of ' + d.h);
    check('level ' + level + ' still has a few rows to seed into',
      d.h - top >= 3, 'band=' + (d.h - top));
  }
  check('the band creeps up as the levels go on',
    C.seedBand(C.MAX_LEVEL, 24) > C.seedBand(0, 16));
  check('the band never takes over the pipe',
    C.seedBand(99, 24) <= 24 * 0.4, 'band=' + C.seedBand(99, 24));

  // Fewer are showing at the start as the levels go up, with the rest washing
  // down during play — the point of holding them back at all.
  for (let level = 1; level <= C.MAX_LEVEL; level++) {
    check('level ' + level + ' holds some clogs back for later',
      C.clogSeedCount(level) < C.clogTotal(level),
      C.clogSeedCount(level) + ' of ' + C.clogTotal(level));
  }
  check('a hard level shows a smaller share than an easy one',
    C.clogSeedCount(C.MAX_LEVEL) / C.clogTotal(C.MAX_LEVEL)
      < C.clogSeedCount(2) / C.clogTotal(2));
  check('but a hard level still opens with something to work with',
    C.clogSeedCount(C.MAX_LEVEL) >= 8, C.clogSeedCount(C.MAX_LEVEL));

  // Every level must have room to place its full complement without the
  // no-3-in-a-line rule starving the placement loop.
  for (let level = 0; level <= C.MAX_LEVEL; level++) {
    const d = C.dimsFor(level);
    const capacity = (d.h - C.seedTopRow(level, d.h)) * d.w;
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

  // The worst case the game can produce: the last level, on the tallest pipe,
  // fully wound up. Short rows make short intervals, so this is the number that
  // has to stay playable rather than the base one.
  const worst = C.fallInterval(C.MAX_LEVEL,
    C.pressureGrace(C.MAX_LEVEL) + C.PRESSURE_STEP_MS * 999,
    C.dimsFor(C.MAX_LEVEL).h);
  check('even the worst case leaves time to react', worst >= 70,
    Math.round(worst) + 'ms per row');
  check('and a coupling still takes over a second to cross the pipe',
    worst * C.dimsFor(C.MAX_LEVEL).h > 1500,
    Math.round(worst * C.dimsFor(C.MAX_LEVEL).h) + 'ms end to end');

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
