/*
 * Clogged — pure game core.
 * No DOM, no globals beyond the export. Everything here is a plain function
 * over a board array so it can be unit-tested in node (see test/core.test.js).
 *
 * A board is a flat array of w*h slots carrying its own `w` and `h`, since the
 * pipe is a different size at different levels. Each slot is null or:
 *   { color: 0|1|2, type: 'clog'|'segment', link: 'left'|'right'|'up'|'down'|null }
 * `link` points at the other half of a coupler. Clogs never move; segments fall.
 * When one half of a coupler is dissolved the survivor's link is cleared, which
 * turns it into a free single that falls on its own.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Core = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // The pipe the game opens with. Later levels use a wider, proportionally
  // taller one — same viewport, smaller fittings, more room to work in.
  var BASE_W = 8;
  var BASE_H = 16;
  var SIZES = [
    { from: 0, w: 8, h: 16 },
    { from: 5, w: 10, h: 20 },
    { from: 10, w: 12, h: 24 }
  ];
  var MAX_W = 12;
  var MAX_H = 24;

  var COLORS = 3;
  var MIN_RUN = 4;
  var MAX_LEVEL = 20;
  // Pressure is meant to punish stalling, not ordinary play. Nothing happens at
  // all until the grace period is up, and a big level buys more of it, since
  // clearing 40 clogs honestly takes far longer than clearing 4.
  var PRESSURE_GRACE_MS = 60000;
  var PRESSURE_GRACE_PER_LEVEL_MS = 4000;
  var PRESSURE_STEP_MS = 30000;   // then one step every 30s
  var PRESSURE_FACTOR = 0.95;     // each step shaves 5% off the fall interval
  var PRESSURE_MAX_STEPS = 10;    // ~1.7x at the very top, reached after ~5.5 min

  var DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
  var OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' };
  // Orientation 0..3 = partner sits right / above / left / below the anchor.
  var OFFSETS = [[1, 0], [0, -1], [-1, 0], [0, 1]];
  var LINKS = ['right', 'up', 'left', 'down'];

  function dimsFor(level) {
    var pick = SIZES[0];
    for (var i = 1; i < SIZES.length; i++) {
      if ((level || 0) >= SIZES[i].from) pick = SIZES[i];
    }
    return { w: pick.w, h: pick.h };
  }

  // Every board carries its geometry with it. A board that has lost those
  // properties — rebuilt with map() or filter(), say — would make every index
  // calculation quietly wrong, so this refuses instead of assuming a size.
  function dims(board) {
    if (!board || !board.w || !board.h) throw new Error('board has no dimensions');
    return board;
  }

  function makeBoard(w, h) {
    var cols = w || BASE_W, rows = h || BASE_H;
    var board = new Array(cols * rows).fill(null);
    board.w = cols;
    board.h = rows;
    return board;
  }

  function makeBoardFor(level) {
    var d = dimsFor(level);
    return makeBoard(d.w, d.h);
  }

  // A copy that keeps its geometry, for callers that want to try something out
  // on a throwaway board.
  function cloneBoard(board) {
    var d = dims(board);
    var out = makeBoard(d.w, d.h);
    for (var i = 0; i < board.length; i++) {
      var cell = board[i];
      out[i] = cell ? { color: cell.color, type: cell.type, link: cell.link } : null;
    }
    return out;
  }

  function idx(board, c, r) { return r * dims(board).w + c; }
  function colOf(board, i) { return i % dims(board).w; }
  function rowOf(board, i) { return (i / dims(board).w) | 0; }

  function inBounds(board, c, r) {
    var d = dims(board);
    return c >= 0 && c < d.w && r >= 0 && r < d.h;
  }

  function cellAt(board, c, r) {
    return inBounds(board, c, r) ? board[idx(board, c, r)] : null;
  }

  function partnerIndex(board, i, link) {
    if (!link) return -1;
    var d = DIRS[link];
    var c = colOf(board, i) + d[0];
    var r = rowOf(board, i) + d[1];
    return inBounds(board, c, r) ? idx(board, c, r) : -1;
  }

  /* ---------------------------------------------------------------- matching */

  // Every cell belonging to a run of `min` or more same-coloured cells,
  // scanned across and down. A cell in both directions is reported once.
  function findMatches(board, min) {
    min = min || MIN_RUN;
    var d = dims(board), W = d.w, H = d.h;
    var hits = new Set();
    var r, c, run, i;

    for (r = 0; r < H; r++) {
      run = 1;
      for (c = 1; c <= W; c++) {
        var a = board[r * W + c - 1];
        var b = c < W ? board[r * W + c] : null;
        if (a && b && a.color === b.color) {
          run++;
        } else {
          if (a && run >= min) for (i = 0; i < run; i++) hits.add(r * W + c - 1 - i);
          run = 1;
        }
      }
    }
    for (c = 0; c < W; c++) {
      run = 1;
      for (r = 1; r <= H; r++) {
        var u = board[(r - 1) * W + c];
        var dn = r < H ? board[r * W + c] : null;
        if (u && dn && u.color === dn.color) {
          run++;
        } else {
          if (u && run >= min) for (i = 0; i < run; i++) hits.add((r - 1 - i) * W + c);
          run = 1;
        }
      }
    }
    return hits;
  }

  // Removes every hit cell, orphaning the surviving half of any broken coupler.
  function clearMatches(board, hits) {
    var clogs = 0, segments = 0;
    hits.forEach(function (i) {
      var cell = board[i];
      if (!cell) return;
      if (cell.type === 'clog') clogs++; else segments++;
    });
    hits.forEach(function (i) {
      var cell = board[i];
      if (!cell || !cell.link) return;
      var p = partnerIndex(board, i, cell.link);
      if (p >= 0 && board[p] && !hits.has(p)) board[p].link = null;
    });
    hits.forEach(function (i) { board[i] = null; });
    return { clogs: clogs, segments: segments };
  }

  /* ---------------------------------------------------------------- gravity */

  // Drops every unsupported segment by exactly one row. Coupler halves move as
  // a unit: a pair only falls if both destinations are free. Returns true if
  // anything moved, so the caller can animate one row per tick.
  function gravityStep(board) {
    var d = dims(board), W = d.w, H = d.h;
    var settledInto = new Set();
    var any = false;

    for (var r = H - 2; r >= 0; r--) {
      for (var c = 0; c < W; c++) {
        var i = r * W + c;
        var cell = board[i];
        if (!cell || cell.type !== 'segment' || settledInto.has(i)) continue;

        var group = [i];
        if (cell.link) {
          var p = partnerIndex(board, i, cell.link);
          if (p >= 0 && board[p]) group.push(p);
        }
        if (group.length > 1 && settledInto.has(group[1])) continue;

        var ok = true;
        for (var g = 0; g < group.length; g++) {
          var gr = (group[g] / W) | 0;
          if (gr + 1 >= H) { ok = false; break; }
          var target = group[g] + W;
          if (board[target] && group.indexOf(target) === -1) { ok = false; break; }
        }
        if (!ok) continue;

        group.sort(function (a, b) { return b - a; }); // bottom-most first
        for (var k = 0; k < group.length; k++) {
          var from = group[k];
          var to = from + W;
          board[to] = board[from];
          board[from] = null;
          settledInto.add(to);
        }
        any = true;
      }
    }
    return any;
  }

  function settle(board) {
    var steps = 0;
    while (gravityStep(board)) steps++;
    return steps;
  }

  // Full clear/gravity cascade, used by tests and headless simulation.
  // The live game runs the same sequence one animated step at a time.
  function resolve(board) {
    var chain = 0, clogs = 0, segments = 0;
    for (;;) {
      var hits = findMatches(board);
      if (hits.size === 0) break;
      chain++;
      var got = clearMatches(board, hits);
      clogs += got.clogs;
      segments += got.segments;
      settle(board);
    }
    return { chain: chain, clogs: clogs, segments: segments };
  }

  /* ---------------------------------------------------------------- pieces */

  function pieceCells(p) {
    var off = OFFSETS[p.orient];
    var link = LINKS[p.orient];
    return [
      { c: p.c, r: p.r, color: p.colors[0], link: link },
      { c: p.c + off[0], r: p.r + off[1], color: p.colors[1], link: OPPOSITE[link] }
    ];
  }

  function canPlace(board, cells) {
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (!inBounds(board, cell.c, cell.r)) return false;
      if (board[idx(board, cell.c, cell.r)]) return false;
    }
    return true;
  }

  function fits(board, p) { return canPlace(board, pieceCells(p)); }

  function movedPiece(p, dc, dr, orient) {
    return {
      c: p.c + dc,
      r: p.r + dr,
      orient: orient === undefined ? p.orient : orient,
      colors: p.colors
    };
  }

  function tryMove(board, p, dc, dr) {
    var next = movedPiece(p, dc, dr);
    return fits(board, next) ? next : null;
  }

  /*
   * Rotation in a confined space.
   *
   * A quarter turn leaves the anchor where it is and swings the partner around
   * it. When the partner's destination is taken, the pair may shift by one cell
   * — a kick — and the offsets are tried in a fixed order so the same situation
   * always resolves the same way:
   *
   *   1. in place;
   *   2. one cell away from whatever is in the way — sideways when the coupling
   *      is lying down against a wall or a stack, upward when it is standing up
   *      off the floor;
   *   3. one cell sideways, for a standing turn that is pinched between
   *      neighbours.
   *
   * A kick never moves the pair downward: gaining a row on a turn would let a
   * coupling slip past a slot the player could still have slid into. The sole
   * exception is the mouth of the pipe, where there is no row above to borrow,
   * so a coupling at row 0 drops one row in order to stand up.
   *
   * Anything still blocked after that is refused and the coupling keeps its
   * current orientation — in a one-wide well, with no room on either side at
   * its own row or the row above, it simply stays lying down.
   */
  function kicksFor(p, orient) {
    var off = OFFSETS[orient];
    var list = [[0, 0]];
    if (off[0] !== 0) {           // turning to lie down
      list.push([-off[0], 0]);    // pull back off the wall or the stack
      list.push([0, -1]);         // or lift a row and turn above the blockage
    } else if (off[1] > 0) {      // standing up with the partner below
      list.push([0, -1]);         // floor kick
      list.push([-1, 0], [1, 0]);
    } else {                      // standing up with the partner above
      list.push([-1, 0], [1, 0]);
    }
    if (p.r === 0) list.push([0, 1]);
    return list;
  }

  function tryRotate(board, p, dir) {
    var orient = (p.orient + (dir > 0 ? 1 : 3)) % 4;
    var kicks = kicksFor(p, orient);
    for (var i = 0; i < kicks.length; i++) {
      var next = movedPiece(p, kicks[i][0], kicks[i][1], orient);
      if (fits(board, next)) return next;
    }
    return null;
  }

  function dropDistance(board, p) {
    var n = 0;
    while (fits(board, movedPiece(p, 0, n + 1))) n++;
    return n;
  }

  function lockPiece(board, p) {
    var cells = pieceCells(p);
    var written = [];
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (!inBounds(board, cell.c, cell.r)) continue;
      var at = idx(board, cell.c, cell.r);
      board[at] = { color: cell.color, type: 'segment', link: cell.link };
      written.push(at);
    }
    // A half that landed out of bounds leaves its partner as a free single.
    if (written.length === 1) board[written[0]].link = null;
    return written;
  }

  function spawnPiece(board, colors) {
    return { c: (dims(board).w >> 1) - 1, r: 0, orient: 0, colors: colors };
  }

  function randomColors(rand) {
    rand = rand || Math.random;
    return [(rand() * COLORS) | 0, (rand() * COLORS) | 0];
  }

  /* ---------------------------------------------------------------- seeding */

  // Longest same-colour run through (c,r) in either axis.
  function runThrough(board, c, r) {
    var cell = cellAt(board, c, r);
    if (!cell) return 0;
    var best = 0;
    var axes = [[1, 0], [0, 1]];
    for (var a = 0; a < axes.length; a++) {
      var dx = axes[a][0], dy = axes[a][1];
      var n = 1, k;
      for (k = 1; ; k++) {
        var f = cellAt(board, c + dx * k, r + dy * k);
        if (!f || f.color !== cell.color) break;
        n++;
      }
      for (k = 1; ; k++) {
        var b = cellAt(board, c - dx * k, r - dy * k);
        if (!b || b.color !== cell.color) break;
        n++;
      }
      if (n > best) best = n;
    }
    return best;
  }

  // The whole quota for a level, seeded and dripped together. This used to add
  // four per level up to 64, which outran the player badly.
  function clogTotal(level) {
    return Math.min(4 + level * 2, 40);
  }

  // How much of the quota is already wedged in when the level opens. The share
  // shrinks as the levels get harder, so a hard level starts on a board you can
  // still read and the rest wash down while it is played.
  var SEED_SHARE_BASE = 0.9;
  var SEED_SHARE_PER_LEVEL = 0.05;
  var SEED_SHARE_MIN = 0.35;

  function clogSeedCount(level) {
    var total = clogTotal(level);
    var share = Math.max(SEED_SHARE_MIN,
      SEED_SHARE_BASE - Math.max(0, level || 0) * SEED_SHARE_PER_LEVEL);
    return Math.max(2, Math.min(total, Math.round(total * share)));
  }

  // Couplings landed between one arrival and the next.
  function dripEvery(level) {
    return Math.max(2, 4 - Math.floor(level / 8));
  }

  function shuffle(list, rand) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = (rand() * (i + 1)) | 0;
      var t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }

  // A level's colours, spread as evenly as the count allows, so no single
  // colour can dominate and strand the others.
  function balancedColors(n, rand) {
    rand = rand || Math.random;
    var offset = (rand() * COLORS) | 0;
    var out = [];
    for (var i = 0; i < n; i++) out.push((i + offset) % COLORS);
    return shuffle(out, rand);
  }

  /* ------------------------------------------------------------- arrivals */

  // Where a clog dropped down this column comes to rest: the last free row
  // before something blocks it. -1 when the column is full to the top.
  function dripLanding(board, col) {
    var d = dims(board), W = d.w, H = d.h;
    if (col < 0 || col >= W || board[col]) return -1;
    var r = 0;
    while (r + 1 < H && !board[(r + 1) * W + col]) r++;
    return r;
  }

  // Arrivals aim for the deepest part of the pipe, so they settle low instead of
  // perching on the shoulders of a tall pile where nothing can be built under
  // them. Ties within a couple of rows keep the column from being predictable.
  var DRIP_DEPTH_SLACK = 2;
  // A falling clog can catch on something it brushes past on the way down, but
  // only in the lower half of the pipe, where a line can still be built
  // through it.
  var DRIP_SNAG_CHANCE = 0.5;

  function snagMinRow(h) { return Math.ceil(h / 2); }

  function dripColumn(board, rand) {
    rand = rand || Math.random;
    var W = dims(board).w;
    var landings = [], deepest = -1;
    for (var c = 0; c < W; c++) {
      var r = dripLanding(board, c);
      landings.push(r);
      if (r > deepest) deepest = r;
    }
    if (deepest < 0) return -1;

    var near = [];
    for (var k = 0; k < W; k++) {
      if (landings[k] >= deepest - DRIP_DEPTH_SLACK) near.push(k);
    }
    return near[(rand() * near.length) | 0];
  }

  // Every row on the way down where the clog would be rubbing against
  // something to its left or right, and is still low enough to be worth having.
  function dripSnagRows(board, col, landing) {
    var d = dims(board), W = d.w;
    var rows = [];
    for (var r = snagMinRow(d.h); r < landing; r++) {
      if (board[r * W + col]) continue;
      var left = col > 0 && board[r * W + col - 1];
      var right = col < W - 1 && board[r * W + col + 1];
      if (left || right) rows.push(r);
    }
    return rows;
  }

  // Where a falling clog actually ends up: usually resting on the stack, but
  // sometimes wedged partway down against a neighbour.
  function dripTarget(board, col, rand) {
    rand = rand || Math.random;
    var landing = dripLanding(board, col);
    if (landing < 0) return -1;
    var snags = dripSnagRows(board, col, landing);
    if (!snags.length || rand() >= DRIP_SNAG_CHANCE) return landing;
    return snags[(rand() * snags.length) | 0];
  }

  function placeClog(board, col, row, color) {
    if (!inBounds(board, col, row)) return false;
    board[idx(board, col, row)] = { color: color, type: 'clog', link: null };
    return true;
  }

  // Clogs sit in the bottom of the pipe. Seeding them high makes them nearly
  // unreachable, since nothing can be stacked underneath a clog to build a line
  // through it, so the band they may occupy is measured up from the floor,
  // grows a row every three levels, and never covers more than the bottom two
  // fifths of the pipe however long the game runs.
  var SEED_BAND_MIN = 3;
  var SEED_BAND_LEVELS = 3;
  var SEED_BAND_SHARE = 0.4;

  function seedBand(level, h) {
    var rows = SEED_BAND_MIN + Math.floor(Math.max(0, level || 0) / SEED_BAND_LEVELS);
    return Math.max(1, Math.min(rows, Math.floor(h * SEED_BAND_SHARE)));
  }

  function seedTopRow(level, h) {
    var rows = h || BASE_H;
    return rows - seedBand(level, rows);
  }

  // Builds a level: the pipe it is played on, the clogs wedged in at the start,
  // and the queue of those still to wash down. Nothing is placed 3-in-a-line, or
  // the level would cascade on its own the instant it opens.
  function seedLevel(level, rand) {
    rand = rand || Math.random;
    var board = makeBoardFor(level);
    var W = board.w, H = board.h;
    var quota = balancedColors(clogTotal(level), rand);
    var seedN = Math.min(quota.length, clogSeedCount(level));

    var want = [];
    for (var z = 0; z < COLORS; z++) want.push(0);
    for (var q = 0; q < seedN; q++) want[quota[q]]++;

    var top = seedTopRow(level, H);
    var slots = [];
    for (var r = top; r < H; r++) {
      for (var c = 0; c < W; c++) slots.push(r * W + c);
    }

    var placed = 0;
    var guard = slots.length * 200;
    while (placed < seedN && guard-- > 0) {
      var i = slots[(rand() * slots.length) | 0];
      if (board[i]) continue;
      var cc = i % W, rr = (i / W) | 0;

      var order = [];
      for (var k = 0; k < COLORS; k++) if (want[k] > 0) order.push(k);
      if (!order.length) break;
      shuffle(order, rand);

      for (var m = 0; m < order.length; m++) {
        board[i] = { color: order[m], type: 'clog', link: null };
        if (runThrough(board, cc, rr) < 3) { want[order[m]]--; placed++; break; }
        board[i] = null;
      }
    }

    // Anything that could not be placed joins the queue, so the level's total
    // and its colour balance hold either way.
    var pending = quota.slice(seedN);
    for (var k2 = 0; k2 < COLORS; k2++) {
      for (var n = 0; n < want[k2]; n++) pending.push(k2);
    }
    return { board: board, pending: shuffle(pending, rand) };
  }

  function countClogs(board) {
    var n = 0;
    for (var i = 0; i < board.length; i++) if (board[i] && board[i].type === 'clog') n++;
    return n;
  }

  // How long a level can run before pressure starts building at all.
  function pressureGrace(level) {
    return PRESSURE_GRACE_MS + Math.max(0, level || 0) * PRESSURE_GRACE_PER_LEVEL_MS;
  }

  // How many times pressure has risen — the game announces each increase.
  function pressureStep(level, elapsedMs) {
    var past = (elapsedMs || 0) - pressureGrace(level);
    if (past < 0) return 0;
    return Math.min(Math.floor(past / PRESSURE_STEP_MS) + 1, PRESSURE_MAX_STEPS);
  }

  var FALL_BASE_MS = 520;      // level 0, on the pipe the game opens with
  var FALL_PER_LEVEL_MS = 16;
  var FALL_FLOOR_MS = 200;

  // Milliseconds per row of free fall. A taller pipe gets a shorter interval,
  // so a coupling takes about the same time to cross the screen whatever size
  // the fittings are: the rows are smaller, not slower.
  function fallInterval(level, elapsedMs, h) {
    var base = Math.max(FALL_FLOOR_MS,
      FALL_BASE_MS - Math.max(0, level || 0) * FALL_PER_LEVEL_MS);
    var scaled = base * (BASE_H / (h || BASE_H));
    return scaled * Math.pow(PRESSURE_FACTOR, pressureStep(level, elapsedMs));
  }

  return {
    BASE_W: BASE_W, BASE_H: BASE_H, MAX_W: MAX_W, MAX_H: MAX_H,
    COLORS: COLORS, MIN_RUN: MIN_RUN, MAX_LEVEL: MAX_LEVEL,
    DIRS: DIRS, OFFSETS: OFFSETS, LINKS: LINKS, OPPOSITE: OPPOSITE,
    dimsFor: dimsFor, dims: dims,
    idx: idx, colOf: colOf, rowOf: rowOf, inBounds: inBounds, cellAt: cellAt,
    makeBoard: makeBoard, makeBoardFor: makeBoardFor, cloneBoard: cloneBoard,
    partnerIndex: partnerIndex,
    findMatches: findMatches, clearMatches: clearMatches,
    gravityStep: gravityStep, settle: settle, resolve: resolve,
    pieceCells: pieceCells, canPlace: canPlace, fits: fits,
    tryMove: tryMove, tryRotate: tryRotate, dropDistance: dropDistance,
    lockPiece: lockPiece, spawnPiece: spawnPiece, randomColors: randomColors,
    seedLevel: seedLevel, clogTotal: clogTotal, countClogs: countClogs,
    clogSeedCount: clogSeedCount, dripEvery: dripEvery, balancedColors: balancedColors,
    dripLanding: dripLanding, dripColumn: dripColumn, placeClog: placeClog,
    dripTarget: dripTarget, dripSnagRows: dripSnagRows, snagMinRow: snagMinRow,
    DRIP_SNAG_CHANCE: DRIP_SNAG_CHANCE,
    shuffle: shuffle,
    runThrough: runThrough, fallInterval: fallInterval,
    seedTopRow: seedTopRow, seedBand: seedBand,
    pressureStep: pressureStep, pressureGrace: pressureGrace,
    PRESSURE_GRACE_MS: PRESSURE_GRACE_MS,
    PRESSURE_GRACE_PER_LEVEL_MS: PRESSURE_GRACE_PER_LEVEL_MS,
    PRESSURE_STEP_MS: PRESSURE_STEP_MS,
    PRESSURE_FACTOR: PRESSURE_FACTOR,
    PRESSURE_MAX_STEPS: PRESSURE_MAX_STEPS,
    FALL_BASE_MS: FALL_BASE_MS, FALL_FLOOR_MS: FALL_FLOOR_MS
  };
});
