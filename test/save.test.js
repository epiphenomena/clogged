/* Tests for suspended-game serialisation. Run: node test/save.test.js */
'use strict';
const S = require('../save.js');
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

const LIMITS = { cells: C.W * C.H, cols: C.W, colors: C.COLORS, maxLevel: C.MAX_LEVEL };

function sampleGame() {
  const board = C.makeBoard();
  board[C.idx(2, 14)] = { color: 1, type: 'clog', link: null };
  board[C.idx(3, 15)] = { color: 0, type: 'segment', link: 'right' };
  board[C.idx(4, 15)] = { color: 2, type: 'segment', link: 'left' };
  board[C.idx(5, 12)] = { color: 2, type: 'segment', link: 'down' };
  board[C.idx(5, 13)] = { color: 1, type: 'segment', link: 'up' };
  return {
    level: 7,
    score: 4820,
    board,
    piece: { c: 3, r: 0, orient: 2, colors: [1, 2] },
    next: [0, 1],
    pending: [0, 1, 2, 2],
    sinceDrip: 2,
    elapsed: 91234.5,
    pressure: 1,
    locks: 33,
    recorded: false
  };
}

// Round trip: a real game must come back exactly as it went in.
{
  const before = sampleGame();
  const after = S.decode(S.encode(before), LIMITS);
  check('a saved game decodes', !!after);
  eq('level survives', after.level, before.level);
  eq('score survives', after.score, before.score);
  eq('elapsed time survives', after.elapsed, before.elapsed);
  eq('pressure survives', after.pressure, before.pressure);
  eq('lock count survives', after.locks, before.locks);
  eq('drip counter survives', after.sinceDrip, before.sinceDrip);
  eq('the queue survives', after.pending.join(','), before.pending.join(','));
  eq('the next coupling survives', after.next.join(','), before.next.join(','));
  eq('the falling piece survives',
    JSON.stringify(after.piece), JSON.stringify(before.piece));
  eq('the board survives cell for cell',
    JSON.stringify(after.board), JSON.stringify(before.board));
  eq('clogs stay clogs', after.board[C.idx(2, 14)].type, 'clog');
  eq('segments stay segments', after.board[C.idx(3, 15)].type, 'segment');
  eq('links survive', after.board[C.idx(3, 15)].link, 'right');
  eq('a vertical link survives', after.board[C.idx(5, 12)].link, 'down');
  eq('empty cells stay empty', after.board[C.idx(0, 0)], null);
}

// A board with no piece (between couplings) is still restorable.
{
  const g = sampleGame();
  g.piece = null;
  const back = S.decode(S.encode(g), LIMITS);
  check('a game with no piece in flight decodes', !!back);
  eq('the missing piece stays missing', back.piece, null);
}

// The restored board must behave like a real board.
{
  const back = S.decode(S.encode(sampleGame()), LIMITS);
  check('the restored board accepts a piece',
    C.fits(back.board, C.spawnPiece([0, 1])));
  check('gravity works on the restored board', C.settle(back.board) >= 0);
  check('match detection works on the restored board',
    C.findMatches(back.board) instanceof Set);
}

/* ------------------------------------------------- refusing bad records */
{
  const good = S.encode(sampleGame());
  const mangle = (fn) => { const c = JSON.parse(JSON.stringify(good)); fn(c); return c; };

  eq('nothing at all is refused', S.decode(null, LIMITS), null);
  eq('undefined is refused', S.decode(undefined, LIMITS), null);
  eq('a string is refused', S.decode('save', LIMITS), null);
  eq('a number is refused', S.decode(42, LIMITS), null);
  eq('an empty object is refused', S.decode({}, LIMITS), null);

  eq('an older version is refused',
    S.decode(mangle((c) => { c.v = S.VERSION - 1; }), LIMITS), null);
  eq('a newer version is refused',
    S.decode(mangle((c) => { c.v = S.VERSION + 1; }), LIMITS), null);
  eq('a truncated board is refused',
    S.decode(mangle((c) => { c.board.length = 10; }), LIMITS), null);
  eq('an oversized board is refused',
    S.decode(mangle((c) => { c.board.push(0); }), LIMITS), null);
  eq('a board that is not an array is refused',
    S.decode(mangle((c) => { c.board = 'x'; }), LIMITS), null);
  eq('a malformed cell is refused',
    S.decode(mangle((c) => { c.board[0] = [1]; }), LIMITS), null);
  eq('an impossible colour is refused',
    S.decode(mangle((c) => { c.board[0] = [9, 0, 0]; }), LIMITS), null);
  eq('an impossible cell type is refused',
    S.decode(mangle((c) => { c.board[0] = [1, 5, 0]; }), LIMITS), null);
  eq('an impossible link is refused',
    S.decode(mangle((c) => { c.board[0] = [1, 0, 'sideways']; }), LIMITS), null);
  eq('a piece off the right edge is refused',
    S.decode(mangle((c) => { c.piece[0] = C.W; }), LIMITS), null);
  eq('a piece below the floor is refused',
    S.decode(mangle((c) => { c.piece[1] = C.H; }), LIMITS), null);
  eq('a piece with a bad rotation is refused',
    S.decode(mangle((c) => { c.piece[2] = 7; }), LIMITS), null);
  eq('a piece with a bad colour is refused',
    S.decode(mangle((c) => { c.piece[3] = -1; }), LIMITS), null);
  eq('a malformed piece is refused',
    S.decode(mangle((c) => { c.piece = [1, 2]; }), LIMITS), null);
  eq('a bad next coupling is refused',
    S.decode(mangle((c) => { c.next = [0]; }), LIMITS), null);
  eq('a bad queue entry is refused',
    S.decode(mangle((c) => { c.pending = [0, 99]; }), LIMITS), null);
  eq('a queue that is not an array is refused',
    S.decode(mangle((c) => { c.pending = 4; }), LIMITS), null);
  eq('a level beyond the last is refused',
    S.decode(mangle((c) => { c.level = C.MAX_LEVEL + 1; }), LIMITS), null);
  eq('a negative score is refused',
    S.decode(mangle((c) => { c.score = -10; }), LIMITS), null);
  eq('a non-numeric score is refused',
    S.decode(mangle((c) => { c.score = 'lots'; }), LIMITS), null);
  eq('an infinite elapsed time is refused',
    S.decode(mangle((c) => { c.elapsed = null; }), LIMITS), null);

  // A finished game is not worth offering to resume.
  eq('a game with nothing left to clear is refused',
    S.decode(mangle((c) => {
      c.board = c.board.map(() => 0);
      c.pending = [];
    }), LIMITS), null);

  // But a board with no clogs and a queue still pending is a live game.
  const queued = S.decode(mangle((c) => {
    c.board = c.board.map(() => 0);
    c.pending = [1, 2];
  }), LIMITS);
  check('a game whose clogs are all still queued is resumable', !!queued);
}

/* ------------------------------------------------------------ describing */
{
  const g = sampleGame();
  const text = S.describe(S.decode(S.encode(g), LIMITS));
  check('the description names the level', text.indexOf('7') >= 0, text);
  check('the description names the score', text.indexOf('4820') >= 0, text);
  eq('describing nothing is safe', S.describe(null), '');
}

/* -------------------------------------------------------- no mutation */
{
  const g = sampleGame();
  const snapshot = JSON.stringify(g);
  const raw = S.encode(g);
  raw.board[0] = [1, 1, 0];
  raw.pending.push(0);
  eq('encoding does not alias the game it was given', JSON.stringify(g), snapshot);
}

if (failures.length) {
  console.error('FAILED (' + failures.length + ' of ' + (passed + failures.length) + ')');
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('ok — ' + passed + ' assertions passed');
