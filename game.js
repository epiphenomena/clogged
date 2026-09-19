/* Clogged — rendering, input and the game loop. Core rules live in core.js. */
(function () {
  'use strict';

  var C = self.Core;
  var W = C.W, H = C.H;

  var LOCK_DELAY = 320;   // grace period to slide a landed coupling
  var MAX_LOCK_RESETS = 8;
  var CLEAR_MS = 260;     // dissolve animation
  var SETTLE_MS = 52;     // per row of post-clear gravity
  var DRIP_MS = 34;       // per row of a clog washing down the pipe
  var TAP_MS = 280;       // a press shorter than this, that barely moved, is a tap
  var TAP_SLOP = 11;      // px of movement still considered a tap
  var FLICK_VY = 1.0;     // px/ms downward to count as a slam

  var reduceMotion = self.matchMedia
    && self.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Enamelled pipe colours: edge -> sheen -> body -> shadow, for tube shading.
  var PALETTE = [
    { light: '#9ff6ea', main: '#2dd4bf', dark: '#12897c', deep: '#084a44', rgb: '45,212,191' },
    { light: '#ffdf9a', main: '#f59e0b', dark: '#a96a06', deep: '#5f3a03', rgb: '245,158,11' },
    { light: '#f9c7ff', main: '#e879f9', dark: '#a132ba', deep: '#5c1a6b', rgb: '232,121,249' }
  ];

  var $ = function (id) { return document.getElementById(id); };

  var boardCv = $('board'), bctx = boardCv.getContext('2d');
  var nextCv = $('next'), nctx = nextCv.getContext('2d');
  var hud = $('hud');

  // Measures the bottom safe-area inset, which CSS knows and JS otherwise doesn't.
  var safeProbe = document.createElement('div');
  safeProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;' +
    'height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden;';
  document.body.appendChild(safeProbe);

  /* ------------------------------------------------------------- storage */

  var Store = {
    get: function (k, d) {
      try {
        var v = localStorage.getItem('clogged.' + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('clogged.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ }
    }
  };

  /* --------------------------------------------------------------- audio */

  var Sound = {
    ctx: null,
    muted: Store.get('muted', false),
    init: function () {
      if (this.ctx) return;
      var AC = self.AudioContext || self.webkitAudioContext;
      if (AC) this.ctx = new AC();
    },
    // iOS starts the context suspended; this must run inside a user gesture.
    unlock: function () {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone: function (freq, dur, type, vol, delay) {
      if (this.muted || !this.ctx) return;
      var t0 = this.ctx.currentTime + (delay || 0);
      var osc = this.ctx.createOscillator();
      var gain = this.ctx.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol || 0.09, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
    sweep: function (from, to, dur, type, vol, delay) {
      if (this.muted || !this.ctx) return;
      var t0 = this.ctx.currentTime + (delay || 0);
      var osc = this.ctx.createOscillator();
      var gain = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(from, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol || 0.07, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
    lastMove: 0,
    move: function () {
      var now = self.performance ? performance.now() : 0;
      if (now - this.lastMove < 45) return;
      this.lastMove = now;
      this.tone(180, 0.04, 'square', 0.045);
    },
    rotate: function () { this.tone(430, 0.06, 'triangle', 0.06); },
    lock: function () { this.tone(120, 0.1, 'sine', 0.11); },
    clear: function (chain) {
      var base = 480 * Math.pow(1.16, Math.min(chain - 1, 5));
      this.tone(base, 0.1, 'square', 0.08);
      this.tone(base * 1.5, 0.13, 'square', 0.06, 0.06);
      this.tone(base * 2, 0.16, 'triangle', 0.05, 0.12);
    },
    pressure: function () { this.sweep(240, 520, 0.34, 'sawtooth', 0.05); },
    drip: function () { this.sweep(680, 180, 0.22, 'sine', 0.07); },
    // A rising rush of water.
    flush: function () {
      this.sweep(320, 1500, 0.9, 'sine', 0.07);
      [659, 784, 988, 1319].forEach(function (f, i) {
        Sound.tone(f, 0.22, 'triangle', 0.07, 0.25 + i * 0.1);
      });
    },
    // A thick descending glug.
    sludge: function () {
      this.sweep(200, 40, 1.1, 'sawtooth', 0.09);
      [160, 120, 90].forEach(function (f, i) {
        Sound.tone(f, 0.3, 'square', 0.05, 0.2 + i * 0.22);
      });
    }
  };

  /* --------------------------------------------------------------- state */

  var S = {
    phase: 'menu',        // menu | play | clearing | settling | paused | levelclear | gameover
    board: C.makeBoard(),
    piece: null,
    nextColors: C.randomColors(),
    level: 0,
    startLevel: Store.get('startLevel', 0),
    score: 0,
    best: Store.get('best', 0),
    chain: 0,
    fallTimer: 0,
    lockPending: false,
    lockTimer: 0,
    lockResets: 0,
    clearSet: null,
    clearTimer: 0,
    settleTimer: 0,
    pending: [],          // clogs still to wash down this level
    sinceDrip: 0,         // couplings landed since the last arrival
    drip: null,           // {col, color, row, target} while one is falling
    levelElapsed: 0,      // drives the pressure ramp
    pressure: 0,
    shake: 0,
    toast: null,
    fx: null,
    hint: 1,              // fades out once the player gets going
    locks: 0,
    recorded: false,     // has the current run been filed into history yet
    lastRunAt: 0,        // timestamp of the run just filed, for highlighting
    scoresReturn: 'ov-menu',
    resumePhase: 'play'
  };

  var Sc = self.Scores;
  var history = Sc.seedBest(Sc.sanitize(Store.get('history', null)), S.best);

  var view = { cell: 24, wall: 7, collar: 13, grate: 11, x0: 0, y0: 0, vw: 0, vh: 0, dpr: 1, bg: null };

  /* -------------------------------------------------------------- layout */

  function layout() {
    var vw = Math.round(document.documentElement.clientWidth);
    var vh = Math.round(document.documentElement.clientHeight);
    var hudH = Math.round(hud.getBoundingClientRect().height);
    var safeBottom = Math.round(safeProbe.getBoundingClientRect().height || 0);

    var padTop = hudH;
    var padBottom = safeBottom + 2;
    var availH = Math.max(120, vh - padTop - padBottom);

    // The pipe runs nearly edge to edge; the side walls take a fixed sliver
    // rather than a share of the cell, so the playfield gets the rest.
    var wall = Math.max(4, Math.round(vw * 0.018));
    var cell = Math.floor(Math.min((vw - wall * 2) / W, availH / H));
    cell = Math.max(10, Math.min(cell, 96));

    var collar = Math.max(7, Math.round(cell * 0.5));
    var grate = Math.max(6, Math.round(cell * 0.42));
    var boardW = W * cell, boardH = H * cell;

    var dpr = Math.min(self.devicePixelRatio || 1, 2.5);
    var same = view.cell === cell && view.vw === vw && view.vh === vh && view.dpr === dpr;

    view.cell = cell;
    view.wall = wall;
    view.collar = collar;
    view.grate = grate;
    view.x0 = Math.round((vw - boardW) / 2);
    view.y0 = padTop + Math.max(0, Math.round((availH - boardH) / 2));
    view.vw = vw;
    view.vh = vh;
    view.dpr = dpr;

    if (same) return; // nothing to rebuild; repainting the scene is expensive

    boardCv.width = Math.round(vw * dpr);
    boardCv.height = Math.round(vh * dpr);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    nextCv.width = Math.round(48 * dpr);
    nextCv.height = Math.round(24 * dpr);
    nctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    view.bg = buildScene(vw, vh, cell, dpr);
    buildSprites(cell, dpr);
    drawNext();
  }

  // The tiled wall and the whole static pipe — walls, collar, grate, grid.
  // Built once per layout and blitted each frame, which is the difference
  // between ~2000 path operations per frame and one drawImage.
  function buildScene(vw, vh, cell, dpr) {
    var c = document.createElement('canvas');
    c.width = Math.round(vw * dpr);
    c.height = Math.round(vh * dpr);
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    g.fillStyle = '#0d1322';
    g.fillRect(0, 0, vw, vh);

    var t = Math.max(30, cell * 1.5);
    g.fillStyle = 'rgba(255,255,255,0.018)';
    for (var y = 0; y < vh; y += t) {
      for (var x = 0; x < vw; x += t) {
        if (((x / t | 0) + (y / t | 0)) % 2 === 0) g.fillRect(x, y, t - 2, t - 2);
      }
    }
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    for (var gx = 0; gx <= vw; gx += t) {
      g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, vh); g.stroke();
    }
    for (var gy = 0; gy <= vh; gy += t) {
      g.beginPath(); g.moveTo(0, gy); g.lineTo(vw, gy); g.stroke();
    }

    var vig = g.createRadialGradient(vw / 2, vh * 0.42, Math.min(vw, vh) * 0.18,
      vw / 2, vh * 0.5, Math.max(vw, vh) * 0.78);
    vig.addColorStop(0, 'rgba(46,70,124,0.22)');
    vig.addColorStop(1, 'rgba(0,0,0,0.62)');
    g.fillStyle = vig;
    g.fillRect(0, 0, vw, vh);

    paintPipe(g, vw, vh, cell);
    return c;
  }

  // The pipe casing runs off the top and bottom of the screen, so the drain
  // reads as continuing past the viewport instead of floating in a margin.
  function paintPipe(ctx, vw, vh, cell) {
    var v = view;
    var boardW = W * cell, boardH = H * cell;
    var outerX = v.x0 - v.wall, outerW = boardW + v.wall * 2;
    var top = v.y0, bottom = v.y0 + boardH;

    // side walls, full screen height
    ctx.fillStyle = metal(ctx, outerX, 0, v.wall, vh);
    ctx.fillRect(outerX, 0, v.wall, vh);
    ctx.fillStyle = metal(ctx, v.x0 + boardW, 0, v.wall, vh);
    ctx.fillRect(v.x0 + boardW, 0, v.wall, vh);

    // pipe interior continuing above the playfield and below the grate
    ctx.fillStyle = '#0a0f1c';
    ctx.fillRect(v.x0, 0, boardW, top);
    ctx.fillRect(v.x0, bottom, boardW, vh - bottom);

    // the well
    ctx.fillStyle = '#070a13';
    ctx.fillRect(v.x0, top, boardW, boardH);

    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x0, top, boardW, boardH);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.032)';
    ctx.lineWidth = 1;
    for (var c = 1; c < W; c++) {
      ctx.beginPath();
      ctx.moveTo(v.x0 + c * cell + 0.5, top);
      ctx.lineTo(v.x0 + c * cell + 0.5, bottom);
      ctx.stroke();
    }
    for (var r = 1; r < H; r++) {
      ctx.beginPath();
      ctx.moveTo(v.x0, top + r * cell + 0.5);
      ctx.lineTo(v.x0 + boardW, top + r * cell + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // threaded collar at the mouth
    var collarTop = Math.max(0, top - v.collar);
    ctx.fillStyle = metal(ctx, outerX, collarTop, outerW, top - collarTop);
    ctx.fillRect(outerX, collarTop, outerW, top - collarTop);
    ctx.strokeStyle = 'rgba(0,0,0,0.32)';
    ctx.lineWidth = 1;
    for (var th = 1; th < 3; th++) {
      var ty = collarTop + ((top - collarTop) / 3) * th;
      ctx.beginPath(); ctx.moveTo(outerX, ty); ctx.lineTo(outerX + outerW, ty); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(v.x0, top - Math.max(1, cell * 0.04), boardW, Math.max(1, cell * 0.04));

    // drain grate below
    ctx.fillStyle = metal(ctx, outerX, bottom, outerW, v.grate);
    ctx.fillRect(outerX, bottom, outerW, v.grate);
    ctx.fillStyle = 'rgba(6,9,16,0.78)';
    var slots = 5, sw = boardW / (slots * 2 + 1);
    for (var sI = 0; sI < slots; sI++) {
      ctx.fillRect(v.x0 + sw * (sI * 2 + 1), bottom + v.grate * 0.28, sw, v.grate * 0.44);
    }

    // rivets down both walls
    ctx.fillStyle = 'rgba(255,255,255,0.17)';
    var rr = Math.max(1, v.wall * 0.22);
    for (var y = cell * 0.9; y < vh; y += cell * 2.7) {
      ctx.beginPath(); ctx.arc(outerX + v.wall / 2, y, rr, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(v.x0 + boardW + v.wall / 2, y, rr, 0, Math.PI * 2); ctx.fill();
    }
  }

  /* ------------------------------------------------------------ painting */

  function roundRect(ctx, x, y, w, h, r) {
    var tl = r[0], tr = r[1], br = r[2], bl = r[3];
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
  }

  function metal(ctx, x, y, w, h) {
    var g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#cdd6ea');
    g.addColorStop(0.42, '#7b88ad');
    g.addColorStop(0.75, '#4a5474');
    g.addColorStop(1, '#2d3550');
    return g;
  }

  // A shape cue per colour, so the game works without colour vision. The
  // hairball core is dark and low-contrast, so this matters more, not less.
  function glyph(ctx, cx, cy, s, color, alpha) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha || 0.62) + ')';
    ctx.lineWidth = Math.max(1.2, s * 0.075);
    ctx.lineCap = 'round';
    var g = s * 0.16;
    ctx.beginPath();
    if (color === 0) {
      ctx.arc(cx, cy, g, 0, Math.PI * 2);
    } else if (color === 1) {
      ctx.moveTo(cx - g, cy); ctx.lineTo(cx + g, cy);
    } else {
      ctx.moveTo(cx - g, cy - g); ctx.lineTo(cx + g, cy + g);
      ctx.moveTo(cx + g, cy - g); ctx.lineTo(cx - g, cy + g);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Tube shading: dark rim, bright sheen line, body, deep shadow.
  function pipeBody(ctx, x, y, w, h, color, horizontal, radii) {
    var P = PALETTE[color];
    var g = horizontal
      ? ctx.createLinearGradient(0, y, 0, y + h)
      : ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, P.dark);
    g.addColorStop(0.22, P.light);
    g.addColorStop(0.5, P.main);
    g.addColorStop(0.85, P.dark);
    g.addColorStop(1, P.deep);
    roundRect(ctx, x, y, w, h, radii);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = Math.max(1, w * 0.035);
    ctx.stroke();
  }

  // The bolted ring where two halves meet.
  function flange(ctx, x, y, s, link) {
    var band = s * 0.13;
    var horiz = link === 'left' || link === 'right';
    var bx, by, bw, bh;
    if (link === 'right') { bx = x + s - band; by = y + s * 0.08; bw = band; bh = s * 0.84; }
    else if (link === 'left') { bx = x; by = y + s * 0.08; bw = band; bh = s * 0.84; }
    else if (link === 'down') { bx = x + s * 0.08; by = y + s - band; bw = s * 0.84; bh = band; }
    else { bx = x + s * 0.08; by = y; bw = s * 0.84; bh = band; }

    ctx.fillStyle = metal(ctx, bx, by, bw, bh);
    roundRect(ctx, bx, by, bw, bh, [s * 0.03, s * 0.03, s * 0.03, s * 0.03]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // two bolts on the ring
    ctx.fillStyle = 'rgba(20,26,44,0.75)';
    var r = Math.max(0.8, s * 0.032);
    var cx = bx + bw / 2, cy = by + bh / 2;
    var off = horiz ? bh * 0.3 : bw * 0.3;
    ctx.beginPath();
    ctx.arc(horiz ? cx : cx - off, horiz ? cy - off : cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(horiz ? cx : cx + off, horiz ? cy + off : cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // The open mouth at the free end of a pipe section.
  function mouth(ctx, cx, cy, rx, ry) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,11,20,0.5)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = Math.max(1, rx * 0.5);
    ctx.stroke();
    ctx.restore();
  }

  // One half of a coupling. A half whose partner was flushed loses its flange
  // and shrinks to a loose plug, so free-falling pieces are obvious at a glance.
  function drawSegment(ctx, x, y, s, color, link) {
    var pad = s * 0.05;
    var X = x + pad, Y = y + pad, Sz = s - pad * 2;
    var soft = s * 0.3, tight = s * 0.07;

    if (link === 'right' || link === 'left') {
      var rh = link === 'right' ? [soft, tight, tight, soft] : [tight, soft, soft, tight];
      pipeBody(ctx, X, Y, Sz, Sz, color, true, rh);
      mouth(ctx, link === 'right' ? X + Sz * 0.11 : X + Sz * 0.89, Y + Sz / 2, Sz * 0.05, Sz * 0.3);
      flange(ctx, x, y, s, link);
    } else if (link === 'up' || link === 'down') {
      var rv = link === 'down' ? [soft, soft, tight, tight] : [tight, tight, soft, soft];
      pipeBody(ctx, X, Y, Sz, Sz, color, false, rv);
      mouth(ctx, X + Sz / 2, link === 'down' ? Y + Sz * 0.11 : Y + Sz * 0.89, Sz * 0.3, Sz * 0.05);
      flange(ctx, x, y, s, link);
    } else {
      var q = s * 0.12;
      var rr = (s - q * 2) * 0.34;
      pipeBody(ctx, x + q, y + q, s - q * 2, s - q * 2, color, true, [rr, rr, rr, rr]);
      ctx.fillStyle = 'rgba(20,26,44,0.6)';
      ctx.beginPath();
      ctx.arc(x + s / 2, y + s / 2, Math.max(1, s * 0.045), 0, Math.PI * 2);
      ctx.fill();
    }

    glyph(ctx, x + s / 2, y + s / 2, s, color, 0.6);
  }

  // A hairball: a matted core buried in a thick tangle of strands. This is only
  // ever drawn into a sprite, so it can afford to be genuinely hairy.
  function drawClog(ctx, x, y, s, color, seed) {
    var P = PALETTE[color];
    var cx = x + s / 2, cy = y + s / 2;
    var R = s * 0.27;
    // Deterministic scatter per variant, so each sprite is a different tangle.
    var n = seed * 9781 + 1;
    var rnd = function () {
      n = (n * 1103515245 + 12345) & 0x7fffffff;
      return n / 0x7fffffff;
    };

    ctx.save();
    ctx.lineCap = 'round';

    // Under-layer: long wild strays that escape the clump.
    for (var w = 0; w < 20; w++) {
      var aw = rnd() * Math.PI * 2;
      var reachW = R * (1.25 + rnd() * 0.5);
      var curlW = (rnd() - 0.5) * 3.2;
      ctx.strokeStyle = P.dark;
      ctx.globalAlpha = 0.3 + rnd() * 0.3;
      ctx.lineWidth = Math.max(0.7, s * 0.022);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(aw) * R * 0.4, cy + Math.sin(aw) * R * 0.4);
      ctx.quadraticCurveTo(
        cx + Math.cos(aw + curlW * 0.4) * reachW * 1.2,
        cy + Math.sin(aw + curlW * 0.4) * reachW * 1.2,
        cx + Math.cos(aw + curlW) * reachW,
        cy + Math.sin(aw + curlW) * reachW);
      ctx.stroke();
    }

    // Main tangle: strands curl around the ball rather than spiking out, which
    // is the difference between reading as hair and reading as a sea urchin.
    for (var i = 0; i < 46; i++) {
      var a = (i / 46) * Math.PI * 2 + rnd() * 0.5;
      var r0 = R * (0.35 + rnd() * 0.5);
      var reach = R * (0.9 + rnd() * 0.55);
      var curl = 1.0 + (rnd() - 0.5) * 1.8;
      ctx.strokeStyle = rnd() < 0.34 ? P.light : P.main;
      ctx.globalAlpha = 0.3 + rnd() * 0.45;
      ctx.lineWidth = Math.max(0.8, s * (0.02 + rnd() * 0.018));
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.quadraticCurveTo(
        cx + Math.cos(a + curl * 0.45) * reach * 1.18,
        cy + Math.sin(a + curl * 0.45) * reach * 1.18,
        cx + Math.cos(a + curl) * reach * 0.82,
        cy + Math.sin(a + curl) * reach * 0.82);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // matted core, lumpy rather than round
    ctx.beginPath();
    for (var k = 0; k <= 11; k++) {
      var ang = (k / 11) * Math.PI * 2;
      var rad = R * (0.86 + Math.sin(ang * 3 + seed) * 0.13);
      var px = cx + Math.cos(ang) * rad, py = cy + Math.sin(ang) * rad;
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    var g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R * 1.2);
    g.addColorStop(0, P.dark);
    g.addColorStop(0.6, P.deep);
    g.addColorStop(1, '#16111c');
    ctx.fillStyle = g;
    ctx.fill();

    // hairs lying over the clump, so the core looks wound rather than drawn on
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(0.8, s * 0.02);
    for (var j = 0; j < 22; j++) {
      var a2 = rnd() * Math.PI * 2;
      ctx.strokeStyle = rnd() < 0.5 ? P.main : P.light;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a2) * R, cy + Math.sin(a2) * R);
      ctx.quadraticCurveTo(
        cx + (rnd() - 0.5) * R * 0.9, cy + (rnd() - 0.5) * R * 0.9,
        cx + Math.cos(a2 + 1.6 + rnd()) * R, cy + Math.sin(a2 + 1.6 + rnd()) * R);
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();

    glyph(ctx, cx, cy, s, color, 0.8);
  }

  /* ------------------------------------------------------------- sprites */

  // Every cell is one of a small fixed set of pictures, so they are drawn once
  // per layout and blitted thereafter. Hairballs get several variants so a
  // field of them does not look stamped.
  var CLOG_VARIANTS = 5;
  var sprites = { seg: null, clog: null };

  function spriteCanvas(cell, dpr, paint) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(cell * dpr));
    c.height = Math.max(1, Math.round(cell * dpr));
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(g);
    return c;
  }

  function buildSprites(cell, dpr) {
    var links = ['left', 'right', 'up', 'down', 'none'];
    sprites.seg = [];
    sprites.clog = [];
    for (var color = 0; color < PALETTE.length; color++) {
      var byLink = {};
      for (var l = 0; l < links.length; l++) {
        (function (link) {
          byLink[link] = spriteCanvas(cell, dpr, function (g) {
            drawSegment(g, 0, 0, cell, color, link === 'none' ? null : link);
          });
        })(links[l]);
      }
      sprites.seg.push(byLink);

      var variants = [];
      for (var v = 0; v < CLOG_VARIANTS; v++) {
        (function (seed) {
          variants.push(spriteCanvas(cell, dpr, function (g) {
            drawClog(g, 0, 0, cell, color, seed);
          }));
        })(v + 1);
      }
      sprites.clog.push(variants);
    }
  }

  function segSprite(color, link) {
    return sprites.seg ? sprites.seg[color][link || 'none'] : null;
  }

  function clogSprite(color, i) {
    return sprites.clog ? sprites.clog[color][i % CLOG_VARIANTS] : null;
  }

  function blit(ctx, sprite, x, y, s) {
    if (sprite) ctx.drawImage(sprite, x, y, s, s);
  }

  function cellXY(c, r) {
    return { x: view.x0 + c * view.cell, y: view.y0 + r * view.cell };
  }

  // Everything static about the pipe lives in the scene bitmap; only the
  // warning frame changes from frame to frame.
  function drawPipe(t) {
    var choked = false;
    for (var i = 0; i < W * 2; i++) if (S.board[i]) { choked = true; break; }
    if (!choked || S.phase === 'gameover') return;
    var ctx = bctx, v = view;
    var pulse = 0.3 + Math.sin(t * 0.006) * 0.2;
    ctx.strokeStyle = 'rgba(251,113,133,' + pulse.toFixed(3) + ')';
    ctx.lineWidth = Math.max(2, v.cell * 0.1);
    ctx.strokeRect(v.x0 + 1, v.y0 + 1, W * v.cell - 2, v.cell * 2 - 2);
  }

  function drawBoard() {
    var ctx = bctx, s = view.cell;
    var clearing = S.clearSet;
    var p = clearing ? Math.min(1, S.clearTimer / CLEAR_MS) : 0;

    for (var i = 0; i < S.board.length; i++) {
      var cell = S.board[i];
      if (!cell) continue;
      var x = view.x0 + C.colOf(i) * s;
      var y = view.y0 + C.rowOf(i) * s;
      var sprite = cell.type === 'clog'
        ? clogSprite(cell.color, i)
        : segSprite(cell.color, cell.link);

      if (!clearing || !clearing.has(i)) {
        blit(ctx, sprite, x, y, s);
        continue;
      }

      ctx.save();
      ctx.globalAlpha = 1 - p * 0.85;
      var k = 1 + p * 0.25;
      ctx.translate(x + s / 2, y + s / 2);
      ctx.scale(k, k);
      blit(ctx, sprite, -s / 2, -s / 2, s);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.85;
      ctx.strokeStyle = '#dff9ff';
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.beginPath();
      ctx.arc(x + s / 2, y + s / 2, s * (0.25 + p * 0.5), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawPiece() {
    if (!S.piece || (S.phase !== 'play' && S.phase !== 'paused')) return;
    var ctx = bctx, s = view.cell;
    var cells = C.pieceCells(S.piece);

    // Column guide — the single biggest aiming aid on a small screen.
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.055)';
    cells.forEach(function (cl) {
      ctx.fillRect(view.x0 + cl.c * s, view.y0, s, H * s);
    });
    ctx.restore();

    var dist = C.dropDistance(S.board, S.piece);
    if (dist > 0) {
      ctx.save();
      ctx.globalAlpha = 0.38;
      cells.forEach(function (cl) {
        var pos = cellXY(cl.c, cl.r + dist);
        roundRect(ctx, pos.x + s * 0.14, pos.y + s * 0.14, s * 0.72, s * 0.72,
          [s * 0.2, s * 0.2, s * 0.2, s * 0.2]);
        ctx.strokeStyle = PALETTE[cl.color].main;
        ctx.lineWidth = Math.max(1.5, s * 0.07);
        ctx.setLineDash([s * 0.16, s * 0.13]);
        ctx.stroke();
      });
      ctx.restore();
    }

    cells.forEach(function (cl) {
      if (cl.r < 0) return;
      var pos = cellXY(cl.c, cl.r);
      blit(ctx, segSprite(cl.color, cl.link), pos.x, pos.y, s);
    });
  }

  // A clog washing down the pipe, with a marker on the cell it is heading for
  // so the landing is never a surprise.
  function drawDrip(t) {
    if (!S.drip) return;
    var ctx = bctx, sz = view.cell;
    var d = S.drip;

    var pos = cellXY(d.col, d.target);
    ctx.save();
    ctx.globalAlpha = 0.35 + Math.sin(t * 0.012) * 0.12;
    roundRect(ctx, pos.x + sz * 0.14, pos.y + sz * 0.14, sz * 0.72, sz * 0.72,
      [sz * 0.24, sz * 0.24, sz * 0.24, sz * 0.24]);
    ctx.strokeStyle = PALETTE[d.color].main;
    ctx.lineWidth = Math.max(1.5, sz * 0.07);
    ctx.setLineDash([sz * 0.14, sz * 0.12]);
    ctx.stroke();
    ctx.restore();

    var y = view.y0 + d.row * sz;
    // a wet streak trailing behind it
    ctx.save();
    var g = ctx.createLinearGradient(0, y - sz * 1.6, 0, y + sz);
    g.addColorStop(0, 'rgba(' + PALETTE[d.color].rgb + ',0)');
    g.addColorStop(1, 'rgba(' + PALETTE[d.color].rgb + ',0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(view.x0 + d.col * sz + sz * 0.3, Math.max(view.y0, y - sz * 1.6),
      sz * 0.4, Math.min(sz * 1.6, y - view.y0 + sz * 0.5));
    ctx.restore();

    blit(ctx, clogSprite(d.color, d.col + d.target), view.x0 + d.col * sz, y, sz);
  }

  function drawToast() {
    if (!S.toast) return;
    var ctx = bctx;
    var p = S.toast.t / 950;
    if (p >= 1) { S.toast = null; return; }
    ctx.save();
    ctx.globalAlpha = 1 - p;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 ' + Math.round(view.cell * 0.66) + 'px system-ui, sans-serif';
    ctx.fillStyle = S.toast.color;
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 10;
    ctx.fillText(S.toast.text, view.vw / 2,
      view.y0 + H * view.cell * 0.34 - p * view.cell * 1.6);
    ctx.restore();
  }

  function drawHint() {
    if (S.hint <= 0.01 || S.phase !== 'play') return;
    var ctx = bctx;
    ctx.save();
    ctx.globalAlpha = S.hint * 0.85;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 ' + Math.max(11, Math.round(view.cell * 0.3)) + 'px system-ui, sans-serif';
    ctx.fillStyle = '#9fb0d6';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 6;
    var y = view.y0 + H * view.cell - view.cell * 0.9;
    ctx.fillText('Drag to aim · tap to spin · flick down to slam', view.vw / 2, y);
    ctx.restore();
  }

  function drawNext() {
    var ctx = nctx;
    ctx.clearRect(0, 0, 48, 24);
    if (!S.nextColors) return;
    var s = 24;
    blit(ctx, segSprite(S.nextColors[0], 'right'), 0, 0, s);
    blit(ctx, segSprite(S.nextColors[1], 'left'), s, 0, s);
  }

  /* ------------------------------------------------- win / lose effects */

  function fxFront(p, vh) {
    return -vh * 0.12 + p * p * (vh * 1.25);
  }

  // Sludge oozing down over everything.
  function drawSludge(ctx, p, vw, vh, t) {
    var front = fxFront(p, vh);
    var g = ctx.createLinearGradient(0, 0, 0, Math.max(10, front));
    g.addColorStop(0, '#241507');
    g.addColorStop(0.55, '#513315');
    g.addColorStop(1, '#7d5524');

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(vw, 0);
    ctx.lineTo(vw, front);
    for (var x = vw; x >= 0; x -= 10) {
      ctx.lineTo(x, front + Math.sin(x * 0.021 + t * 0.003) * vh * 0.012
        + Math.sin(x * 0.006 + 1.7) * vh * 0.018);
    }
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    // hanging drips
    ctx.fillStyle = '#46290f';
    for (var i = 0; i < 7; i++) {
      var dx = (i + 0.5) / 7 * vw + Math.sin(i * 2.1) * vw * 0.05;
      var len = vh * (0.035 + 0.075 * Math.abs(Math.sin(i * 1.7 + 0.5)));
      var dy = front + len * (0.35 + 0.65 * p);
      ctx.beginPath();
      ctx.moveTo(dx - vw * 0.033, front - 2);
      ctx.quadraticCurveTo(dx, dy, dx + vw * 0.033, front - 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(dx, dy, vw * 0.016, 0, Math.PI * 2);
      ctx.fill();
    }

    // Rivulets and lumps spread over everything already covered, so the sludge
    // still looks like sludge once it has settled rather than a flat wash.
    var cover = Math.min(front, vh);
    for (var v = 0; v < 9; v++) {
      var vx = ((v * 71) % 100) / 100 * vw;
      var vwid = vw * (0.03 + (v % 3) * 0.022);
      var lg = ctx.createLinearGradient(vx, 0, vx + vwid, 0);
      lg.addColorStop(0, 'rgba(26,15,6,0)');
      lg.addColorStop(0.5, 'rgba(26,15,6,0.5)');
      lg.addColorStop(1, 'rgba(26,15,6,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(vx, 0, vwid, cover);
    }

    ctx.fillStyle = 'rgba(28,16,6,0.55)';
    for (var b = 0; b < 18; b++) {
      var bx = ((b * 97) % 100) / 100 * vw;
      var by = ((b * 57) % 100) / 100 * cover;
      ctx.beginPath();
      ctx.arc(bx, by, vw * (0.01 + (b % 4) * 0.007), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(146,105,50,0.25)';
    for (var h = 0; h < 10; h++) {
      var hx = ((h * 37) % 100) / 100 * vw;
      var hy = ((h * 83) % 100) / 100 * cover;
      ctx.beginPath();
      ctx.arc(hx, hy, vw * 0.008, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // A clean rush of water washing the pipe out.
  function drawFlush(ctx, p, vw, vh, t) {
    var front = fxFront(p, vh);
    var g = ctx.createLinearGradient(0, 0, 0, Math.max(10, front));
    g.addColorStop(0, 'rgba(214,245,255,0.94)');
    g.addColorStop(0.5, 'rgba(96,203,240,0.9)');
    g.addColorStop(1, 'rgba(45,160,220,0.86)');

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(vw, 0);
    ctx.lineTo(vw, front);
    for (var x = vw; x >= 0; x -= 10) {
      ctx.lineTo(x, front + Math.sin(x * 0.03 + t * 0.008) * vh * 0.014);
    }
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();

    // falling streaks
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = Math.max(1, vw * 0.005);
    for (var i = 0; i < 14; i++) {
      var sx = ((i * 83) % 100) / 100 * vw;
      var sy = front - vh * (0.05 + ((i * 29) % 60) / 100);
      if (sy < 0) continue;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx, Math.min(front, sy + vh * 0.05));
      ctx.stroke();
    }

    // foam along the leading edge
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    for (var f = 0; f < 16; f++) {
      var fx = ((f * 61) % 100) / 100 * vw + Math.sin(t * 0.004 + f) * vw * 0.01;
      ctx.beginPath();
      ctx.arc(fx, front + Math.sin(fx * 0.03 + t * 0.008) * vh * 0.014,
        vw * (0.012 + (f % 4) * 0.006), 0, Math.PI * 2);
      ctx.fill();
    }

    // bubbles rising through it
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    for (var b = 0; b < 12; b++) {
      var bx = ((b * 53) % 100) / 100 * vw;
      var by = front - vh * (0.1 + ((b * 41 + t * 0.04) % 80) / 100);
      if (by < 0) continue;
      ctx.beginPath();
      ctx.arc(bx, by, vw * (0.008 + (b % 3) * 0.006), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function startFx(kind, overlayId) {
    S.fx = {
      kind: kind,
      overlay: overlayId,
      t: 0,
      dur: reduceMotion ? 260 : 1350,
      shown: false
    };
    document.body.classList.add('fx-active');
    if (kind === 'flush') Sound.flush(); else Sound.sludge();
  }

  function drawFx(t) {
    if (!S.fx) return;
    var p = Math.min(1, S.fx.t / S.fx.dur);
    if (S.fx.kind === 'flush') drawFlush(bctx, p, view.vw, view.vh, t);
    else drawSludge(bctx, p, view.vw, view.vh, t);
  }

  function render(t) {
    bctx.save();
    bctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    if (view.bg) bctx.drawImage(view.bg, 0, 0, view.vw, view.vh);
    else { bctx.fillStyle = '#0d1322'; bctx.fillRect(0, 0, view.vw, view.vh); }

    if (S.shake > 0.2) {
      bctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);
    }
    drawPipe(t);
    bctx.save();
    bctx.beginPath();
    bctx.rect(view.x0, view.y0, W * view.cell, H * view.cell);
    bctx.clip();
    drawBoard();
    drawPiece();
    drawDrip(t);
    drawHint();
    drawToast();
    bctx.restore();
    bctx.restore();

    drawFx(t);
  }

  /* ----------------------------------------------------------- game flow */

  var hudShown = { score: -1, best: -1, level: -1, clogs: -1 };

  function refreshHUD() {
    var clogs = C.countClogs(S.board) + S.pending.length;
    if (S.score !== hudShown.score) { $('hud-score').textContent = hudShown.score = S.score; }
    if (S.best !== hudShown.best) { $('hud-best').textContent = hudShown.best = S.best; }
    if (S.level !== hudShown.level) { $('hud-level').textContent = hudShown.level = S.level; }
    if (clogs !== hudShown.clogs) { $('hud-clogs').textContent = hudShown.clogs = clogs; }
  }

  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function hideAllOverlays() {
    ['ov-menu', 'ov-pause', 'ov-clear', 'ov-gameover'].forEach(hide);
  }

  function saveBest() {
    if (S.score > S.best) {
      S.best = S.score;
      Store.set('best', S.best);
    }
  }

  // A run ends when it tops out or when its score is about to be discarded.
  // Recorded once, so retrying after a game over does not file it twice.
  function endRun() {
    saveBest();
    if (S.score <= 0 || S.recorded) return;
    S.recorded = true;
    S.lastRunAt = Date.now();
    history = Sc.add(history, { s: S.score, l: S.level, t: S.lastRunAt });
    Store.set('history', history);
  }

  function toast(text, color) {
    S.toast = { text: text, color: color, t: 0 };
  }

  function startLevel(level, keepScore) {
    // Banked here rather than at each call site, so no entry point can drop a
    // run's score on the floor (restarting mid-game used to). Advancing a level
    // keeps the same run going, so it must not file one.
    if (!keepScore) { endRun(); S.recorded = false; }
    S.level = Math.max(0, Math.min(C.MAX_LEVEL, level));
    var built = C.seedLevel(S.level);
    S.board = built.board;
    S.pending = built.pending;
    S.sinceDrip = 0;
    S.drip = null;
    if (!keepScore) S.score = 0;
    S.chain = 0;
    S.clearSet = null;
    S.toast = null;
    S.fx = null;
    document.body.classList.remove('fx-active');
    S.levelElapsed = 0;
    S.pressure = 0;
    S.locks = 0;
    S.hint = 1;
    S.nextColors = C.randomColors();
    hideAllOverlays();
    spawn();
    refreshHUD();
  }

  function spawn() {
    S.piece = C.spawnPiece(S.nextColors);
    S.nextColors = C.randomColors();
    drawNext();
    S.fallTimer = 0;
    S.lockPending = false;
    S.lockTimer = 0;
    S.lockResets = 0;
    S.chain = 0;
    gesture = null;
    if (!C.fits(S.board, S.piece)) {
      S.piece = null;
      gameOver();
      return;
    }
    S.phase = 'play';
  }

  function gameOver() {
    S.phase = 'gameover';
    endRun();
    $('go-score').textContent = 'Score: ' + S.score;
    $('go-best').textContent = 'Best: ' + S.best;
    refreshHUD();
    startFx('sludge', 'ov-gameover');
  }

  function levelCleared() {
    S.phase = 'levelclear';
    S.score += 500 * (S.level + 1);
    saveBest();  // mid-run: bank the best, but the run is not over
    refreshHUD();
    $('clear-info').textContent = S.level >= C.MAX_LEVEL
      ? 'Level ' + S.level + ' flushed — that is the last one!'
      : 'Level ' + S.level + ' flushed · Score ' + S.score;
    $('btn-next-level').textContent = S.level >= C.MAX_LEVEL ? 'PLAY AGAIN' : 'NEXT LEVEL';
    startFx('flush', 'ov-clear');
  }

  function beginClear(hits) {
    S.chain++;
    var clogs = 0, segments = 0;
    hits.forEach(function (i) {
      var cell = S.board[i];
      if (!cell) return;
      if (cell.type === 'clog') clogs++; else segments++;
    });

    var mult = Math.min(Math.pow(2, S.chain - 1), 16);
    var gained = Math.round((clogs * 100 + segments * 10) * mult);
    S.score += gained;

    toast((S.chain > 1 ? 'CHAIN x' + S.chain + '  ' : '') + '+' + gained,
      S.chain > 1 ? '#ffdf9a' : '#9ff6ea');
    S.clearSet = hits;
    S.clearTimer = 0;
    S.shake = Math.min(7, 2 + S.chain * 1.5);
    S.phase = 'clearing';
    Sound.clear(S.chain);
    refreshHUD();
  }

  function clogsLeft() { return C.countClogs(S.board) + S.pending.length; }

  // Sends the next queued clog washing down a column of its own choosing.
  function startDrip() {
    var col = C.dripColumn(S.board, Math.random);
    var target = col < 0 ? -1 : C.dripLanding(S.board, col);
    S.sinceDrip = 0;
    if (target < 0) return false;   // nowhere for it to go; try again later
    S.drip = { col: col, color: S.pending.shift(), row: -1, target: target };
    S.phase = 'dripping';
    return true;
  }

  function afterSettle() {
    var hits = C.findMatches(S.board);
    if (hits.size) { beginClear(hits); return; }
    if (S.pending.length && S.sinceDrip >= C.dripEvery(S.level) && startDrip()) return;
    if (clogsLeft() === 0) { levelCleared(); return; }
    spawn();
  }

  function lockNow() {
    C.lockPiece(S.board, S.piece);
    S.piece = null;
    S.lockPending = false;
    S.shake = 2.5;
    gesture = null;
    S.locks++;
    S.sinceDrip++;
    if (S.locks >= 3) S.hint = Math.min(S.hint, 0.6);
    Sound.lock();
    S.chain = 0;

    var hits = C.findMatches(S.board);
    if (hits.size) { beginClear(hits); return; }
    // Halves orphaned by the landing still need to settle before the next spawn.
    S.phase = 'settling';
    S.settleTimer = 0;
  }

  function stepFall() {
    var moved = C.tryMove(S.board, S.piece, 0, 1);
    if (moved) {
      S.piece = moved;
      S.lockPending = false;
      S.lockTimer = 0;
      return true;
    }
    S.lockPending = true;
    return false;
  }

  function update(dt) {
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt * 0.02);
    if (S.toast) S.toast.t += dt;
    if (S.fx) {
      S.fx.t += dt;
      if (!S.fx.shown && S.fx.t >= S.fx.dur) {
        S.fx.shown = true;
        show(S.fx.overlay);
      }
    }

    if (S.phase === 'play') {
      // Pressure only builds while actually playing, never while paused.
      S.levelElapsed += dt;
      var step = C.pressureStep(S.level, S.levelElapsed);
      if (step > S.pressure) {
        S.pressure = step;
        toast('PRESSURE UP', '#ff9d5c');
        Sound.pressure();
      }
      if (S.hint > 0) S.hint = Math.max(0, S.hint - dt / 9000);

      S.fallTimer += dt;
      if (S.fallTimer >= C.fallInterval(S.level, S.levelElapsed)) {
        S.fallTimer = 0;
        stepFall();
      }
      if (S.lockPending) {
        S.lockTimer += dt;
        if (S.lockTimer >= LOCK_DELAY) lockNow();
      }
    } else if (S.phase === 'clearing') {
      S.clearTimer += dt;
      if (S.clearTimer >= CLEAR_MS) {
        C.clearMatches(S.board, S.clearSet);
        S.clearSet = null;
        S.phase = 'settling';
        S.settleTimer = 0;
        refreshHUD();
      }
    } else if (S.phase === 'dripping') {
      S.drip.row += dt / DRIP_MS;
      if (S.drip.row >= S.drip.target) {
        C.placeClog(S.board, S.drip.col, S.drip.target, S.drip.color);
        S.drip = null;
        S.shake = 2;
        Sound.drip();
        refreshHUD();
        afterSettle();
      }
    } else if (S.phase === 'settling') {
      S.settleTimer += dt;
      if (S.settleTimer >= SETTLE_MS) {
        S.settleTimer = 0;
        if (!C.gravityStep(S.board)) afterSettle();
      }
    }
  }

  var last = 0;
  function frame(t) {
    var dt = last ? Math.min(t - last, 100) : 16;
    last = t;
    update(dt);
    render(t);
    requestAnimationFrame(frame);
  }

  /* --------------------------------------------------------------- input */

  function playing() { return S.phase === 'play' && !!S.piece; }

  function noteLockReset() {
    if (S.lockPending && S.lockResets < MAX_LOCK_RESETS) {
      S.lockResets++;
      S.lockTimer = 0;
    }
  }

  function move(dc) {
    if (!playing()) return;
    var next = C.tryMove(S.board, S.piece, dc, 0);
    if (!next) return;
    S.piece = next;
    noteLockReset();
    Sound.move();
  }

  function moveToward(col) {
    if (!playing() || S.piece.c === col) return;
    var guard = W;
    while (S.piece.c !== col && guard-- > 0) {
      var next = C.tryMove(S.board, S.piece, col > S.piece.c ? 1 : -1, 0);
      if (!next) break;
      S.piece = next;
      noteLockReset();
      Sound.move();
    }
  }

  // Follows the finger downward. Never lifts a piece back up.
  function dropToRow(row) {
    if (!playing() || S.piece.r >= row) return;
    var guard = H;
    while (S.piece.r < row && guard-- > 0) {
      var next = C.tryMove(S.board, S.piece, 0, 1);
      if (!next) break;
      S.piece = next;
      S.score += 1;
      S.lockPending = false;
      S.lockTimer = 0;
      S.fallTimer = 0;
    }
    refreshHUD();
  }

  // Pointer events arrive far faster than the game can use them; skip the work
  // entirely when the finger has not crossed into a new cell.
  function steer(col, row) {
    if (!playing()) return;
    if (col !== S.piece.c) moveToward(col);
    if (row > S.piece.r) dropToRow(row);
  }

  function rotate(dir) {
    if (!playing()) return;
    var next = C.tryRotate(S.board, S.piece, dir);
    if (!next) return;
    S.piece = next;
    noteLockReset();
    Sound.rotate();
  }

  function softStep() {
    if (!playing()) return;
    S.fallTimer = 0;
    if (stepFall()) { S.score += 1; refreshHUD(); }
    else S.lockTimer = LOCK_DELAY;
  }

  function hardDrop() {
    if (!playing()) return;
    var dist = C.dropDistance(S.board, S.piece);
    if (dist > 0) {
      S.piece = C.tryMove(S.board, S.piece, 0, dist);
      S.score += dist * 2;
    }
    S.hint = Math.min(S.hint, 0.35);
    lockNow();
    refreshHUD();
  }

  /* The pipe is the controller: drag to aim, tap to spin, flick down to slam. */
  var gesture = null;
  var perf = function () { return performance.now(); };

  boardCv.addEventListener('pointerdown', function (e) {
    if (!playing()) return;
    if (gesture) return; // a stray second finger must not re-anchor the drag
    e.preventDefault();
    Sound.unlock();
    try { boardCv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    gesture = {
      id: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      col0: S.piece.c, row0: S.piece.r,
      t0: perf(), lastY: e.clientY, lastT: perf(),
      vy: 0, moved: false, dropped: false, spun: false
    };
  });

  boardCv.addEventListener('pointermove', function (e) {
    if (!gesture || gesture.id !== e.pointerId || !playing()) return;
    e.preventDefault();

    var now = perf();
    var dx = e.clientX - gesture.x0;
    var dy = e.clientY - gesture.y0;
    var span = now - gesture.lastT;
    if (span > 0) gesture.vy = (e.clientY - gesture.lastY) / span;
    gesture.lastY = e.clientY;
    gesture.lastT = now;
    if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) gesture.moved = true;

    // A decisive downward flick slams immediately, rather than on release.
    if (gesture.vy > FLICK_VY && dy > view.cell * 1.2) {
      gesture.dropped = true;
      hardDrop();      // clears `gesture`; the local reference is dead after this
      return;
    }

    // Swipe up spins the other way from a tap.
    if (!gesture.spun && dy < -view.cell * 0.85 && Math.abs(dy) > Math.abs(dx)) {
      gesture.spun = true;
      rotate(1);
      // Re-anchor so the same drag can keep steering afterwards.
      gesture.x0 = e.clientX;
      gesture.y0 = e.clientY;
      gesture.col0 = S.piece.c;
      gesture.row0 = S.piece.r;
      return;
    }

    steer(
      Math.max(0, Math.min(W - 1, gesture.col0 + Math.round(dx / view.cell))),
      dy > view.cell * 0.5 ? gesture.row0 + Math.floor(dy / view.cell) : -1);
  }, { passive: false });

  function endGesture(e) {
    if (!gesture || (e && gesture.id !== e.pointerId)) return;
    var g = gesture;
    gesture = null;
    if (!g.moved && !g.dropped && !g.spun && perf() - g.t0 < TAP_MS) rotate(-1);
  }

  boardCv.addEventListener('pointerup', endGesture);
  boardCv.addEventListener('pointercancel', endGesture);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'p' || e.key === 'P') { togglePause(); e.preventDefault(); return; }
    if (e.key === 'Escape' && S.phase === 'play') { togglePause(); e.preventDefault(); return; }
    if (!playing()) return;
    switch (e.key) {
      case 'ArrowLeft': case 'a': move(-1); break;
      case 'ArrowRight': case 'd': move(1); break;
      case 'ArrowDown': case 's': softStep(); break;
      case 'ArrowUp': case 'z': case 'Z': rotate(-1); break;
      case 'x': case 'X': rotate(1); break;
      case ' ': hardDrop(); break;
      default: return;
    }
    e.preventDefault();
  });

  /* ------------------------------------------------------------- overlays */

  function inPlay() {
    return S.phase === 'play' || S.phase === 'clearing' || S.phase === 'settling';
  }

  // Losing focus must only ever pause. Toggling there could resume a game
  // behind an overlay the player is still reading.
  function pauseGame() {
    if (!inPlay()) return;
    S.resumePhase = S.phase;
    S.phase = 'paused';
    gesture = null;
    $('pause-score').textContent = 'Score ' + fmtNum(S.score) + ' · level ' + S.level;
    show('ov-pause');
  }

  function resumeGame() {
    if (S.phase !== 'paused') return;
    hide('ov-pause');
    S.phase = S.resumePhase;
  }

  function togglePause() {
    if (S.phase === 'paused') resumeGame(); else pauseGame();
  }

  /* --------------------------------------------------------- score screen */

  var VB_W = 304, VB_H = 132;            // chart viewBox, ~1:1 with CSS px
  var PAD = { l: 38, r: 12, t: 14, b: 20 };
  var chartPoints = [];                  // {x, y, run} in viewBox units

  function esc(str) {
    return String(str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function fmtNum(n) {
    try { return Number(n).toLocaleString(); } catch (e) { return String(n); }
  }

  function fmtDate(t) {
    if (!t) return '—';
    var d = new Date(t);
    var sameYear = d.getFullYear() === new Date().getFullYear();
    try {
      return d.toLocaleDateString(undefined, sameYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: '2-digit' });
    } catch (e) { return d.toDateString(); }
  }

  function fmtWhen(t) {
    if (!t) return '—';
    var d = new Date(t);
    try {
      return fmtDate(t) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return fmtDate(t); }
  }

  // Round an axis maximum up to something a person would choose.
  function niceMax(v) {
    if (!(v > 0)) return 10;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  function renderTopTable(top) {
    var body = $('top-body');
    if (!top.length) {
      body.innerHTML = '';
      show('top-empty');
      return;
    }
    hide('top-empty');
    body.innerHTML = top.map(function (r, i) {
      var mine = r.t && r.t === S.lastRunAt ? ' class="is-latest"' : '';
      return '<tr' + mine + '>'
        + '<td class="rank">' + (i + 1) + '</td>'
        + '<td class="score">' + esc(fmtNum(r.s)) + '</td>'
        + '<td>' + esc(r.l) + '</td>'
        + '<td class="when">' + esc(fmtDate(r.t)) + '</td>'
        + '</tr>';
    }).join('');
  }

  // A single series over time: line plus dots, area wash, two direct labels.
  // The marks carry the colour; every piece of text stays in a text token.
  function renderTimeline(runs) {
    var plot = $('chart-plot');
    var empty = $('chart-empty');
    chartPoints = [];

    if (!runs.length) {
      plot.innerHTML = '';
      show('chart-empty');
      return;
    }
    hide('chart-empty');

    var x0 = PAD.l, x1 = VB_W - PAD.r, y0 = PAD.t, y1 = VB_H - PAD.b;
    var plotW = x1 - x0, plotH = y1 - y0;
    var peak = runs.reduce(function (m, r) { return Math.max(m, r.s); }, 0);
    var top = niceMax(peak);
    var yOf = function (v) { return y1 - (v / top) * plotH; };
    var xOf = function (i) { return runs.length === 1 ? (x0 + x1) / 2 : x0 + (i / (runs.length - 1)) * plotW; };

    var bestAt = 0;
    runs.forEach(function (r, i) { if (r.s > runs[bestAt].s) bestAt = i; });

    var pts = runs.map(function (r, i) {
      var p = { x: xOf(i), y: yOf(r.s), run: r };
      chartPoints.push(p);
      return p;
    });
    var line = pts.map(function (p) { return p.x.toFixed(1) + ' ' + p.y.toFixed(1); }).join(' L ');

    var svg = ['<svg viewBox="0 0 ' + VB_W + ' ' + VB_H + '" role="presentation" aria-hidden="true">'];

    // gridlines and axis ticks — recessive, hairline, solid
    [0, top / 2, top].forEach(function (v) {
      var y = yOf(v);
      svg.push('<line x1="' + x0 + '" y1="' + y.toFixed(1) + '" x2="' + x1 + '" y2="' + y.toFixed(1)
        + '" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>');
      svg.push('<text x="' + (x0 - 6) + '" y="' + (y + 3).toFixed(1)
        + '" text-anchor="end" class="ax">' + esc(fmtNum(v)) + '</text>');
    });

    // area wash under the line, then the line itself
    svg.push('<path d="M ' + pts[0].x.toFixed(1) + ' ' + y1 + ' L ' + line + ' L '
      + pts[pts.length - 1].x.toFixed(1) + ' ' + y1 + ' Z" fill="var(--chart-series)" fill-opacity="0.1"/>');
    svg.push('<path d="M ' + line + '" fill="none" stroke="var(--chart-series)" stroke-width="2"'
      + ' stroke-linejoin="round" stroke-linecap="round"/>');

    // crosshair, parked until a pointer arrives
    svg.push('<line id="chart-cross" x1="0" y1="' + y0 + '" x2="0" y2="' + y1
      + '" stroke="rgba(255,255,255,0.25)" stroke-width="1" opacity="0"/>');

    // dots carry a 2px surface ring so they stay legible where they crowd
    pts.forEach(function (p) {
      svg.push('<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1)
        + '" r="4" fill="var(--chart-series)" stroke="var(--chart-surface)" stroke-width="2"/>');
    });

    // Label the extreme and the endpoint only — never every point.
    var last = pts.length - 1;
    var label = function (i, text, below) {
      var p = pts[i];
      var anchor = p.x > x1 - 26 ? 'end' : (p.x < x0 + 26 ? 'start' : 'middle');
      var y = below
        ? Math.min(y1 - 3, p.y + 14)
        : Math.max(y0 + 8, p.y - 9);
      svg.push('<text x="' + p.x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + anchor
        + '" class="pt">' + esc(text) + '</text>');
    };
    label(bestAt, fmtNum(runs[bestAt].s));   // the peak always has room above it
    if (last !== bestAt) {
      // If the line drops into the final point, a label above it lands on the
      // line; put it underneath instead.
      var descending = pts[last - 1] && pts[last - 1].y < pts[last].y;
      label(last, fmtNum(runs[last].s), descending);
    }

    // x axis: just the span, oldest to newest
    svg.push('<text x="' + x0 + '" y="' + (VB_H - 6) + '" text-anchor="start" class="ax">'
      + esc(fmtDate(runs[0].t)) + '</text>');
    if (runs.length > 1) {
      svg.push('<text x="' + x1 + '" y="' + (VB_H - 6) + '" text-anchor="end" class="ax">'
        + esc(fmtDate(runs[last].t)) + '</text>');
    }
    svg.push('</svg>');

    // The chart is aria-hidden; this table is the accessible view of it.
    var rows = runs.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '</td><td>' + esc(fmtWhen(r.t)) + '</td><td>'
        + esc(fmtNum(r.s)) + '</td><td>' + esc(r.l) + '</td></tr>';
    }).join('');

    plot.innerHTML = svg.join('')
      + '<div class="chart-tip" id="chart-tip"></div>'
      + '<table class="visually-hidden"><caption>Last ' + runs.length
      + ' runs</caption><thead><tr><th>Run</th><th>When</th><th>Score</th><th>Level</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table>';
  }

  function hideTip() {
    var tip = $('chart-tip'), cross = document.getElementById('chart-cross');
    if (tip) tip.classList.remove('on');
    if (cross) cross.setAttribute('opacity', '0');
  }

  // Crosshair behaviour: snap to the nearest run rather than needing a
  // direct hit, which matters when 25 dots share a phone-width axis.
  function onChartPoint(e) {
    if (!chartPoints.length) return;
    var plot = $('chart-plot');
    var rect = plot.getBoundingClientRect();
    if (!rect.width) return;
    var vx = ((e.clientX - rect.left) / rect.width) * VB_W;

    var near = chartPoints[0], bestGap = Infinity;
    for (var i = 0; i < chartPoints.length; i++) {
      var gap = Math.abs(chartPoints[i].x - vx);
      if (gap < bestGap) { bestGap = gap; near = chartPoints[i]; }
    }

    var tip = $('chart-tip');
    var cross = document.getElementById('chart-cross');
    if (cross) {
      cross.setAttribute('x1', near.x);
      cross.setAttribute('x2', near.x);
      cross.setAttribute('opacity', '1');
    }
    if (tip) {
      tip.innerHTML = esc(fmtNum(near.run.s)) + '<span class="tip-date">'
        + esc(fmtWhen(near.run.t)) + ' · level ' + esc(near.run.l) + '</span>';
      tip.style.left = ((near.x / VB_W) * 100).toFixed(2) + '%';
      tip.style.top = ((near.y / VB_H) * 100).toFixed(2) + '%';
      tip.classList.add('on');
    }
  }

  function renderScores() {
    renderTopTable(Sc.top(history));
    renderTimeline(Sc.timeline(history));
  }

  function openScores(from) {
    S.scoresReturn = from;
    renderScores();
    hide(from);
    show('ov-scores');
  }

  function closeScores() {
    hideTip();
    hide('ov-scores');
    show(S.scoresReturn || 'ov-menu');
  }

  function updateLevelPicker() {
    $('lv-num').textContent = 'Level ' + S.startLevel;
    $('lv-clogs').textContent = C.clogTotal(S.startLevel) + ' clogs';
    $('menu-best').textContent = 'Best: ' + S.best;
  }

  function toMenu() {
    endRun();
    S.phase = 'menu';
    S.piece = null;
    S.fx = null;
    document.body.classList.remove('fx-active');
    hideAllOverlays();
    updateLevelPicker();
    refreshHUD();
    show('ov-menu');
  }

  function syncSoundButton() {
    $('btn-sound').textContent = 'Sound: ' + (Sound.muted ? 'off' : 'on');
  }

  $('lv-down').addEventListener('click', function () {
    S.startLevel = Math.max(0, S.startLevel - 1);
    Store.set('startLevel', S.startLevel);
    updateLevelPicker();
  });
  $('lv-up').addEventListener('click', function () {
    S.startLevel = Math.min(C.MAX_LEVEL, S.startLevel + 1);
    Store.set('startLevel', S.startLevel);
    updateLevelPicker();
  });

  $('btn-start').addEventListener('click', function () {
    Sound.unlock();
    startLevel(S.startLevel, false);
  });
  $('btn-resume').addEventListener('click', resumeGame);
  // Banks the run, then hands back the title screen so the next game can start
  // at whatever level the player wants.
  $('btn-new-game').addEventListener('click', toMenu);
  $('btn-pause-scores').addEventListener('click', function () { openScores('ov-pause'); });
  $('btn-menu').addEventListener('click', toMenu);
  $('btn-next-level').addEventListener('click', function () {
    hide('ov-clear');
    startLevel(S.level >= C.MAX_LEVEL ? 0 : S.level + 1, true);
  });
  $('btn-retry').addEventListener('click', function () {
    hide('ov-gameover');
    startLevel(S.level, false);
  });

  $('btn-scores').addEventListener('click', function () { openScores('ov-menu'); });
  $('btn-go-scores').addEventListener('click', function () { openScores('ov-gameover'); });
  $('btn-scores-back').addEventListener('click', closeScores);

  (function () {
    var plot = $('chart-plot');
    plot.addEventListener('pointermove', onChartPoint);
    plot.addEventListener('pointerdown', onChartPoint);
    // A mouse leaving the chart dismisses the readout; a finger lifting off it
    // must not, or the value vanishes the instant you go to read it.
    plot.addEventListener('pointerleave', function (e) {
      if (!e.pointerType || e.pointerType === 'mouse') hideTip();
    });
    plot.addEventListener('pointercancel', hideTip);
  })();

  $('btn-pause').addEventListener('click', togglePause);
  $('btn-sound').addEventListener('click', function () {
    Sound.muted = !Sound.muted;
    Store.set('muted', Sound.muted);
    syncSoundButton();
    if (!Sound.muted) { Sound.unlock(); Sound.rotate(); }
  });

  // Anything that takes attention away from the game pauses it: switching tabs,
  // switching apps, or another window taking focus while this one stays visible.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) pauseGame();
  });
  self.addEventListener('blur', pauseGame);
  self.addEventListener('pagehide', pauseGame);

  /* ----------------------------------------------------------------- boot */

  if (self.ResizeObserver) new ResizeObserver(layout).observe(document.body);
  self.addEventListener('resize', layout);
  self.addEventListener('orientationchange', function () { setTimeout(layout, 120); });

  syncSoundButton();
  S.board = C.seedLevel(S.startLevel).board;
  updateLevelPicker();
  refreshHUD();
  layout();
  requestAnimationFrame(frame);

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    self.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .catch(function () { /* offline support is optional */ });
    });
  }
})();
