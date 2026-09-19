/*
 * Clogged — pure game core.
 * No DOM, no globals beyond the export. Everything here is a plain function
 * over a board array so it can be unit-tested in node (see test/core.test.js).
 *
 * A board is a flat array of W*H slots. Each slot is null or:
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

  var W = 8;
  var H = 16;
  var COLORS = 3;
  var MIN_RUN = 4;
  var MAX_LEVEL = 20;
  // Pressure is meant to punish stalling, not ordinary play. Nothing happens at
  // all until the grace period is up, and a big level buys more of it, since
  // clearing 64 clogs honestly takes far longer than clearing 4.
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

  function idx(c, r) { return r * W + c; }
  function colOf(i) { return i % W; }
  function rowOf(i) { return (i / W) | 0; }
  function inBounds(c, r) { return c >= 0 && c < W && r >= 0 && r < H; }

  function makeBoard() { return new Array(W * H).fill(null); }

  function cellAt(board, c, r) {
    return inBounds(c, r) ? board[idx(c, r)] : null;
  }

  function partnerIndex(i, link) {
    if (!link) return -1;
    var d = DIRS[link];
    var c = colOf(i) + d[0];
    var r = rowOf(i) + d[1];
    return inBounds(c, r) ? idx(c, r) : -1;
  }

  /* ---------------------------------------------------------------- matching */

  // Every cell belonging to a run of `min` or more same-coloured cells,
  // scanned across and down. A cell in both directions is reported once.
  function findMatches(board, min) {
    min = min || MIN_RUN;
    var hits = new Set();
    var r, c, run, i;

    for (r = 0; r < H; r++) {
      run = 1;
      for (c = 1; c <= W; c++) {
        var a = board[idx(c - 1, r)];
        var b = c < W ? board[idx(c, r)] : null;
        if (a && b && a.color === b.color) {
          run++;
        } else {
          if (a && run >= min) for (i = 0; i < run; i++) hits.add(idx(c - 1 - i, r));
          run = 1;
        }
      }
    }
    for (c = 0; c < W; c++) {
      run = 1;
      for (r = 1; r <= H; r++) {
        var u = board[idx(c, r - 1)];
        var d = r < H ? board[idx(c, r)] : null;
        if (u && d && u.color === d.color) {
          run++;
        } else {
          if (u && run >= min) for (i = 0; i < run; i++) hits.add(idx(c, r - 1 - i));
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
      var p = partnerIndex(i, cell.link);
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
    var settledInto = new Set();
    var any = false;

    for (var r = H - 2; r >= 0; r--) {
      for (var c = 0; c < W; c++) {
        var i = idx(c, r);
        var cell = board[i];
        if (!cell || cell.type !== 'segment' || settledInto.has(i)) continue;

        var group = [i];
        if (cell.link) {
          var p = partnerIndex(i, cell.link);
          if (p >= 0 && board[p]) group.push(p);
        }
        if (group.length > 1 && settledInto.has(group[1])) continue;

        var ok = true;
        for (var g = 0; g < group.length; g++) {
          var gc = colOf(group[g]);
          var gr = rowOf(group[g]);
          if (gr + 1 >= H) { ok = false; break; }
          var target = idx(gc, gr + 1);
          if (board[target] && group.indexOf(target) === -1) { ok = false; break; }
        }
        if (!ok) continue;

        group.sort(function (a, b) { return b - a; }); // bottom-most first
        for (var k = 0; k < group.length; k++) {
          var from = group[k];
          var to = idx(colOf(from), rowOf(from) + 1);
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
      if (!inBounds(cell.c, cell.r)) return false;
      if (board[idx(cell.c, cell.r)]) return false;
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

  // Rotation with wall/floor kicks so the piece still turns when it is flush
  // against an edge or another stack.
  var KICKS = [[0, 0], [-1, 0], [1, 0], [0, 1], [0, -1], [-1, 1], [1, 1]];

  function tryRotate(board, p, dir) {
    var orient = (p.orient + (dir > 0 ? 1 : 3)) % 4;
    for (var i = 0; i < KICKS.length; i++) {
      var next = movedPiece(p, KICKS[i][0], KICKS[i][1], orient);
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
      if (!inBounds(cell.c, cell.r)) continue;
      var at = idx(cell.c, cell.r);
      board[at] = { color: cell.color, type: 'segment', link: cell.link };
      written.push(at);
    }
    // A half that landed out of bounds leaves its partner as a free single.
    if (written.length === 1) board[written[0]].link = null;
    return written;
  }

  function spawnPiece(colors) {
    return { c: (W >> 1) - 1, r: 0, orient: 0, colors: colors };
  }

  function randomColors(rand) {
    rand = rand || Math.random;
    return [(rand() * COLORS) | 0, (rand() * COLORS) | 0];
  }

  /* ---------------------------------------------------------------- seeding */

  // Longest same-colour run through (c,r) in either axis.
  function runThrough(board, c, r) {
    var cell = board[idx(c, r)];
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

  // Only a handful are wedged in at the start. The rest wash down the pipe
  // while the level is played, so a hard level opens on a readable board.
  function clogSeedCount(level) {
    return Math.min(clogTotal(level), 12);
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
    if (col < 0 || col >= W || board[idx(col, 0)]) return -1;
    var r = 0;
    while (r + 1 < H && !board[idx(col, r + 1)]) r++;
    return r;
  }

  // Arrivals aim for the deepest part of the pipe, so they settle low instead of
  // perching on the shoulders of a tall pile where nothing can be built under
  // them. Ties within a couple of rows keep the column from being predictable.
  var DRIP_DEPTH_SLACK = 2;

  function dripColumn(board, rand) {
    rand = rand || Math.random;
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

  function placeClog(board, col, row, color) {
    if (row < 0 || row >= H || col < 0 || col >= W) return false;
    board[idx(col, row)] = { color: color, type: 'clog', link: null };
    return true;
  }

  // Clogs sit in the bottom of the pipe and only creep upward as levels get
  // harder. Seeding them high makes them nearly unreachable, since nothing can
  // be stacked underneath a clog to build a line through it.
  function seedTopRow(level) {
    return Math.max(5, Math.min(H - 2, 11 - Math.floor(level / 2)));
  }

  // Builds a level: the clogs wedged in at the start, plus the queue of those
  // still to wash down. Nothing is placed 3-in-a-line, or the level would
  // cascade on its own the instant it opens.
  function seedLevel(level, rand) {
    rand = rand || Math.random;
    var board = makeBoard();
    var quota = balancedColors(clogTotal(level), rand);
    var seedN = Math.min(quota.length, clogSeedCount(level));

    var want = [];
    for (var z = 0; z < COLORS; z++) want.push(0);
    for (var q = 0; q < seedN; q++) want[quota[q]]++;

    var top = seedTopRow(level);
    var slots = [];
    for (var r = top; r < H; r++) {
      for (var c = 0; c < W; c++) slots.push(idx(c, r));
    }

    var placed = 0;
    var guard = slots.length * 200;
    while (placed < seedN && guard-- > 0) {
      var i = slots[(rand() * slots.length) | 0];
      if (board[i]) continue;
      var cc = colOf(i), rr = rowOf(i);

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

  // Milliseconds per row of free fall.
  function fallInterval(level, elapsedMs) {
    var base = Math.max(110, 760 - level * 34);
    return Math.max(70, base * Math.pow(PRESSURE_FACTOR, pressureStep(level, elapsedMs)));
  }

  return {
    W: W, H: H, COLORS: COLORS, MIN_RUN: MIN_RUN, MAX_LEVEL: MAX_LEVEL,
    DIRS: DIRS, OFFSETS: OFFSETS, LINKS: LINKS, OPPOSITE: OPPOSITE,
    idx: idx, colOf: colOf, rowOf: rowOf, inBounds: inBounds, cellAt: cellAt,
    makeBoard: makeBoard, partnerIndex: partnerIndex,
    findMatches: findMatches, clearMatches: clearMatches,
    gravityStep: gravityStep, settle: settle, resolve: resolve,
    pieceCells: pieceCells, canPlace: canPlace, fits: fits,
    tryMove: tryMove, tryRotate: tryRotate, dropDistance: dropDistance,
    lockPiece: lockPiece, spawnPiece: spawnPiece, randomColors: randomColors,
    seedLevel: seedLevel, clogTotal: clogTotal, countClogs: countClogs,
    clogSeedCount: clogSeedCount, dripEvery: dripEvery, balancedColors: balancedColors,
    dripLanding: dripLanding, dripColumn: dripColumn, placeClog: placeClog,
    shuffle: shuffle,
    runThrough: runThrough, fallInterval: fallInterval,
    seedTopRow: seedTopRow, pressureStep: pressureStep, pressureGrace: pressureGrace,
    PRESSURE_GRACE_MS: PRESSURE_GRACE_MS,
    PRESSURE_GRACE_PER_LEVEL_MS: PRESSURE_GRACE_PER_LEVEL_MS,
    PRESSURE_STEP_MS: PRESSURE_STEP_MS,
    PRESSURE_FACTOR: PRESSURE_FACTOR,
    PRESSURE_MAX_STEPS: PRESSURE_MAX_STEPS
  };
});
