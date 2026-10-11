/* Level-clear lines: every level has one, the levels that change something
 * say so in every wording, and random picks vary. Run with:
 * node test/quips.test.js */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, '..', 'core.js'));
const Q = require(path.join(__dirname, '..', 'quips.js'));

let failed = 0, passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failed++;
  console.error('FAIL ' + name + (detail ? ' — ' + detail : ''));
}

// A small seeded generator so random picks are repeatable.
function seeded(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

for (const challenge of [false, true]) {
  const rand = seeded(challenge ? 7 : 3);
  for (let level = 1; level <= C.MAX_LEVEL; level++) {
    const tag = (challenge ? 'challenge ' : '') + 'level ' + level;
    const q = Q.quipFor(level, C, challenge);
    check(tag + ' has a line', typeof q === 'string' && q.length > 10, String(q));
    const r = Q.quipFor(level, C, challenge, rand);
    check(tag + ' has a random line', typeof r === 'string' && r.length > 10, String(r));
  }
}

// The pool.
check('the pool has at least 120 lines', Q.POOL.length >= 120, String(Q.POOL.length));
check('the pool has no repeats', new Set(Q.POOL).size === Q.POOL.length);
const norm = s => s.toLowerCase().replace(/[^a-z ]/g, '').trim();
check('the pool has no near-repeats', new Set(Q.POOL.map(norm)).size === Q.POOL.length);
Q.POOL.forEach(line => check('pool line is short: ' + line, line.length <= 120, String(line.length)));

// Story variants: each wording carries the rules for its level.
function variants(challenge) { return Q.storyFor(C, challenge); }
const S = variants(false), SC = variants(true);
for (const s of [S, SC]) {
  for (const level of Object.keys(s)) {
    check('story ' + level + ' is a list of 3 wordings',
      Array.isArray(s[level]) && s[level].length === 3 && new Set(s[level]).size === 3);
  }
}
function every(list, re, name) {
  list.forEach((v, i) => check(name + ' (variant ' + i + ')', re.every(r => r.test(v)), v));
}
every(S[1], [/plumber/, /Pipers/, /four of a colour/, /clear/i, /top/], 'level 1 lays out the premise');
every(S[1], [/^(?![\s\S]*\bcat\b)/], 'the normal game has no cat at level 1');
every(SC[1], [/plumber/, /four of a colour/, /clear/i, /top/, /\bcat\b/, /four colours/],
  'a challenge game opens with the premise, the cat and four colours');
every(S[5], [/pipe/, /wider/], 'level 5 widens the pipe');
every(S[10], [/pipe/, /biggest/i], 'level 10 brings the biggest pipe');
every(S[C.CHROME_FROM], [/chrome/, /any colour/], 'chrome arrives with its rule');
every(SC[C.CHROME_FROM], [/chrome/, /any colour/], 'chrome arrives in challenge mode too');
every(S[C.MATTED_FROM], [/baby/, /wipes/, /first/, /unwrap/, /second/, /flush/],
  'the matted clogs arrive with the baby');
every(S[C.FOURTH_FROM], [/\bcat\b/, /new colour/, /(ease|slow)/, /few levels/],
  'the fourth colour arrives with the cat');
every(S[C.FIFTH_FROM], [/Grandpa/, /denture/, /new colour/, /(ease|slow)/, /few levels/],
  'the fifth colour arrives with Grandpa');
every(SC[C.FIFTH_FROM], [/Grandpa/, /new colour/], 'challenge keeps Grandpa');
every(S[C.MAX_LEVEL], [/holidays/, /legend/], 'the last level is the holidays');
check('a challenge game does not bring the cat in twice', !SC[C.FOURTH_FROM] &&
  !/cat\b/.test(Q.quipFor(C.FOURTH_FROM, C, true)));

// Colours stay a surprise.
const all = Q.POOL.concat(...[S, SC].map(s => Object.values(s).flat()));
all.forEach(line => check('no colour named: ' + line, !/\b(red|blue)\b/i.test(line)));

// Determinism without rand.
check('a level always says the same thing', Q.quipFor(23, C) === Q.quipFor(23, C));
check('without rand, a level picks POOL by level number', Q.quipFor(23, C) === Q.POOL[23 % Q.POOL.length]);
check('without rand, a story level says its first wording', Q.quipFor(C.MATTED_FROM, C) === S[C.MATTED_FROM][0]);
check('the normal game keeps its story', Q.quipFor(1, C) === Q.quipFor(1, C, false));

// Randomness.
const rand = seeded(42);
const seen = new Set();
for (let i = 0; i < 50; i++) seen.add(Q.quipFor(23, C, false, rand));
check('random picks for an ordinary level vary', seen.size >= 10, String(seen.size));
check('random picks come from the pool', [...seen].every(q => Q.POOL.includes(q)));
const storySeen = new Set();
for (let i = 0; i < 50; i++) storySeen.add(Q.quipFor(C.MATTED_FROM, C, false, rand));
check('random picks for a story level use all its wordings', storySeen.size === 3, String(storySeen.size));
check('random story picks stay in the story', [...storySeen].every(q => S[C.MATTED_FROM].includes(q)));
check('the same seed gives the same line',
  Q.quipFor(23, C, false, seeded(9)) === Q.quipFor(23, C, false, seeded(9)));
check('rand at the edge of [0,1) stays in range',
  Q.POOL.includes(Q.quipFor(23, C, false, () => 0.9999999999)) &&
  Q.POOL.includes(Q.quipFor(23, C, false, () => 0)));

// Avoiding recent lines.
const recent = Q.POOL.slice(0, Q.POOL.length - 1);
check('avoid skips recently shown lines',
  Q.quipFor(23, C, false, Math.random, recent) === Q.POOL[Q.POOL.length - 1]);
check('avoid falls back when everything was shown',
  Q.POOL.includes(Q.quipFor(23, C, false, Math.random, Q.POOL)));
const twoShown = S[C.MATTED_FROM].slice(0, 2);
check('avoid works for story variants',
  Q.quipFor(C.MATTED_FROM, C, false, Math.random, twoShown) === S[C.MATTED_FROM][2]);

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('ok — ' + passed + ' assertions passed');
