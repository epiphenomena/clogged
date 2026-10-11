/*
 * Clogged — what the level-clear screen says about the level coming up.
 *
 * The levels where something changes get their own bit of the household's
 * story, which also explains the change. Every other level draws a line from
 * the pool.
 *
 * API
 *   storyFor(C, challenge) -> { [level]: string[] }
 *     Each story level maps to an array of alternative wordings. Every
 *     wording carries the same rules information; the first is the canonical
 *     one. Later colours are never named, so they stay a surprise.
 *   quipFor(level, C, challenge, rand, avoid) -> string
 *     rand  optional () => [0,1). Given, the line is picked at random among
 *           the level's options (its story variants, or the whole POOL).
 *           Omitted, the result is deterministic: the first story variant,
 *           or POOL[level % POOL.length].
 *     avoid optional array of recently shown lines; random picks skip them
 *           while any other option remains.
 *   POOL -> string[] of ordinary between-level lines.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Quips = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var PREMISE = [
    'You are the plumber on call for the Pipers, a family of five with ' +
      'one bathroom and no shame. Their drain is packed solid. Line up four ' +
      'of a colour to flush the clogs; clear them all and the pipe runs free. ' +
      'Let it back up to the top and, well, you know what happens.',
    'Meet the Pipers: five people, one bathroom, and you, their plumber on ' +
      'call. Line up four of a colour to flush a clog. Clear every clog to ' +
      'finish the job, and never let it back up to the top.',
    'The Pipers have called their plumber again. That is you. Their pipe is ' +
      'full of clogs: line up four of a colour to flush them, clear them all ' +
      'to win, and don\'t let anything back up to the top.'
  ];
  // Appended, in step, to each premise wording in challenge mode.
  var PREMISE_CAT = [
    ' Oh, and they just got a cat. Someone swears the litter is ' +
      'flushable, so this is challenge mode: four colours of clog from the ' +
      'start. Things ease off for a level or two while you settle in.',
    ' Also new: a cat, and litter someone insists is flushable. Challenge ' +
      'mode means four colours of clog from the start. It eases off for a ' +
      'level or two while you settle in.',
    ' And the cat moved in early, litter and all. This is challenge mode: ' +
      'four colours of clog from the start, though it eases off for a level ' +
      'or two at first.'
  ];

  // Keyed by the level about to be played. Core is passed in rather than
  // required so the numbers can never drift from the rules. In challenge mode
  // the cat has already moved in when the story starts.
  function storyFor(C, challenge) {
    var s = {};
    s[1] = PREMISE.map(function (p, i) {
      return challenge ? p + PREMISE_CAT[i] : p;
    });
    s[5] = [
      'The Pipers splurged on a wider pipe. More room to work in — and ' +
        'they have taken it as a personal challenge to fill it.',
      'A wider pipe! The Pipers call it an investment. More room for you, ' +
        'and more room for them to fill.',
      'New, wider pipe fitted. The Pipers celebrated by testing its limits ' +
        'immediately.'
    ];
    s[10] = [
      'Another upgrade: the biggest pipe the hardware store sells. ' +
        'Grandma says it is "rated for Thanksgiving". We shall see.',
      'The Pipers went for the biggest pipe money can buy. The hardware ' +
        'store clerk wished you luck.',
      'Biggest pipe yet. Lots of room to move — and the Pipers have never ' +
        'seen empty space they couldn\'t fill.'
    ];
    s[C.SNAKE_FROM] = [
      'You finally bought a proper drain snake. Pull off a chain of three or ' +
        'more and one turns up in NEXT, once a level: drop it down a column ' +
        'and it bores through loose pipe to flush the first clog it hits.',
      'New tool day: a drain snake. A chain of three or more earns one, once ' +
        'a level. Aim it at a column and it chews down through the pipe and ' +
        'flushes the first clog it reaches.',
      'The Pipers\' drain has earned the big guns: a drain snake. Make a ' +
        'chain of three or more and it is yours, once a level. Drop it in a ' +
        'column; it bores down and flushes the first clog in its way.'
    ];
    s[C.CHROME_FROM] = [
      'Good news for once: the supply shop had chrome universal couplings on ' +
        'sale. A chrome half fits any colour, so it counts toward whatever ' +
        'line it lands in. You will not get many. Use them wisely.',
      'You treated yourself to chrome universal couplings. Now and then one ' +
        'half of a coupling comes up chrome, and chrome matches any colour ' +
        'it touches.',
      'The van now carries chrome universal couplings, the plumber\'s ' +
        'skeleton key. A chrome half matches any colour in its line. They ' +
        'turn up now and again, so save them for the awkward spots.'
    ];
    s[C.DYE_FROM] = [
      'The Pipers\' teenager dyes their hair a new colour every week, and ' +
        'every week it goes down the drain. A dyed clog matches the colour ' +
        'it is now; its white pips count the couplings until it changes, ' +
        'and a streak of the new colour flashes just before.',
      'Hair dye season. The teenager rinses out a new colour every week. ' +
        'Match a dyed clog by the colour it is now. The pips count down ' +
        'the couplings to its change; a flashing streak shows what is next.',
      'The teenager went from blonde to "sunset" to "galaxy" in a month, ' +
        'all of it via the drain. Dyed clogs change colour every few ' +
        'couplings. Go by the colour they are now, count the pips, and ' +
        'watch for the flashing streak of the colour to come.'
    ];
    s[C.MATTED_FROM] = [
      'Congratulations — the Pipers have a new baby! Somebody ' +
        'thinks the wipes are flushable. Matted clogs come wrapped up tight: ' +
        'the first line only unwraps them, the second flushes them.',
      'A new baby for the Pipers, and a mountain of "flushable" wipes. ' +
        'Matted clogs are wrapped: your first line only unwraps one, a ' +
        'second line flushes it.',
      'The Pipers\' new baby came with wipes that swear they\'re flushable. ' +
        'They aren\'t. Matted clogs take two lines: the first only unwraps, ' +
        'the second flushes.'
    ];
    if (!challenge) {
      s[C.FOURTH_FROM] = [
        'The Pipers just got a cat, and someone swears the litter is ' +
          'flushable. A new colour of clog joins the party. It is a lot to ' +
          'take in, so things slow down for a few levels while you get your ' +
          'bearings.',
        'A cat has adopted the Pipers, and its litter keeps ending up in the ' +
          'toilet. That means a new colour of clog. Things ease off for a ' +
          'few levels while you adjust.',
        'Meet the cat. Meet its "flushable" litter. Meet a new colour of ' +
          'clog. Don\'t worry: the pace eases off for a few levels while you ' +
          'get used to it.'
      ];
    }
    s[C.FIFTH_FROM] = [
      'Grandpa moved in. So did his denture tablets, his prune juice and his ' +
        'opinions. A new colour of clog, everyone. Things ease off for a ' +
        'few levels while you adjust to the new normal.',
      'Grandpa has moved in, denture tablets and all. They fizz, they ' +
        'foam, and they bring a new colour of clog. It eases off for a few ' +
        'levels while you find your feet.',
      'Grandpa is here to stay, and his denture tablets go down the toilet ' +
        'nightly. That is a new colour of clog. Things slow down for a few ' +
        'levels so you can catch up.'
    ];
    s[C.MAX_LEVEL] = [
      'The whole extended family is home for the holidays. ' +
        'One bathroom. Three kinds of casserole. Flush this one and you are a ' +
        'legend of the trade.',
      'Final job: every Piper, every cousin, home for the holidays, and one ' +
        'bathroom between them. Flush this and retire a legend.',
      'The holidays have arrived, and so has every relative the Pipers have. ' +
        'One bathroom. One plumber. One last flush to become a legend.'
    ];
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
    'Spicy curry night. The pipes will remember this.',
    // Uncle Ray
    'Uncle Ray says this batch of chili is "mild". Uncle Ray lies.',
    'Uncle Ray brought his own toilet paper. That is never a good sign.',
    'Uncle Ray is "just popping in to use the loo". Clear the decks.',
    'Uncle Ray\'s chili has a fan club. The pipes are not members.',
    'Uncle Ray called ahead. He is bringing a slow cooker.',
    // Grandma
    'Grandma insists her prune cake is just a cake.',
    'Grandma\'s cabbage soup is simmering. Batten down the hatches.',
    'Grandma knits toilet roll covers. One went down with the roll.',
    'Grandma says in her day they just used a bucket. Nobody asked.',
    'Grandma\'s sponge cake contains three cups of bran. She calls it "regular".',
    // The dog
    'The dog drank from the toilet again. It considers this a review.',
    'The dog has learned to unroll the toilet paper. Down the hall and back.',
    'Someone washed the dog in the bath. The dog won.',
    'The dog ate a crayon. The results are, frankly, festive.',
    'The dog took a bone into the bathroom. Nobody knows why. Nobody wants to.',
    'The dog has eaten a whole sock. You know where this is going.',
    // The kids
    'The twins are timing each other in there. It is a competition now.',
    'The toddler is potty training. Everything is a potty now.',
    'The kids wanted to see if a banana would fit. It would not.',
    'The middle child insists it was not them. It was them.',
    'The eldest has started using hair gel. By the bucket.',
    'The teenager took a forty-minute shower. The drain is still recovering.',
    'Science fair week. Someone tested what dissolves. Nothing did.',
    'The kids named the plunger. It is called Gerald.',
    'Gerald the plunger is on strike. You\'re on your own.',
    'The kids put a message in a bottle. They sent it the wrong way.',
    'Mum found a toy dinosaur in the U-bend. Extinct again.',
    'Somebody flushed their retainer. They would like it back. Washed.',
    'The kids think you are a superhero. They call you Plunger Man.',
    'The goldfish has a sequel. It is a turtle.',
    // Mum and Dad
    'Mum says the kids use "a normal amount" of paper. Mum is wrong.',
    'Mum put a timer on the bathroom door. It is not helping.',
    'Dad took his phone in there an hour ago. Nobody has seen him since.',
    'Dad watched one video online and now owns a drain snake. Pray.',
    'Dad says he is "letting it soak". That was yesterday.',
    'Someone keeps leaving the seat up. The cold war continues.',
    // The household
    'Someone used the last of the paper and left the cardboard tube. A classic.',
    'There is a queue for the bathroom. There is always a queue.',
    'Somebody flushed a sock. Just the one. The other is still at large.',
    'Ever wonder where the lost socks go? You are about to find out.',
    'Somebody tried to fix it with a coat hanger. You can tell.',
    'Hair from five people, one drain. Do the maths.',
    'Someone discovered bath bombs. The bath bombs discovered the drain.',
    'There is glitter in the pipes. There will always be glitter in the pipes now.',
    'Bathroom reading has been upgraded to a full set of encyclopaedias.',
    'Somebody left a "do not use" sign on the door. Everybody used it.',
    'Somebody has been flushing chewing gum to "hide the evidence".',
    'Someone tried to flush a tissue box. Not the tissues. The box.',
    'Half a bottle of conditioner went down. At least the drain is silky.',
    'Somebody poured a whole bottle of drain cleaner in. The drain cleaner gave up.',
    'It\'s bin day. Somebody thought the toilet was the bin.',
    'The cousins visited. They left early. They left everything else.',
    'The hall cupboard holds forty rolls. That is a week, in this house.',
    'Some people collect stamps. The Pipers\' drain collects hair ties.',
    'Everyone swears they jiggled the handle.',
    'They called it an emergency. They always call it an emergency.',
    'Fun fact: no Piper has ever said "after you" outside the bathroom door.',
    'The Pipers sent a thank-you card. It is slightly damp.',
    'The Pipers\' chore chart says "unclog" on every line. With your name.',
    'The air freshener says "Mountain Breeze". The mountain has given up.',
    'Spring cleaning! Someone flushed everything that wasn\'t nailed down.',
    'The Pipers asked if you do weekends. You do now.',
    // On the menu
    'Sweetcorn season. You know why.',
    'Lentil week. Everyone is very healthy and very windy.',
    'Brussels sprouts for dinner. The house holds its breath.',
    'A cheese board was involved. Expect delays.',
    'Movie night with extra-large popcorn. The kernels are on their way.',
    'Somebody has been eating beetroot. Don\'t panic when you see it.',
    'Spaghetti night. Someone tried to drain the pasta in the toilet.',
    'Somebody tried pouring cola down the drain. Now the drain is also sticky.',
    // The trade
    'Plumbing tip: the auger is your friend. The auger has no other friends.',
    'You don\'t choose the plumbing life. The plumbing life clogs you.',
    'Business is picking up. So is the water level.',
    'It\'s all downhill from here. That is how drains work.',
    'Gravity is doing its best. Help it out.',
    'A watched pot never boils. A watched toilet always overflows.',
    'Rule one of plumbing: never ask what it was.',
    'Rule two of plumbing: if you must ask, don\'t ask the toddler.',
    'A plumber\'s best tool is a strong stomach.',
    'It\'s a dirty job, but someone has to plunge it.',
    'You are flushed with success. Mostly just flushed.',
    'Keep calm and plunge on.',
    'There\'s no "I" in team, but there\'s a "U" in U-bend.',
    'The U-bend is where hope goes to wait.',
    'Whoever said "out of sight, out of mind" never owned a drain.',
    'Water finds a way. Unfortunately, so does everything else.',
    'Your van smells faintly of the Pipers now. That is permanent.',
    'Another day, another drain. Same hair, though.',
    'You are now on first-name terms with the sewer.',
    'Pro tip: hold your breath. For the whole level.',
    'Not all heroes wear capes. Some wear rubber gloves up to the elbow.',
    'Bring a peg for your nose. Bring two.',
    'You have a sixth sense now. Sadly, it is smell.',
    'You charge extra for anything that moves. So far, nothing has moved.',
    'A plunge in time saves nine.',
    'You\'re knee-deep in this job. Hopefully only figuratively.',
    'Clogs are like the Pipers\' relatives. They always come back.',
    'You are the only person in town who rings the Pipers\' doorbell willingly.',
    // The pipes themselves
    'The bathroom fan has been running since Tuesday. It has seen things.',
    'A rubber duck went in. It did not come out quacking.',
    'Today\'s forecast: brief showers, then a strong chance of backups.',
    'The toilet made a noise like a whale. Possibly a mating call.',
    'The water is draining at roughly the speed of a Monday.',
    'The house is quiet. Too quiet. Then the toilet gurgles.',
    'It\'s raining outside. Inside, it is something else entirely.',
    'The pipes are older than the house. Possibly older than the town.',
    'This drain has a lot of history. Most of it is hair.',
    'The plumbing dates from the seventies. So does the smell.',
    'The pipes sound like an old man getting off a sofa.',
    'The toilet has developed a personality. It is not a nice one.',
    'The water is rising. Nobody panic. Well, panic a little.',
    'There\'s a light at the end of the tunnel. It is the overflow warning.',
    'The pipes groaned. You groaned back. It felt like progress.',
    'Whatever you do, don\'t look directly into the drain.',
    'This pipe is a lot like the Pipers: full of surprises, none of them good.'
  ];

  function pick(options, rand, avoid) {
    var pool = options;
    if (avoid && avoid.length) {
      var fresh = options.filter(function (o) { return avoid.indexOf(o) < 0; });
      if (fresh.length) pool = fresh;
    }
    var i = Math.floor(rand() * pool.length);
    return pool[Math.min(Math.max(i, 0), pool.length - 1)];
  }

  function quipFor(level, C, challenge, rand, avoid) {
    var story = storyFor(C, challenge)[level];
    if (typeof rand === 'function') return pick(story || POOL, rand, avoid);
    if (story) return story[0];
    return POOL[Math.abs(level || 0) % POOL.length];
  }

  return { quipFor: quipFor, storyFor: storyFor, POOL: POOL };
});
