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
        return cell ? [cell.color, cell.type === 'clog' ? 1 : 0, cell.link || 0] : 0;
      }),
      piece: game.piece
        ? [game.piece.c, game.piece.r, game.piece.orient,
           game.piece.colors[0], game.piece.colors[1]]
        : null,
      next: [game.next[0], game.next[1]],
      pending: game.pending.slice(),
      sinceDrip: game.sinceDrip,
      elapsed: game.elapsed,
      pressure: game.pressure,
      locks: game.locks,
      recorded: !!game.recorded
    };
  }

  // Returns a usable game, or null if anything at all looks wrong. Never
  // throws, never half-restores.
  function decode(raw, limits) {
    if (!raw || typeof raw !== 'object' || raw.v !== VERSION) return null;
    var colors = limits.colors;

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
      if (!Array.isArray(slot) || slot.length !== 3) return null;
      if (!isInt(slot[0], 0, colors - 1)) return null;
      if (slot[1] !== 0 && slot[1] !== 1) return null;
      var link = slot[2];
      if (link !== 0 && !LINKS[link]) return null;
      if (slot[1] === 1) clogs++;
      board.push({
        color: slot[0],
        type: slot[1] === 1 ? 'clog' : 'segment',
        link: link === 0 ? null : link
      });
    }

    var piece = null;
    if (raw.piece !== null && raw.piece !== undefined) {
      var p = raw.piece;
      if (!Array.isArray(p) || p.length !== 5) return null;
      if (!isInt(p[0], 0, cols - 1) || !isInt(p[1], 0, rows - 1)) return null;
      if (!isInt(p[2], 0, 3)) return null;
      if (!isInt(p[3], 0, colors - 1) || !isInt(p[4], 0, colors - 1)) return null;
      piece = { c: p[0], r: p[1], orient: p[2], colors: [p[3], p[4]] };
    }

    if (!Array.isArray(raw.next) || raw.next.length !== 2) return null;
    if (!isInt(raw.next[0], 0, colors - 1) || !isInt(raw.next[1], 0, colors - 1)) return null;

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
      recorded: !!raw.recorded
    };
  }

  // A one-line description for the resume prompt.
  function describe(game) {
    if (!game) return '';
    return 'Level ' + game.level + ' · score ' + game.score;
  }

  return { VERSION: VERSION, encode: encode, decode: decode, describe: describe };
});
