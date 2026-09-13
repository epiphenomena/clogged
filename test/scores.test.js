/* Tests for score history. Run: node test/scores.test.js */
'use strict';
const S = require('../scores.js');

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  check(name, actual === expected, 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}

const run = (s, t, l) => ({ s, t: t || 0, l: l || 0 });

/* ------------------------------------------------------------ recording */
{
  let st = S.empty();
  eq('a fresh history has no runs', st.runs.length, 0);
  eq('a fresh history has no top scores', st.top.length, 0);
  eq('best of an empty history is zero', S.bestScore(st), 0);

  st = S.add(st, run(500, 10));
  st = S.add(st, run(1500, 20));
  eq('runs accumulate', st.runs.length, 2);
  eq('best tracks the highest', S.bestScore(st), 1500);
  eq('the timeline keeps play order', S.timeline(st).map((r) => r.s).join(','), '500,1500');
  eq('the table is ranked high to low', st.top.map((r) => r.s).join(','), '1500,500');
}
{
  // A zero or junk run is not history.
  let st = S.add(S.empty(), run(0, 1));
  eq('a zero score is not recorded', st.runs.length, 0);
  st = S.add(st, null);
  st = S.add(st, { s: 'abc' });
  st = S.add(st, { s: NaN });
  eq('junk entries are ignored', st.runs.length, 0);
}
{
  let st = S.add(S.empty(), { s: 1234.7, l: 3.2, t: 99 });
  eq('scores are stored as whole numbers', st.runs[0].s, 1235);
  eq('levels are stored as whole numbers', st.runs[0].l, 3);
  eq('timestamps are preserved', st.runs[0].t, 99);
}

/* --------------------------------------------------------- the two caps */
{
  let st = S.empty();
  for (let i = 1; i <= 80; i++) st = S.add(st, run(i * 10, i));
  eq('the rolling window is capped', st.runs.length, S.MAX_RUNS);
  eq('the window keeps the most recent runs', st.runs[st.runs.length - 1].s, 800);
  eq('the window drops the oldest', st.runs[0].s, (80 - S.MAX_RUNS + 1) * 10);
  eq('the table is capped', st.top.length, S.MAX_TOP);
  eq('the table keeps the highest', st.top[0].s, 800);
  eq('the timeline shows at most 25', S.timeline(st).length, S.TIMELINE);
}
{
  // The point of keeping two lists: an old great score outlives the window.
  let st = S.add(S.empty(), run(999999, 1));
  for (let i = 0; i < S.MAX_RUNS + 20; i++) st = S.add(st, run(10, i + 2));
  eq('an ancient best survives the rolling window', S.bestScore(st), 999999);
  check('the ancient run is gone from the timeline',
    !S.timeline(st).some((r) => r.s === 999999));
}

/* --------------------------------------------------------------- order */
{
  let st = S.empty();
  st = S.add(st, run(100, 5));
  st = S.add(st, run(100, 1));   // same score, achieved earlier
  eq('ties rank the earlier run first', st.top[0].t, 1);
}
{
  let st = S.empty();
  [300, 100, 500, 200].forEach((s, i) => { st = S.add(st, run(s, i)); });
  eq('the table is sorted regardless of play order',
    st.top.map((r) => r.s).join(','), '500,300,200,100');
  eq('the timeline is not sorted',
    S.timeline(st).map((r) => r.s).join(','), '300,100,500,200');
}

/* ------------------------------------------------- loading junk from disk */
{
  eq('undefined state sanitises to empty', S.sanitize(undefined).runs.length, 0);
  eq('a string sanitises to empty', S.sanitize('nope').top.length, 0);
  const messy = S.sanitize({ runs: [run(10), null, { s: -5 }, { s: 20 }], top: 'bad' });
  eq('bad runs are dropped on load', messy.runs.length, 2);
  eq('a bad table is dropped on load', messy.top.length, 0);
  const over = S.sanitize({ runs: [], top: Array.from({ length: 40 }, (_, i) => run(i + 1)) });
  eq('an oversized table is trimmed on load', over.top.length, S.MAX_TOP);
  eq('trimming keeps the highest', over.top[0].s, 40);
}

/* ------------------------------------------------------- legacy best score */
{
  // Players who set a best before history existed keep it.
  let st = S.seedBest(S.empty(), 4200);
  eq('a legacy best seeds the table', st.top.length, 1);
  eq('the legacy best keeps its value', st.top[0].s, 4200);
  eq('seeding does not invent a run', st.runs.length, 0);

  st = S.seedBest(st, 4200);
  eq('seeding twice does not duplicate', st.top.length, 1);

  let st2 = S.add(S.empty(), run(9000, 1));
  st2 = S.seedBest(st2, 500);
  eq('a lower legacy best is not added', st2.top.length, 1);
  eq('seeding never lowers the best', S.bestScore(st2), 9000);
}

/* ---------------------------------------------------------- immutability */
{
  const before = S.add(S.empty(), run(100, 1));
  const snapshot = JSON.stringify(before);
  S.add(before, run(200, 2));
  eq('add does not mutate its input', JSON.stringify(before), snapshot);
}

/* ---------------------------------------------------------------- report */
if (failures.length) {
  console.error('FAILED (' + failures.length + ' of ' + (passed + failures.length) + ')');
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('ok — ' + passed + ' assertions passed');
