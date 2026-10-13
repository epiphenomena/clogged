/*
 * Clogged — pure game core.
 * No DOM, no globals beyond the export. Everything here is a plain function
 * over a board array so it can be unit-tested in node (see test/core.test.js).
 *
 * A board is a flat array of w*h slots carrying its own `w` and `h`, since the
 * pipe is a different size at different levels. Each slot is null or:
 *   { color: 0|1|2, type: 'clog'|'segment', link: 'left'|'right'|'up'|'down'|null }
 * `link` points at the other half of a coupler. Clogs never move; segments fall.
 * A clog may also be `matted: true` — wound so tight that the first flush only
 * strips the mat off, and it takes a second to clear it.
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

  // Three colours until level 20, a fourth from there, and a fifth from 32.
  // COLORS is the most any level uses, which is what a snapshot may hold.
  var BASE_COLORS = 3;
  var COLORS = 5;
  var FOURTH_FROM = 20;
  var FIFTH_FROM = 32;
  // Challenge mode deals the fourth colour from level 1 instead. Every rule
  // that depends on the colour count takes the mode as its last argument.
  var CHALLENGE_FOURTH_FROM = 1;
  // Chrome universal couplings: a pipe half that matches any colour. It is a
  // colour index of its own, one past the last real colour, and only ever
  // turns up on a coupling the player is dealt — never on a clog, a seeded
  // board or an arrival.
  var WILD = COLORS;
  var CHROME_FROM = 9;
  // Couplings with one chrome half, by colour count: more colours, more help.
  var CHROME_RATE = [0, 0, 0, 1 / 14, 1 / 10, 1 / 7];
  var MIN_RUN = 4;
  var MAX_LEVEL = 50;   // flushing this one wins the game
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

  function copyCell(cell) {
    var out = { color: cell.color, type: cell.type, link: cell.link };
    if (cell.matted) out.matted = true;
    if (cell.dye !== undefined) { out.dye = cell.dye; out.dyeIn = cell.dyeIn; }
    return out;
  }

  // A copy that keeps its geometry, for callers that want to try something out
  // on a throwaway board.
  function cloneBoard(board) {
    var d = dims(board);
    var out = makeBoard(d.w, d.h);
    for (var i = 0; i < board.length; i++) {
      var cell = board[i];
      out[i] = cell ? copyCell(cell) : null;
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
  // Each cell matches a set of colours: its own, or every colour for chrome.
  var ALL_COLORS = (1 << COLORS) - 1;
  function colorMask(cell) {
    return cell.color === WILD ? ALL_COLORS : 1 << cell.color;
  }

  // A run is MIN_RUN or more cells in a row or column that share at least one
  // colour, with at least one real colour among them (four chrome halves are
  // not a free clear). Chrome joins whatever run it touches, and can serve a
  // different run on each side of it: R R R S B B B clears all seven. Scanning
  // from every start keeps that simple; a line is at most 24 cells.
  function scanLine(board, cells, min, hits) {
    var n = cells.length;
    for (var i = 0; i < n; i++) {
      if (!board[cells[i]]) continue;
      var m = ALL_COLORS, real = false, j = i;
      while (j < n && board[cells[j]]) {
        var mm = m & colorMask(board[cells[j]]);
        if (!mm) break;
        m = mm;
        if (board[cells[j]].color !== WILD) real = true;
        j++;
      }
      if (j - i >= min && real) for (var k = i; k < j; k++) hits.add(cells[k]);
    }
  }

  function findMatches(board, min) {
    min = min || MIN_RUN;
    var d = dims(board), W = d.w, H = d.h;
    var hits = new Set();
    var r, c, line;
    for (r = 0; r < H; r++) {
      line = [];
      for (c = 0; c < W; c++) line.push(r * W + c);
      scanLine(board, line, min, hits);
    }
    for (c = 0; c < W; c++) {
      line = [];
      for (r = 0; r < H; r++) line.push(r * W + c);
      scanLine(board, line, min, hits);
    }
    return hits;
  }

  // Removes every hit cell, orphaning the surviving half of any broken coupler.
  // A matted clog is not removed: the flush strips its mat and leaves a plain
  // clog in its place, to be cleared by another line.
  function clearMatches(board, hits) {
    var clogs = 0, segments = 0, stripped = 0;
    hits.forEach(function (i) {
      var cell = board[i];
      if (!cell) return;
      if (cell.matted) stripped++;
      else if (cell.type === 'clog') clogs++;
      else segments++;
    });
    hits.forEach(function (i) {
      var cell = board[i];
      if (!cell || !cell.link) return;
      var p = partnerIndex(board, i, cell.link);
      if (p >= 0 && board[p] && !hits.has(p)) board[p].link = null;
    });
    hits.forEach(function (i) {
      if (board[i] && board[i].matted) board[i].matted = false;
      else board[i] = null;
    });
    return { clogs: clogs, segments: segments, stripped: stripped };
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
    var chain = 0, clogs = 0, segments = 0, stripped = 0;
    for (;;) {
      var hits = findMatches(board);
      if (hits.size === 0) break;
      chain++;
      var got = clearMatches(board, hits);
      clogs += got.clogs;
      segments += got.segments;
      stripped += got.stripped;
      settle(board);
    }
    return { chain: chain, clogs: clogs, segments: segments, stripped: stripped };
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
    var next = {
      c: p.c + dc,
      r: p.r + dr,
      orient: orient === undefined ? p.orient : orient,
      colors: p.colors
    };
    return next;
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

  /* ---------------------------------------------------------- drain snake */

  // From SNAKE_FROM, a line of SNAKE_RUN or more sends out a drain snake. It
  // starts at the line's ends and bores straight on along it to the walls,
  // breaking every bit of pipe and every clog in its way (a matted clog loses
  // its mat, as in any flush).
  var SNAKE_FROM = 6;
  var SNAKE_RUN = 5;

  // Every maximal run on the board, as { cells, axis } with cells in order
  // along the line. Same rule as findMatches; chrome between two runs belongs
  // to both.
  function findRuns(board, min) {
    min = min || MIN_RUN;
    var d = dims(board), W = d.w, H = d.h;
    var runs = [];
    function scan(cells, axis) {
      var lastEnd = -1;
      for (var i = 0; i < cells.length; i++) {
        if (!board[cells[i]]) continue;
        var m = ALL_COLORS, real = false, j = i;
        while (j < cells.length && board[cells[j]]) {
          var mm = m & colorMask(board[cells[j]]);
          if (!mm) break;
          m = mm;
          if (board[cells[j]].color !== WILD) real = true;
          j++;
        }
        if (j - i >= min && real && j !== lastEnd) {
          runs.push({ cells: cells.slice(i, j), axis: axis });
          lastEnd = j;
        }
      }
    }
    var r, c, line;
    for (r = 0; r < H; r++) {
      line = [];
      for (c = 0; c < W; c++) line.push(r * W + c);
      scan(line, 'row');
    }
    for (c = 0; c < W; c++) {
      line = [];
      for (r = 0; r < H; r++) line.push(r * W + c);
      scan(line, 'col');
    }
    return runs;
  }

  // The snakes a board's lines send out: for each line of SNAKE_RUN or more,
  // a path from each end out to the wall. Returns { hits, paths }: the
  // occupied cells the snakes break, and each path as the cell indices it
  // crosses in order (empty ones too, for drawing).
  function snakeStrike(board, level) {
    var hits = new Set(), paths = [];
    if ((level || 0) < SNAKE_FROM) return { hits: hits, paths: paths };
    var d = dims(board), W = d.w, H = d.h;
    findRuns(board).forEach(function (run) {
      if (run.cells.length < SNAKE_RUN) return;
      var first = run.cells[0], last = run.cells[run.cells.length - 1];
      [[first, -1], [last, 1]].forEach(function (end) {
        var dc = run.axis === 'row' ? end[1] : 0;
        var dr = run.axis === 'col' ? end[1] : 0;
        var path = [];
        for (var c = end[0] % W + dc, r = ((end[0] / W) | 0) + dr;
          c >= 0 && c < W && r >= 0 && r < H; c += dc, r += dr) {
          var at = r * W + c;
          path.push(at);
          if (board[at]) hits.add(at);
        }
        if (path.length) paths.push({ from: end[0], cells: path, axis: run.axis });
      });
    });
    return { hits: hits, paths: paths };
  }

  function spawnPiece(board, colors) {
    return { c: (dims(board).w >> 1) - 1, r: 0, orient: 0, colors: colors };
  }

  function fourthFrom(challenge) {
    return challenge ? CHALLENGE_FOURTH_FROM : FOURTH_FROM;
  }

  function colorsFor(level, challenge) {
    var l = level || 0;
    return l >= FIFTH_FROM ? 5 : l >= fourthFrom(challenge) ? 4 : BASE_COLORS;
  }

  // A coupling's two colours. With a chrome chance, one half (never both) may
  // come up chrome; with none, no extra random number is drawn, so seeded
  // sequences are unchanged where chrome cannot appear.
  function randomColors(rand, colors, chrome) {
    rand = rand || Math.random;
    var k = colors || BASE_COLORS;
    var pair = [(rand() * k) | 0, (rand() * k) | 0];
    if (chrome > 0 && rand() < chrome) pair[rand() < 0.5 ? 0 : 1] = WILD;
    return pair;
  }

  function chromeChance(level, challenge) {
    if ((level || 0) < CHROME_FROM) return 0;
    return CHROME_RATE[colorsFor(level, challenge)];
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

  // A level that brings in something new eases off for a few levels while the
  // player learns it: fewer clogs, a slower fall, arrivals spaced further apart.
  // A new colour weighs most, since every colour added makes a line of four
  // that much harder to come by. The breather is full on the level that
  // introduces it and fades out over the next EASE_LEVELS.
  var EASE_LEVELS = 4;
  var EASE_CLOGS = 0.4;     // up to 40% fewer clogs
  var EASE_FALL = 0.3;      // up to 30% slower fall
  var EASE_DRIP = 0.5;      // from this much ease, one more coupling between arrivals

  function introductions(challenge) {
    return [
      { from: DYE_FROM, weight: 0.5 },
      { from: MATTED_FROM, weight: 0.5 },
      { from: fourthFrom(challenge), weight: 1 },
      { from: FIFTH_FROM, weight: 1 }
    ];
  }

  // 0 on an ordinary level, up to 1 on the one that brings in a new colour.
  function easeFor(level, challenge) {
    var l = level || 0, best = 0;
    introductions(challenge).forEach(function (it) {
      if (l < it.from) return;
      var e = it.weight * Math.max(0, 1 - (l - it.from) / EASE_LEVELS);
      if (e > best) best = e;
    });
    return best;
  }

  // The whole quota for a level, seeded and dripped together. This used to add
  // four per level up to 64, which outran the player badly.
  // Every colour added makes a line of four that much harder to come by, so
  // the quota's ceiling drops with the colour count rather than holding at 40
  // all the way up. Simulated play fell off a cliff the moment a fourth colour
  // arrived under a 40-clog ceiling.
  var CLOG_CAP = [0, 0, 0, 40, 28, 20];

  function clogTotal(level, challenge) {
    var l = Math.max(0, level || 0);
    var cap = CLOG_CAP[colorsFor(l, challenge)];
    return Math.round(Math.min(4 + l * 2, cap) * (1 - EASE_CLOGS * easeFor(l, challenge)));
  }

  // How much of the quota is already wedged in when the level opens. The share
  // shrinks as the levels get harder, so a hard level starts on a board you can
  // still read and the rest wash down while it is played.
  var SEED_SHARE_BASE = 0.9;
  var SEED_SHARE_PER_LEVEL = 0.05;
  var SEED_SHARE_MIN = 0.5;

  function clogSeedCount(level, challenge) {
    var total = clogTotal(level, challenge);
    var share = Math.max(SEED_SHARE_MIN,
      SEED_SHARE_BASE - Math.max(0, level || 0) * SEED_SHARE_PER_LEVEL);
    return Math.max(2, Math.min(total, Math.round(total * share)));
  }

  // Couplings landed between one arrival and the next.
  // With four or more colours an arrival never comes sooner than every third
  // coupling: the board fills with odd halves fast enough as it is.
  function dripEvery(level, challenge) {
    var floor = colorsFor(level, challenge) > BASE_COLORS ? 3 : 2;
    return Math.max(floor, 4 - Math.floor(level / 8)) +
      (easeFor(level, challenge) >= EASE_DRIP ? 1 : 0);
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
  function balancedColors(n, rand, colors) {
    rand = rand || Math.random;
    var k = colors || BASE_COLORS;
    var offset = (rand() * k) | 0;
    var out = [];
    for (var i = 0; i < n; i++) out.push((i + offset) % k);
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

  // `dye`, if given, is { color, inPieces } for a dyed clog (see dyeStep).
  function placeClog(board, col, row, color, matted, dye) {
    if (!inBounds(board, col, row)) return false;
    var cell = { color: color, type: 'clog', link: null };
    if (matted) cell.matted = true;
    else if (dye) { cell.dye = dye.color; cell.dyeIn = dye.inPieces; }
    board[idx(board, col, row)] = cell;
    return true;
  }

  /* ------------------------------------------------------------ hair dye */

  // From level 13 some clogs are dyed: they carry a second colour and swap to
  // it every time a coupling lands, then back, so in effect it matches either
  // colour: a line that wants the other one clears a pill later, when it
  // flips. A clog is never both dyed and matted.
  var DYE_FROM = 13;
  var DYE_EVERY = 1;
  var DYE_BASE = 0.12;
  var DYE_PER_LEVEL = 0.005;
  var DYE_MAX = 0.25;

  function dyeShare(level) {
    if ((level || 0) < DYE_FROM) return 0;
    return Math.min(DYE_MAX, DYE_BASE + (level - DYE_FROM) * DYE_PER_LEVEL);
  }

  // The second colour and the countdown to its first flip, or null. Draws nothing
  // from rand below DYE_FROM, so earlier levels seed exactly as before.
  function rollDye(level, color, colors, rand) {
    var share = dyeShare(level);
    rand = rand || Math.random;
    if (!(share > 0) || rand() >= share || colors < 2) return null;
    var other = (color + 1 + ((rand() * (colors - 1)) | 0)) % colors;
    return { color: other, inPieces: 1 + ((rand() * DYE_EVERY) | 0) };
  }

  // One coupling has landed: every dyed clog counts down, and those at zero
  // flip to their other colour. A flip may complete a line; the caller looks
  // for matches afterwards. Returns how many changed.
  function dyeStep(board) {
    var changed = 0;
    for (var i = 0; i < board.length; i++) {
      var cell = board[i];
      if (!cell || cell.dye === undefined) continue;
      if (cell.dyeIn > 0) cell.dyeIn--;
      if (cell.dyeIn > 0) continue;
      var was = cell.color;
      cell.color = cell.dye;
      cell.dye = was;
      cell.dyeIn = DYE_EVERY;
      changed++;
    }
    return changed;
  }

  // Past level 16 some clogs are matted, and the share grows every level, from
  // one in ten at level 17, a point more each level, to at most about a third.
  var MATTED_FROM = 17;
  var MATTED_BASE = 0.1;
  var MATTED_PER_LEVEL = 0.01;
  var MATTED_MAX = 0.35;

  function mattedShare(level) {
    if ((level || 0) < MATTED_FROM) return 0;
    return Math.min(MATTED_MAX, MATTED_BASE + (level - MATTED_FROM) * MATTED_PER_LEVEL);
  }

  function rollMatted(level, rand) {
    var share = mattedShare(level);
    return share > 0 && (rand || Math.random)() < share;
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
  function seedLevel(level, rand, challenge) {
    rand = rand || Math.random;
    var board = makeBoardFor(level);
    var W = board.w, H = board.h;
    var colors = colorsFor(level, challenge);
    var quota = balancedColors(clogTotal(level, challenge), rand, colors);
    var seedN = Math.min(quota.length, clogSeedCount(level, challenge));

    var want = [];
    for (var z = 0; z < colors; z++) want.push(0);
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
      for (var k = 0; k < colors; k++) if (want[k] > 0) order.push(k);
      if (!order.length) break;
      shuffle(order, rand);

      for (var m = 0; m < order.length; m++) {
        board[i] = { color: order[m], type: 'clog', link: null };
        if (runThrough(board, cc, rr) < 3) {
          if (rollMatted(level, rand)) board[i].matted = true;
          else {
            var dye = rollDye(level, order[m], colors, rand);
            if (dye) { board[i].dye = dye.color; board[i].dyeIn = dye.inPieces; }
          }
          want[order[m]]--;
          placed++;
          break;
        }
        board[i] = null;
      }
    }

    // Anything that could not be placed joins the queue, so the level's total
    // and its colour balance hold either way.
    var pending = quota.slice(seedN);
    for (var k2 = 0; k2 < colors; k2++) {
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
  var FALL_PER_LEVEL_MS = 10;
  // Past level 20 the other mechanics carry the difficulty, so the fall barely
  // quickens: 4ms a level, down to a floor the top levels only just reach.
  var FALL_LATE_FROM = 20;
  var FALL_LATE_PER_LEVEL_MS = 4;
  var FALL_FLOOR_MS = 240;

  // Milliseconds per row of free fall. A taller pipe gets a shorter interval,
  // so a coupling takes about the same time to cross the screen whatever size
  // the fittings are: the rows are smaller, not slower.
  function fallInterval(level, elapsedMs, h, challenge) {
    var l = Math.max(0, level || 0);
    var base = Math.max(FALL_FLOOR_MS, FALL_BASE_MS
      - Math.min(l, FALL_LATE_FROM) * FALL_PER_LEVEL_MS
      - Math.max(0, l - FALL_LATE_FROM) * FALL_LATE_PER_LEVEL_MS) *
      (1 + EASE_FALL * easeFor(level, challenge));
    var scaled = base * (BASE_H / (h || BASE_H));
    return scaled * Math.pow(PRESSURE_FACTOR, pressureStep(level, elapsedMs));
  }

  /* ------------------------------------------------------------- efficiency */

  // Each level awards one to three plungers for how few pills it took. Par is
  // a generous guess at a tidy clear: two and a half pills a clog with three
  // colours, more with each colour added (the right half turns up less often),
  // a second line for the share of clogs that come matted, and a little slack.
  // The layouts are random, so the bands are wide: three plungers at or under
  // par, two up to twice par, and one for any clear at all.
  var PAR_PILLS_PER_CLOG = 2.5;
  var PAR_SLACK = 3;
  var PAR_TWO_PLUNGERS = 2;   // times par

  function parPills(level, challenge) {
    var work = clogTotal(level, challenge) * (1 + mattedShare(level));
    return Math.round(work * PAR_PILLS_PER_CLOG *
      colorsFor(level, challenge) / BASE_COLORS + PAR_SLACK);
  }

  function plungersFor(pills, level, challenge) {
    var par = parPills(level, challenge);
    if (pills <= par) return 3;
    if (pills <= par * PAR_TWO_PLUNGERS) return 2;
    return 1;
  }

  /* ---------------------------------------------------------------- trophy */

  // Flushing the last level wins a golden plunger — or a bronze one, or better
  // than gold. The metal is set by the final score, so a run that climbed the
  // whole pipe from level 0 outshines one that started near the top. Level
  // bonuses alone from 0 to the top come to about 660,000.
  var TROPHIES = [
    { from: 0, name: 'bronze' },
    { from: 150000, name: 'silver' },
    { from: 500000, name: 'gold' },
    { from: 1000000, name: 'platinum' }
  ];

  function trophyFor(score) {
    var pick = TROPHIES[0];
    for (var i = 1; i < TROPHIES.length; i++) {
      if ((score || 0) >= TROPHIES[i].from) pick = TROPHIES[i];
    }
    return pick.name;
  }

  return {
    TROPHIES: TROPHIES, trophyFor: trophyFor,
    BASE_W: BASE_W, BASE_H: BASE_H, MAX_W: MAX_W, MAX_H: MAX_H,
    COLORS: COLORS, BASE_COLORS: BASE_COLORS, FOURTH_FROM: FOURTH_FROM, FIFTH_FROM: FIFTH_FROM, colorsFor: colorsFor,
    CHALLENGE_FOURTH_FROM: CHALLENGE_FOURTH_FROM, fourthFrom: fourthFrom,
    WILD: WILD, CHROME_FROM: CHROME_FROM, chromeChance: chromeChance, colorMask: colorMask,
    MIN_RUN: MIN_RUN, MAX_LEVEL: MAX_LEVEL,
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
    dripTarget: dripTarget,
    parPills: parPills, plungersFor: plungersFor,
    SNAKE_FROM: SNAKE_FROM, SNAKE_RUN: SNAKE_RUN, findRuns: findRuns,
    snakeStrike: snakeStrike,
    DYE_FROM: DYE_FROM, DYE_EVERY: DYE_EVERY, dyeShare: dyeShare, rollDye: rollDye,
    dyeStep: dyeStep,
    easeFor: easeFor, introductions: introductions, EASE_LEVELS: EASE_LEVELS,
    mattedShare: mattedShare, rollMatted: rollMatted, MATTED_FROM: MATTED_FROM, dripSnagRows: dripSnagRows, snagMinRow: snagMinRow,
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
