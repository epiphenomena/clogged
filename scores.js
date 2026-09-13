/*
 * Clogged — score history.
 *
 * Pure functions over a plain object so they can be unit-tested without a DOM
 * or localStorage (see test/scores.test.js). The caller owns persistence.
 *
 * A run is { s: score, l: level reached, t: epoch ms }.
 *
 * Two lists are kept rather than one, deliberately: `runs` is a rolling window
 * for the timeline, while `top` is never evicted by age, so a great score from
 * a hundred games ago still shows up in the all-time table.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Scores = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var MAX_RUNS = 50;   // rolling window kept for the timeline
  var MAX_TOP = 10;    // all-time leaderboard length
  var TIMELINE = 25;   // how many of the recent runs the chart shows

  function empty() { return { runs: [], top: [] }; }

  function validRun(r) {
    return !!r && typeof r.s === 'number' && isFinite(r.s) && r.s > 0;
  }

  function clean(r) {
    return {
      s: Math.max(0, Math.round(r.s)),
      l: Math.max(0, Math.round(r.l || 0)),
      t: typeof r.t === 'number' && isFinite(r.t) ? r.t : 0
    };
  }

  // Anything may come back out of localStorage: old shapes, partial writes,
  // hand-edited junk. Normalise rather than trusting it.
  function sanitize(state) {
    var s = state && typeof state === 'object' ? state : {};
    var runs = Array.isArray(s.runs) ? s.runs.filter(validRun).map(clean) : [];
    var top = Array.isArray(s.top) ? s.top.filter(validRun).map(clean) : [];
    return {
      runs: runs.slice(-MAX_RUNS),
      top: rank(top).slice(0, MAX_TOP)
    };
  }

  // Highest first; an equal score set earlier ranks above one set later.
  function rank(list) {
    return list.slice().sort(function (a, b) {
      return b.s - a.s || a.t - b.t;
    });
  }

  function add(state, run) {
    var base = sanitize(state);
    if (!validRun(run)) return base;
    var entry = clean(run);
    return {
      runs: base.runs.concat([entry]).slice(-MAX_RUNS),
      top: rank(base.top.concat([entry])).slice(0, MAX_TOP)
    };
  }

  // Carries a best score saved before history existed into the table.
  function seedBest(state, best) {
    var base = sanitize(state);
    if (!best || base.top.some(function (r) { return r.s >= best; })) return base;
    return {
      runs: base.runs,
      top: rank(base.top.concat([{ s: best, l: 0, t: 0 }])).slice(0, MAX_TOP)
    };
  }

  // Oldest first, so the chart reads left to right through time.
  function timeline(state) {
    return sanitize(state).runs.slice(-TIMELINE);
  }

  function top(state) { return sanitize(state).top; }

  function bestScore(state) {
    var t = top(state);
    return t.length ? t[0].s : 0;
  }

  return {
    MAX_RUNS: MAX_RUNS, MAX_TOP: MAX_TOP, TIMELINE: TIMELINE,
    empty: empty, sanitize: sanitize, add: add, seedBest: seedBest,
    timeline: timeline, top: top, bestScore: bestScore, rank: rank
  };
});
