/*
 * Clogged — suspended-game serialisation.
 *
 * Pure functions, no DOM and no storage, so they can be tested directly
 * (see test/save.test.js). The caller owns localStorage.
 *
 * A snapshot is written whenever a coupling starts falling and whenever the
 * game is paused or loses focus, so a tab that gets killed in the background
 * can be picked up where it left off. Everything read back is treated as
 * hostile: a half-written record, a save from an older build, or something
 * hand-edited must not be able to boot the game into a broken state.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Save = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var VERSION = 3;
  var LINKS = { left: 1, right: 1, up: 1, down: 1 };

  function isInt(n, lo, hi) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n >= lo && n <= hi;
  }

  function num(n, lo) {
    return typeof n === 'number' && isFinite(n) && n >= lo ? n : null;
  }

  function encode(game) {
    return {
      v: VERSION,
      level: game.level,
      score: game.score,
      // The pipe is a different size at different levels, so the snapshot
      // records the one it was being played on rather than assuming.
      w: game.board.w,
      h: game.board.h,
      board: game.board.map(function (cell) {
        // 0 segment, 1 clog, 2 matted clog. Builds before matting never
        // wrote a 2, so their snapshots still read back unchanged.
        if (!cell) return 0;
        // A dyed clog (kind 3) also carries its second colour and countdown.
        if (cell.type === 'clog' && cell.dye !== undefined) {
          return [cell.color, 3, 0, cell.dye, cell.dyeIn];
        }
        return [cell.color, cell.type !== 'clog' ? 0 : cell.matted ? 2 : 1, cell.link || 0];
      }),
      // A drain snake has no colours; it is flagged by a sixth element.
      piece: !game.piece ? null
        : game.piece.kind === 'snake' ? [game.piece.c, game.piece.r, 0, 0, 0, 1]
        : [game.piece.c, game.piece.r, game.piece.orient,
           game.piece.colors[0], game.piece.colors[1]],
      next: [game.next[0], game.next[1]],
      pending: game.pending.slice(),
      sinceDrip: game.sinceDrip,
      elapsed: game.elapsed,
      pressure: game.pressure,
      locks: game.locks,
      recorded: !!game.recorded,
      c: game.challenge ? 1 : 0,
      pl: game.plungers || 0,
      sn: game.snakeNext ? 1 : 0,
      se: game.snakeEarned ? 1 : 0
    };
  }

  // Returns a usable game, or null if anything at all looks wrong. Never
  // throws, never half-restores.
  function decode(raw, limits) {
    if (!raw || typeof raw !== 'object' || raw.v !== VERSION) return null;
    var colors = limits.colors;
    // Chrome (limits.wild) may sit on a coupling half, the falling piece or the
    // next one, never on a clog or in the queue of arrivals.
    var wild = limits.wild;
    var pieceColor = function (n) { return isInt(n, 0, colors - 1) || (wild !== undefined && n === wild); };

    // The board's own geometry comes out of the record, so a snapshot taken on
    // one size of pipe cannot be read back as another.
    var cols = raw.w, rows = raw.h;
    if (!isInt(cols, 2, limits.maxW) || !isInt(rows, 2, limits.maxH)) return null;
    var cells = cols * rows;

    if (!Array.isArray(raw.board) || raw.board.length !== cells) return null;

    // Carries its dimensions the way every other board in the game does.
    var board = [];
    board.w = cols;
    board.h = rows;
    var clogs = 0;
    for (var i = 0; i < cells; i++) {
      var slot = raw.board[i];
      if (slot === 0 || slot === null) { board.push(null); continue; }
      if (!Array.isArray(slot)) return null;
      if (slot[1] !== 0 && slot[1] !== 1 && slot[1] !== 2 && slot[1] !== 3) return null;
      if (slot.length !== (slot[1] === 3 ? 5 : 3)) return null;
      if (slot[1] === 3 && (!isInt(slot[3], 0, colors - 1) || slot[3] === slot[0]
        || !isInt(slot[4], 0, 99))) return null;
      if (!(slot[1] === 0 ? pieceColor(slot[0]) : isInt(slot[0], 0, colors - 1))) return null;
      var link = slot[2];
      if (link !== 0 && !LINKS[link]) return null;
      // Clogs are never half of a coupling.
      if (slot[1] !== 0 && link !== 0) return null;
      var cell = {
        color: slot[0],
        type: slot[1] === 0 ? 'segment' : 'clog',
        link: link === 0 ? null : link
      };
      if (slot[1] === 2) cell.matted = true;
      if (slot[1] === 3) { cell.dye = slot[3]; cell.dyeIn = slot[4]; }
      if (slot[1] !== 0) clogs++;
      board.push(cell);
    }

    var piece = null;
    if (raw.piece !== null && raw.piece !== undefined) {
      var p = raw.piece;
      if (!Array.isArray(p) || (p.length !== 5 && !(p.length === 6 && p[5] === 1))) return null;
      if (!isInt(p[0], 0, cols - 1) || !isInt(p[1], 0, rows - 1)) return null;
      if (!isInt(p[2], 0, 3)) return null;
      if (!pieceColor(p[3]) || !pieceColor(p[4])) return null;
      piece = p.length === 6
        ? { c: p[0], r: p[1], orient: 0, colors: null, kind: 'snake' }
        : { c: p[0], r: p[1], orient: p[2], colors: [p[3], p[4]] };
    }

    if (!Array.isArray(raw.next) || raw.next.length !== 2) return null;
    if (!pieceColor(raw.next[0]) || !pieceColor(raw.next[1])) return null;

    if (!Array.isArray(raw.pending)) return null;
    for (var q = 0; q < raw.pending.length; q++) {
      if (!isInt(raw.pending[q], 0, colors - 1)) return null;
    }

    var level = isInt(raw.level, 0, limits.maxLevel) ? raw.level : null;
    var score = num(raw.score, 0);
    var elapsed = num(raw.elapsed, 0);
    var sinceDrip = num(raw.sinceDrip, 0);
    var pressure = num(raw.pressure, 0);
    var locks = num(raw.locks, 0);
    if (level === null || score === null || elapsed === null
      || sinceDrip === null || pressure === null || locks === null) return null;

    // A finished or empty game is not worth resuming.
    if (clogs === 0 && raw.pending.length === 0) return null;

    return {
      level: level,
      score: score,
      board: board,
      piece: piece,
      next: [raw.next[0], raw.next[1]],
      pending: raw.pending.slice(),
      sinceDrip: sinceDrip,
      elapsed: elapsed,
      pressure: pressure,
      locks: locks,
      recorded: !!raw.recorded,
      challenge: raw.c === 1,
      // Older saves predate the efficiency award, so they start the tally at 0.
      plungers: isInt(raw.pl, 0, 3 * (limits.maxLevel + 1)) ? raw.pl : 0,
      snakeNext: raw.sn === 1,
      snakeEarned: raw.se === 1
    };
  }

  // A one-line description for the resume prompt.
  function describe(game) {
    if (!game) return '';
    return (game.challenge ? 'Challenge · ' : '') + 'Level ' + game.level + ' · score ' + game.score;
  }

  return { VERSION: VERSION, encode: encode, decode: decode, describe: describe };
});
