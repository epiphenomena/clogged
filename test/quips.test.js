/* Level-clear lines: every level has one, and the levels that change
 * something say so. Run with: node test/quips.test.js */
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

for (let level = 1; level <= C.MAX_LEVEL; level++) {
  const q = Q.quipFor(level, C);
  check('level ' + level + ' has a line', typeof q === 'string' && q.length > 10, String(q));
}
check('level 1 lays out the premise', /plumber/.test(Q.quipFor(1, C)));
check('the matted clogs arrive with the baby', /baby/.test(Q.quipFor(C.MATTED_FROM, C)));
check('the fourth colour arrives with the cat', /cat\b/.test(Q.quipFor(C.FOURTH_FROM, C)));
check('the fifth colour gets its own story',
  Q.quipFor(C.FIFTH_FROM, C) !== Q.quipFor(C.FIFTH_FROM + 1, C) &&
  /[Bb]lue/.test(Q.quipFor(C.FIFTH_FROM, C)));
check('the pool has no repeats', new Set(Q.POOL).size === Q.POOL.length);
check('a level always says the same thing', Q.quipFor(23, C) === Q.quipFor(23, C));

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('ok — ' + passed + ' assertions passed');
