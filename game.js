/* Clogged — rendering, input and the game loop. Core rules live in core.js. */
(function () {
  'use strict';

  var C = self.Core;
  var W = C.W, H = C.H;

  var LOCK_DELAY = 320;   // grace period to slide a landed coupling
  var MAX_LOCK_RESETS = 8;
  var CLEAR_MS = 260;     // dissolve animation
  var SETTLE_MS = 52;     // per row of post-clear gravity
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
    move: function () { this.tone(180, 0.04, 'square', 0.045); },
    rotate: function () { this.tone(430, 0.06, 'triangle', 0.06); },
    lock: function () { this.tone(120, 0.1, 'sine', 0.11); },
    clear: function (chain) {
      var base = 480 * Math.pow(1.16, Math.min(chain - 1, 5));
      this.tone(base, 0.1, 'square', 0.08);
      this.tone(base * 1.5, 0.13, 'square', 0.06, 0.06);
      this.tone(base * 2, 0.16, 'triangle', 0.05, 0.12);
    },
    pressure: function () { this.sweep(240, 520, 0.34, 'sawtooth', 0.05); },
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
    levelElapsed: 0,      // drives the pressure ramp
    pressure: 0,
    shake: 0,
    toast: null,
    fx: null,
    hint: 1,              // fades out once the player gets going
    locks: 0,
    resumePhase: 'play'
  };

  var view = { cell: 24, wall: 7, collar: 13, grate: 11, x0: 0, y0: 0, vw: 0, vh: 0, dpr: 1, bg: null };

  /* -------------------------------------------------------------- layout */

  function layout() {
    var vw = Math.round(document.documentElement.clientWidth);
    var vh = Math.round(document.documentElement.clientHeight);
    var hudH = hud.getBoundingClientRect().height;
    var safeBottom = safeProbe.getBoundingClientRect().height || 0;

    var padTop = hudH + 4;
    var padBottom = safeBottom + 10;
    var availH = Math.max(120, vh - padTop - padBottom);

    // Leave ~0.6 cell of side wall and ~1 cell for the collar and grate.
    var cell = Math.floor(Math.min(vw / (W + 0.62), availH / (H + 1.05)));
    cell = Math.max(10, Math.min(cell, 72));

    var wall = Math.max(3, Math.round(cell * 0.28));
    var collar = Math.max(7, Math.round(cell * 0.55));
    var grate = Math.max(6, Math.round(cell * 0.45));
    var boardW = W * cell, boardH = H * cell;
    var stack = boardH + collar + grate;

    view.cell = cell;
    view.wall = wall;
    view.collar = collar;
    view.grate = grate;
    view.x0 = Math.round((vw - boardW) / 2);
    view.y0 = padTop + collar + Math.max(0, Math.round((availH - stack) / 2));
    view.vw = vw;
    view.vh = vh;

    var dpr = Math.min(self.devicePixelRatio || 1, 2.5);
    view.dpr = dpr;
    boardCv.width = Math.round(vw * dpr);
    boardCv.height = Math.round(vh * dpr);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    nextCv.style.width = '52px';
    nextCv.style.height = '26px';
    nextCv.width = Math.round(52 * dpr);
    nextCv.height = Math.round(26 * dpr);
    nctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    view.bg = buildBackground(vw, vh, cell, dpr);
    drawNext();
  }

  // The tiled wall behind the pipe. Drawn once per layout, then blitted.
  function buildBackground(vw, vh, cell, dpr) {
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
    return c;
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

  // A hairball: matted core wrapped in tangled strands.
  function drawClog(ctx, x, y, s, color, t, seed) {
    var P = PALETTE[color];
    var cx = x + s / 2, cy = y + s / 2;
    var R = s * 0.29;
    var wob = Math.sin(t * 0.0016 + seed) * 0.08;

    ctx.save();
    ctx.lineCap = 'round';
    // Strands curl around the ball rather than spiking straight out, which is
    // the difference between reading as hair and reading as a sea urchin.
    for (var i = 0; i < 22; i++) {
      var a = (i / 22) * Math.PI * 2 + seed * 0.9 + wob;
      var r0 = R * (0.5 + 0.35 * (((i * 5 + seed) % 3) / 3));
      var reach = R * (0.98 + 0.4 * (((i * 7 + seed * 3) % 5) / 5));
      var curl = 1.15 + ((i % 4) - 1.5) * 0.5;
      ctx.strokeStyle = (i % 3) ? P.main : P.light;
      ctx.globalAlpha = 0.32 + 0.4 * ((i % 4) / 4);
      ctx.lineWidth = Math.max(1, s * 0.036);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.quadraticCurveTo(
        cx + Math.cos(a + curl * 0.45) * reach * 1.16,
        cy + Math.sin(a + curl * 0.45) * reach * 1.16,
        cx + Math.cos(a + curl) * reach * 0.8,
        cy + Math.sin(a + curl) * reach * 0.8);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // matted core
    ctx.beginPath();
    for (var k = 0; k <= 9; k++) {
      var ang = (k / 9) * Math.PI * 2;
      var rad = R * (0.92 + Math.sin(ang * 3 + seed + t * 0.002) * 0.12);
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
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = Math.max(1, s * 0.035);
    ctx.stroke();

    // loose hairs lying across the matted core
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(1, s * 0.028);
    for (var j = 0; j < 7; j++) {
      var a2 = j * 1.9 + seed + wob;
      ctx.strokeStyle = (j % 2) ? P.main : P.light;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a2) * R * 0.86, cy + Math.sin(a2) * R * 0.86);
      ctx.quadraticCurveTo(cx, cy,
        cx + Math.cos(a2 + 2.3) * R * 0.86, cy + Math.sin(a2 + 2.3) * R * 0.86);
      ctx.stroke();
    }
    ctx.restore();

    glyph(ctx, cx, cy, s, color, 0.85);
  }

  function cellXY(c, r) {
    return { x: view.x0 + c * view.cell, y: view.y0 + r * view.cell };
  }

  function drawPipe(t) {
    var v = view, ctx = bctx;
    var boardW = W * v.cell, boardH = H * v.cell;
    var outerX = v.x0 - v.wall, outerW = boardW + v.wall * 2;

    // threaded collar above the mouth of the pipe
    ctx.fillStyle = metal(ctx, outerX, v.y0 - v.collar, outerW, v.collar);
    roundRect(ctx, outerX - v.wall * 0.35, v.y0 - v.collar, outerW + v.wall * 0.7, v.collar,
      [v.cell * 0.2, v.cell * 0.2, 0, 0]);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    for (var th = 1; th < 3; th++) {
      var ty = v.y0 - v.collar + (v.collar / 3) * th;
      ctx.beginPath(); ctx.moveTo(outerX, ty); ctx.lineTo(outerX + outerW, ty); ctx.stroke();
    }

    // side walls
    ctx.fillStyle = metal(ctx, outerX, v.y0, v.wall, boardH);
    ctx.fillRect(outerX, v.y0, v.wall, boardH);
    ctx.fillStyle = metal(ctx, v.x0 + boardW, v.y0, v.wall, boardH);
    ctx.fillRect(v.x0 + boardW, v.y0, v.wall, boardH);

    // rivets
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    for (var y = v.y0 + v.cell * 0.9; y < v.y0 + boardH; y += v.cell * 2.7) {
      ctx.beginPath(); ctx.arc(outerX + v.wall / 2, y, Math.max(1, v.wall * 0.2), 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(v.x0 + boardW + v.wall / 2, y, Math.max(1, v.wall * 0.2), 0, Math.PI * 2); ctx.fill();
    }

    // the well itself
    ctx.fillStyle = '#070a13';
    ctx.fillRect(v.x0, v.y0, boardW, boardH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x0, v.y0, boardW, boardH);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.032)';
    ctx.lineWidth = 1;
    for (var c = 1; c < W; c++) {
      ctx.beginPath();
      ctx.moveTo(v.x0 + c * v.cell + 0.5, v.y0);
      ctx.lineTo(v.x0 + c * v.cell + 0.5, v.y0 + boardH);
      ctx.stroke();
    }
    for (var r = 1; r < H; r++) {
      ctx.beginPath();
      ctx.moveTo(v.x0, v.y0 + r * v.cell + 0.5);
      ctx.lineTo(v.x0 + boardW, v.y0 + r * v.cell + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // drain grate at the bottom
    var gy = v.y0 + boardH;
    ctx.fillStyle = metal(ctx, outerX, gy, outerW, v.grate);
    roundRect(ctx, outerX - v.wall * 0.35, gy, outerW + v.wall * 0.7, v.grate,
      [0, 0, v.cell * 0.22, v.cell * 0.22]);
    ctx.fill();
    ctx.fillStyle = 'rgba(6,9,16,0.75)';
    var slots = 5, sw = boardW / (slots * 2 + 1);
    for (var sI = 0; sI < slots; sI++) {
      ctx.fillRect(v.x0 + sw * (sI * 2 + 1), gy + v.grate * 0.28, sw, v.grate * 0.44);
    }

    // the neck is filling up
    var choked = false;
    for (var i = 0; i < W * 2; i++) if (S.board[i]) { choked = true; break; }
    if (choked && S.phase !== 'gameover') {
      var pulse = 0.3 + Math.sin(t * 0.006) * 0.2;
      ctx.strokeStyle = 'rgba(251,113,133,' + pulse.toFixed(3) + ')';
      ctx.lineWidth = Math.max(2, v.cell * 0.1);
      ctx.strokeRect(v.x0 + 1, v.y0 + 1, boardW - 2, v.cell * 2 - 2);
    }
  }

  function drawBoard(t) {
    var ctx = bctx, s = view.cell;
    var clearing = S.clearSet;
    var p = clearing ? Math.min(1, S.clearTimer / CLEAR_MS) : 0;

    for (var i = 0; i < S.board.length; i++) {
      var cell = S.board[i];
      if (!cell) continue;
      var pos = cellXY(C.colOf(i), C.rowOf(i));
      var dissolving = clearing && clearing.has(i);

      ctx.save();
      if (dissolving) {
        ctx.globalAlpha = 1 - p * 0.85;
        ctx.translate(pos.x + s / 2, pos.y + s / 2);
        var k = 1 + p * 0.25;
        ctx.scale(k, k);
        ctx.translate(-(pos.x + s / 2), -(pos.y + s / 2));
      }
      if (cell.type === 'clog') drawClog(ctx, pos.x, pos.y, s, cell.color, t, i);
      else drawSegment(ctx, pos.x, pos.y, s, cell.color, cell.link);
      ctx.restore();

      if (dissolving) {
        ctx.save();
        ctx.globalAlpha = (1 - p) * 0.85;
        ctx.strokeStyle = '#dff9ff';
        ctx.lineWidth = Math.max(1, s * 0.08);
        ctx.beginPath();
        ctx.arc(pos.x + s / 2, pos.y + s / 2, s * (0.25 + p * 0.5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
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
      drawSegment(ctx, pos.x, pos.y, s, cl.color, cl.link);
    });
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
    ctx.clearRect(0, 0, 52, 26);
    if (!S.nextColors) return;
    var s = 26;
    drawSegment(ctx, 0, 0, s, S.nextColors[0], 'right');
    drawSegment(ctx, s, 0, s, S.nextColors[1], 'left');
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
    drawBoard(t);
    drawPiece();
    drawHint();
    drawToast();
    bctx.restore();
    bctx.restore();

    drawFx(t);
  }

  /* ----------------------------------------------------------- game flow */

  function refreshHUD() {
    $('hud-score').textContent = S.score;
    $('hud-best').textContent = S.best;
    $('hud-level').textContent = S.level;
    $('hud-clogs').textContent = C.countClogs(S.board);
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

  function toast(text, color) {
    S.toast = { text: text, color: color, t: 0 };
  }

  function startLevel(level, keepScore) {
    // Banked here rather than at each call site, so no entry point can drop a
    // run's score on the floor (restarting mid-game used to).
    saveBest();
    S.level = Math.max(0, Math.min(C.MAX_LEVEL, level));
    S.board = C.seedLevel(S.level);
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
    saveBest();
    $('go-score').textContent = 'Score: ' + S.score;
    $('go-best').textContent = 'Best: ' + S.best;
    refreshHUD();
    startFx('sludge', 'ov-gameover');
  }

  function levelCleared() {
    S.phase = 'levelclear';
    S.score += 500 * (S.level + 1);
    saveBest();
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

  function afterSettle() {
    var hits = C.findMatches(S.board);
    if (hits.size) { beginClear(hits); return; }
    if (C.countClogs(S.board) === 0) { levelCleared(); return; }
    spawn();
  }

  function lockNow() {
    C.lockPiece(S.board, S.piece);
    S.piece = null;
    S.lockPending = false;
    S.shake = 2.5;
    gesture = null;
    S.locks++;
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
      var step = C.pressureStep(S.levelElapsed);
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
    if (!playing()) return;
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
    if (!playing()) return;
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

    moveToward(Math.max(0, Math.min(W - 1, gesture.col0 + Math.round(dx / view.cell))));
    if (dy > view.cell * 0.5) {
      dropToRow(gesture.row0 + Math.floor(dy / view.cell));
    }
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

  function togglePause() {
    if (S.phase === 'play' || S.phase === 'clearing' || S.phase === 'settling') {
      S.resumePhase = S.phase;
      S.phase = 'paused';
      gesture = null;
      show('ov-pause');
    } else if (S.phase === 'paused') {
      hide('ov-pause');
      S.phase = S.resumePhase;
    }
  }

  function updateLevelPicker() {
    $('lv-num').textContent = 'Level ' + S.startLevel;
    $('lv-clogs').textContent = C.clogCount(S.startLevel) + ' clogs';
    $('menu-best').textContent = 'Best: ' + S.best;
  }

  function toMenu() {
    saveBest();
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
  $('btn-resume').addEventListener('click', togglePause);
  $('btn-restart').addEventListener('click', function () {
    hide('ov-pause');
    startLevel(S.level, false);
  });
  $('btn-quit').addEventListener('click', toMenu);
  $('btn-menu').addEventListener('click', toMenu);
  $('btn-next-level').addEventListener('click', function () {
    hide('ov-clear');
    startLevel(S.level >= C.MAX_LEVEL ? 0 : S.level + 1, true);
  });
  $('btn-retry').addEventListener('click', function () {
    hide('ov-gameover');
    startLevel(S.level, false);
  });

  $('btn-pause').addEventListener('click', togglePause);
  $('btn-sound').addEventListener('click', function () {
    Sound.muted = !Sound.muted;
    Store.set('muted', Sound.muted);
    syncSoundButton();
    if (!Sound.muted) { Sound.unlock(); Sound.rotate(); }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && (S.phase === 'play' || S.phase === 'clearing' || S.phase === 'settling')) {
      togglePause();
    }
  });

  /* ----------------------------------------------------------------- boot */

  if (self.ResizeObserver) new ResizeObserver(layout).observe(document.body);
  self.addEventListener('resize', layout);
  self.addEventListener('orientationchange', function () { setTimeout(layout, 120); });

  syncSoundButton();
  S.board = C.seedLevel(S.startLevel);
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
