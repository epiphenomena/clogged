/*
 * Clogged — what the level-clear screen says about the level coming up.
 *
 * The levels where something changes get their own bit of the household's
 * story, which also explains the change. Every other level draws a line from
 * the pool, picked by level number so a level always says the same thing.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Quips = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // Keyed by the level about to be played. Core is passed in rather than
  // required so the numbers can never drift from the rules.
  function storyFor(C) {
    var s = {};
    s[1] = 'You are the plumber on call for the Pipers, a family of five with ' +
      'one bathroom and no shame. Their drain is packed solid. Line up four ' +
      'of a colour to flush the clogs; clear them all and the pipe runs free. ' +
      'Let it back up to the top and, well, you know what happens.';
    s[5] = 'The Pipers splurged on a wider pipe. More room to work in — and ' +
      'they have taken it as a personal challenge to fill it.';
    s[10] = 'Another upgrade: the biggest pipe the hardware store sells. ' +
      'Grandma says it is "rated for Thanksgiving". We shall see.';
    s[C.MATTED_FROM] = 'Congratulations — the Pipers have a new baby! Somebody ' +
      'thinks the wipes are flushable. Matted clogs come wrapped up tight: ' +
      'the first line only unwraps them, the second flushes them.';
    s[C.FOURTH_FROM] = 'The Pipers just got a cat, and someone swears the ' +
      'litter is flushable. Red clogs join the party. It is a lot to take in, ' +
      'so things slow down for a few levels while you get your bearings.';
    s[C.FIFTH_FROM] = 'Grandpa moved in. So did his denture tablets, his ' +
      'prune juice and his opinions. Blue clogs, everyone. Things ease off ' +
      'for a few levels while you adjust to the new normal.';
    s[C.MAX_LEVEL] = 'The whole extended family is home for the holidays. ' +
      'One bathroom. Three kinds of casserole. Flush this one and you are a ' +
      'legend of the trade.';
    return s;
  }

  var POOL = [
    'Taco Tuesday at the Pipers\'. Godspeed.',
    'Uncle Ray had the chili again.',
    'If it\'s yellow, let it mellow. If it\'s brown, you\'re needed downtown.',
    'Someone tried to flush a whole roll. On purpose. As an experiment.',
    'This job stinks, but the work is regular.',
    'It\'s not a clog. It\'s a feature.',
    'The kids found out that toys float. Briefly.',
    'Somebody ate an entire bag of sugar-free gummy bears.',
    'Number two on the list of things nobody thanks you for.',
    'The septic tank called. It would like a word.',
    'Someone has been reading War and Peace in there. All of it.',
    'A goldfish went down the hatch. He\'s fine. He\'s in the next level.',
    'Wash your hands between levels. We mean it.',
    'Fibre: a blessing for them, a curse for you.',
    'Who keeps buying the two-ply that never dissolves?',
    'Pressure is building, and not only in the pipes.',
    'The neighbours\' pipes are worse, apparently. Small comfort.',
    'You have seen things down there no one should see.',
    'That smell? That is the smell of overtime.',
    'The plunger is mightier than the sword.',
    'Things are moving along nicely. Mostly.',
    'Bran muffins were on sale. They bought twelve.',
    'Royal flush? In this house, every flush is a gamble.',
    'Someone lit a match. It did not help.',
    'Holiday leftovers. Brace for impact.',
    'Remember: you are not paid by the hour. You are paid by the movement.',
    'Grandma\'s famous bean dip is back by popular demand.',
    'Spicy curry night. The pipes will remember this.'
  ];

  function quipFor(level, C) {
    var story = storyFor(C)[level];
    if (story) return story;
    return POOL[Math.abs(level || 0) % POOL.length];
  }

  return { quipFor: quipFor, storyFor: storyFor, POOL: POOL };
});
