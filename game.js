/* Clogged — rendering, input and the game loop. Core rules live in core.js. */
(function () {
  'use strict';

  var C = self.Core;
  var W = C.W, H = C.H;

  var LOCK_DELAY = 320;   // grace period to slide a landed coupler
  var MAX_LOCK_RESETS = 8;
  var CLEAR_MS = 260;     // dissolve animation
  var SETTLE_MS = 52;     // per row of post-clear gravity
  var SOFT_FACTOR = 9;

  var PALETTE = [
    { light: '#8ff3e6', main: '#2dd4bf', dark: '#0c6a60', rgb: '45,212,191' },
    { light: '#fcd77f', main: '#f59e0b', dark: '#8a5206', rgb: '245,158,11' },
    { light: '#f7c0ff', main: '#e879f9', dark: '#8a1fa1', rgb: '232,121,249' }
  ];

  var $ = function (id) { return document.getElementById(id); };

  var boardCv = $('board'), bctx = boardCv.getContext('2d');
  var nextCv = $('next'), nctx = nextCv.getContext('2d');
  var playfield = $('playfield');

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
    move: function () { this.tone(180, 0.045, 'square', 0.05); },
    rotate: function () { this.tone(430, 0.06, 'triangle', 0.06); },
    lock: function () { this.tone(120, 0.1, 'sine', 0.11); },
    clear: function (chain) {
      var base = 480 * Math.pow(1.16, Math.min(chain - 1, 5));
      this.tone(base, 0.1, 'square', 0.08);
      this.tone(base * 1.5, 0.13, 'square', 0.06, 0.06);
      this.tone(base * 2, 0.16, 'triangle', 0.05, 0.12);
    },
    levelClear: function () {
      [523, 659, 784, 1047].forEach(function (f, i) {
        Sound.tone(f, 0.2, 'triangle', 0.08, i * 0.09);
      });
    },
    gameOver: function () {
      [330, 262, 208, 156].forEach(function (f, i) {
        Sound.tone(f, 0.28, 'sawtooth', 0.07, i * 0.13);
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
    softDrop: false,
    clearSet: null,
    clearTimer: 0,
    settleTimer: 0,
    shake: 0,
    toast: null,
    resumePhase: 'play'
  };

  var view = { cell: 20, wall: 8, topRim: 11, x0: 8, y0: 11, cssW: 0, cssH: 0 };

  /* -------------------------------------------------------------- layout */

  function layout() {
    var rect = playfield.getBoundingClientRect();
    var availW = Math.max(80, rect.width);
    var availH = Math.max(120, rect.height);
    // Reserve room for the pipe walls when solving for cell size.
    var cell = Math.floor(Math.min(availW / (W + 0.8), availH / (H + 0.95)));
    cell = Math.max(10, cell);

    var wall = Math.max(4, Math.round(cell * 0.4));
    var topRim = Math.max(6, Math.round(cell * 0.55));

    view.cell = cell;
    view.wall = wall;
    view.topRim = topRim;
    view.x0 = wall;
    view.y0 = topRim;
    view.cssW = W * cell + wall * 2;
    view.cssH = H * cell + topRim + wall;

    var dpr = Math.min(self.devicePixelRatio || 1, 2.5);
    boardCv.style.width = view.cssW + 'px';
    boardCv.style.height = view.cssH + 'px';
    boardCv.width = Math.round(view.cssW * dpr);
    boardCv.height = Math.round(view.cssH * dpr);
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var ndpr = dpr;
    nextCv.width = Math.round(56 * ndpr);
    nextCv.height = Math.round(28 * ndpr);
    nctx.setTransform(ndpr, 0, 0, ndpr, 0, 0);
    drawNext();
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

  // A shape cue per colour so the game is playable without colour vision.
  function glyph(ctx, cx, cy, s, color) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, s * 0.07);
    ctx.lineCap = 'round';
    var g = s * 0.17;
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

  // A coupler half: square-ish and beveled, with a metal collar on the side
  // that joins its partner. An orphaned half has no collar, so the player can
  // see at a glance which pieces are loose after a cascade.
  function drawSegment(ctx, x, y, s, color, link) {
    var P = PALETTE[color];
    var pad = s * 0.055;
    var soft = s * 0.3, tight = s * 0.1;
    var r = [soft, soft, soft, soft];
    if (link === 'right') { r[1] = tight; r[2] = tight; }
    if (link === 'left') { r[0] = tight; r[3] = tight; }
    if (link === 'up') { r[0] = tight; r[1] = tight; }
    if (link === 'down') { r[2] = tight; r[3] = tight; }

    var g = ctx.createLinearGradient(x, y, x + s, y + s);
    g.addColorStop(0, P.light);
    g.addColorStop(0.45, P.main);
    g.addColorStop(1, P.dark);

    roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.38)';
    ctx.lineWidth = Math.max(1, s * 0.04);
    ctx.stroke();

    // specular sweep across the top-left
    ctx.save();
    roundRect(ctx, x + pad, y + pad, s - pad * 2, s - pad * 2, r);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.ellipse(x + s * 0.34, y + s * 0.26, s * 0.26, s * 0.13, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (link) {
      var band = s * 0.14;
      var mg = ctx.createLinearGradient(x, y, x + s, y + s);
      mg.addColorStop(0, '#b9c4dd');
      mg.addColorStop(0.5, '#69769a');
      mg.addColorStop(1, '#3d4767');
      ctx.fillStyle = mg;
      if (link === 'right') ctx.fillRect(x + s - band, y + s * 0.16, band, s * 0.68);
      if (link === 'left') ctx.fillRect(x, y + s * 0.16, band, s * 0.68);
      if (link === 'up') ctx.fillRect(x + s * 0.16, y, s * 0.68, band);
      if (link === 'down') ctx.fillRect(x + s * 0.16, y + s - band, s * 0.68, band);
    }

    glyph(ctx, x + s / 2, y + s / 2, s, color);
  }

  // Grime: a lumpy blob. Deliberately irregular so it reads as build-up
  // rather than as a game token.
  function drawClog(ctx, x, y, s, color, t, seed) {
    var P = PALETTE[color];
    var cx = x + s / 2, cy = y + s / 2;
    var base = s * 0.39;
    var pts = 9;

    ctx.beginPath();
    for (var i = 0; i <= pts; i++) {
      var a = (i / pts) * Math.PI * 2;
      var wob = Math.sin(t * 0.0022 + seed * 1.7 + i * 2.1) * s * 0.035;
      var rad = base + wob + (i % 2 ? s * 0.022 : -s * 0.022);
      var px = cx + Math.cos(a) * rad;
      var py = cy + Math.sin(a) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();

    var g = ctx.createRadialGradient(cx - s * 0.12, cy - s * 0.14, s * 0.05, cx, cy, base * 1.15);
    g.addColorStop(0, P.light);
    g.addColorStop(0.55, P.main);
    g.addColorStop(1, P.dark);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = Math.max(1, s * 0.05);
    ctx.stroke();

    // trapped bubbles
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    for (var b = 0; b < 3; b++) {
      var ba = seed * 2.3 + b * 2.4 + t * 0.0009;
      var br = s * (0.05 + 0.02 * b);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ba) * s * 0.17, cy + Math.sin(ba) * s * 0.15, br, 0, Math.PI * 2);
      ctx.fill();
    }

    glyph(ctx, cx, cy, s, color);
  }

  function cellXY(c, r) {
    return { x: view.x0 + c * view.cell, y: view.y0 + r * view.cell };
  }

  function drawPipe(t) {
    var v = view;
    var ctx = bctx;

    // outer casing
    var casing = ctx.createLinearGradient(0, 0, v.cssW, 0);
    casing.addColorStop(0, '#1b2440');
    casing.addColorStop(0.18, '#3c4a72');
    casing.addColorStop(0.5, '#28324f');
    casing.addColorStop(0.86, '#3c4a72');
    casing.addColorStop(1, '#161d33');
    roundRect(ctx, 0, 0, v.cssW, v.cssH, [v.cell * 0.5, v.cell * 0.5, v.cell * 0.35, v.cell * 0.35]);
    ctx.fillStyle = casing;
    ctx.fill();

    // inner well
    ctx.save();
    ctx.beginPath();
    ctx.rect(v.x0, v.y0, W * v.cell, H * v.cell);
    ctx.fillStyle = '#070a14';
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    for (var c = 1; c < W; c++) {
      ctx.beginPath();
      ctx.moveTo(v.x0 + c * v.cell + 0.5, v.y0);
      ctx.lineTo(v.x0 + c * v.cell + 0.5, v.y0 + H * v.cell);
      ctx.stroke();
    }
    for (var r = 1; r < H; r++) {
      ctx.beginPath();
      ctx.moveTo(v.x0, v.y0 + r * v.cell + 0.5);
      ctx.lineTo(v.x0 + W * v.cell, v.y0 + r * v.cell + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    // rivets down both walls
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    for (var y = v.y0 + v.cell * 0.8; y < v.y0 + H * v.cell; y += v.cell * 2.6) {
      ctx.beginPath(); ctx.arc(v.wall / 2, y, Math.max(1, v.wall * 0.17), 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(v.cssW - v.wall / 2, y, Math.max(1, v.wall * 0.17), 0, Math.PI * 2); ctx.fill();
    }

    // top rim highlight
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.fillRect(v.x0, v.topRim - Math.max(2, v.cell * 0.1), W * v.cell, Math.max(1, v.cell * 0.05));

    // danger: the neck is filling up
    var choked = false;
    for (var i = 0; i < W * 2; i++) if (S.board[i]) { choked = true; break; }
    if (choked && S.phase !== 'gameover') {
      var pulse = 0.25 + Math.sin(t * 0.006) * 0.16;
      ctx.strokeStyle = 'rgba(251,113,133,' + pulse.toFixed(3) + ')';
      ctx.lineWidth = Math.max(2, v.cell * 0.12);
      ctx.strokeRect(v.x0, v.y0, W * v.cell, v.cell * 2);
    }
  }

  function drawBoard(t) {
    var ctx = bctx;
    var s = view.cell;
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
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1, s * 0.08);
        ctx.beginPath();
        ctx.arc(pos.x + s / 2, pos.y + s / 2, s * (0.25 + p * 0.5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function drawPiece(t) {
    if (!S.piece || (S.phase !== 'play' && S.phase !== 'paused')) return;
    var ctx = bctx;
    var s = view.cell;
    var cells = C.pieceCells(S.piece);

    // Column guide — the single biggest aiming aid on a small screen.
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    cells.forEach(function (cl) {
      ctx.fillRect(view.x0 + cl.c * s, view.y0, s, H * s);
    });
    ctx.restore();

    // Landing preview.
    var dist = C.dropDistance(S.board, S.piece);
    if (dist > 0) {
      ctx.save();
      ctx.globalAlpha = 0.34;
      cells.forEach(function (cl) {
        var pos = cellXY(cl.c, cl.r + dist);
        var P = PALETTE[cl.color];
        roundRect(ctx, pos.x + s * 0.14, pos.y + s * 0.14, s * 0.72, s * 0.72,
          [s * 0.2, s * 0.2, s * 0.2, s * 0.2]);
        ctx.strokeStyle = P.main;
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
    var p = S.toast.t / 900;
    if (p >= 1) { S.toast = null; return; }
    ctx.save();
    ctx.globalAlpha = 1 - p;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 ' + Math.round(view.cell * 0.72) + 'px system-ui, sans-serif';
    ctx.fillStyle = S.toast.color;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 8;
    ctx.fillText(S.toast.text, view.cssW / 2, view.y0 + H * view.cell * 0.36 - p * view.cell * 1.6);
    ctx.restore();
  }

  function drawNext() {
    var ctx = nctx;
    ctx.clearRect(0, 0, 56, 28);
    if (!S.nextColors) return;
    var s = 22;
    var x = (56 - s * 2) / 2, y = (28 - s) / 2;
    drawSegment(ctx, x, y, s, S.nextColors[0], 'right');
    drawSegment(ctx, x + s, y, s, S.nextColors[1], 'left');
  }

  function render(t) {
    bctx.save();
    bctx.clearRect(0, 0, view.cssW, view.cssH);
    if (S.shake > 0.2) {
      bctx.translate((Math.random() - 0.5) * S.shake, (Math.random() - 0.5) * S.shake);
    }
    drawPipe(t);
    bctx.save();
    bctx.beginPath();
    bctx.rect(view.x0, view.y0, W * view.cell, H * view.cell);
    bctx.clip();
    drawBoard(t);
    drawPiece(t);
    drawToast();
    bctx.restore();
    bctx.restore();
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

  function startLevel(level, keepScore) {
    S.level = Math.max(0, Math.min(C.MAX_LEVEL, level));
    S.board = C.seedLevel(S.level);
    if (!keepScore) S.score = 0;
    S.chain = 0;
    S.clearSet = null;
    S.toast = null;
    S.softDrop = false;
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
    Sound.gameOver();
    $('go-score').textContent = 'Score: ' + S.score;
    $('go-best').textContent = 'Best: ' + S.best;
    refreshHUD();
    show('ov-gameover');
  }

  function levelCleared() {
    S.phase = 'levelclear';
    S.score += 500 * (S.level + 1);
    saveBest();
    Sound.levelClear();
    refreshHUD();
    $('clear-info').textContent = S.level >= C.MAX_LEVEL
      ? 'Level ' + S.level + ' flushed — that is the last one!'
      : 'Level ' + S.level + ' flushed · Score ' + S.score;
    $('btn-next-level').textContent = S.level >= C.MAX_LEVEL ? 'PLAY AGAIN' : 'NEXT LEVEL';
    show('ov-clear');
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

    S.toast = {
      text: (S.chain > 1 ? 'CHAIN x' + S.chain + '  ' : '') + '+' + gained,
      color: S.chain > 1 ? '#fcd77f' : '#8ff3e6',
      t: 0
    };
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
    S.softDrop = false;
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
      if (S.softDrop) S.score += 1;
      return true;
    }
    S.lockPending = true;
    return false;
  }

  function update(dt) {
    if (S.shake > 0) S.shake = Math.max(0, S.shake - dt * 0.02);
    if (S.toast) S.toast.t += dt;

    if (S.phase === 'play') {
      var interval = C.fallInterval(S.level) / (S.softDrop ? SOFT_FACTOR : 1);
      S.fallTimer += dt;
      if (S.fallTimer >= interval) {
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

  function playing() { return S.phase === 'play' && S.piece; }

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
      var dir = col > S.piece.c ? 1 : -1;
      var next = C.tryMove(S.board, S.piece, dir, 0);
      if (!next) break;
      S.piece = next;
      noteLockReset();
      Sound.move();
    }
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
    if (stepFall()) S.score += 1;
    else { S.lockTimer = LOCK_DELAY; }
    refreshHUD();
  }

  function hardDrop() {
    if (!playing()) return;
    var dist = C.dropDistance(S.board, S.piece);
    if (dist > 0) {
      S.piece = C.tryMove(S.board, S.piece, 0, dist);
      S.score += dist * 2;
    }
    S.softDrop = false;
    lockNow();
    refreshHUD();
  }

  // Press-and-hold repeat for the thumb buttons.
  function bindRepeat(el, fn) {
    var timer = null, delay = null;
    function stop() {
      clearTimeout(delay); clearInterval(timer);
      timer = null; delay = null;
    }
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      Sound.unlock();
      if (delay || timer) return;
      fn();
      delay = setTimeout(function () { timer = setInterval(fn, 55); }, 170);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      el.addEventListener(ev, stop);
    });
  }

  function bindTap(el, fn) {
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      Sound.unlock();
      fn();
    });
  }

  bindRepeat($('ctl-left'), function () { move(-1); });
  bindRepeat($('ctl-right'), function () { move(1); });
  bindRepeat($('ctl-down'), softStep);
  bindTap($('ctl-cw'), function () { rotate(1); });
  bindTap($('ctl-ccw'), function () { rotate(-1); });

  // Direct manipulation on the pipe: drag to steer, tap to rotate, flick to drop.
  var gesture = null;

  boardCv.addEventListener('pointerdown', function (e) {
    if (!playing()) return;
    e.preventDefault();
    try { boardCv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    gesture = {
      id: e.pointerId,
      x0: e.clientX, y0: e.clientY,
      col0: S.piece.c,
      t0: performance.now(),
      moved: false,
      dropped: false
    };
  });

  boardCv.addEventListener('pointermove', function (e) {
    if (!gesture || gesture.id !== e.pointerId || !playing()) return;
    e.preventDefault();
    if (gesture.dropped) return;

    var dx = e.clientX - gesture.x0;
    var dy = e.clientY - gesture.y0;
    var cell = view.cell;

    if (Math.abs(dx) > cell * 0.4 || Math.abs(dy) > cell * 0.55) gesture.moved = true;

    // A decisive downward flick drops immediately rather than on release.
    if (dy > cell * 1.7 && dy > Math.abs(dx) * 1.7 && performance.now() - gesture.t0 < 400) {
      gesture.dropped = true;
      S.softDrop = false;
      hardDrop();
      return;
    }

    moveToward(Math.max(0, Math.min(W - 1, gesture.col0 + Math.round(dx / cell))));
    S.softDrop = dy > cell * 0.75 && dy > Math.abs(dx);
  }, { passive: false });

  function endGesture(e) {
    if (!gesture || (e && gesture.id !== e.pointerId)) return;
    var g = gesture;
    gesture = null;
    S.softDrop = false;
    if (!g.moved && !g.dropped && performance.now() - g.t0 < 320) rotate(1);
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
      case 'ArrowUp': case 'x': case 'X': rotate(1); break;
      case 'z': case 'Z': rotate(-1); break;
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
      show('ov-pause');
    } else if (S.phase === 'paused') {
      hide('ov-pause');
      S.phase = S.resumePhase;
    }
  }

  function updateLevelPicker() {
    $('lv-num').textContent = 'Level ' + S.startLevel;
    $('lv-clogs').textContent = C.clogCount(S.startLevel) + ' grime';
    $('menu-best').textContent = 'Best: ' + S.best;
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
  $('btn-quit').addEventListener('click', function () {
    saveBest();
    S.phase = 'menu';
    S.piece = null;
    hideAllOverlays();
    updateLevelPicker();
    show('ov-menu');
  });
  $('btn-next-level').addEventListener('click', function () {
    hide('ov-clear');
    startLevel(S.level >= C.MAX_LEVEL ? 0 : S.level + 1, true);
  });
  $('btn-retry').addEventListener('click', function () {
    hide('ov-gameover');
    startLevel(S.level, false);
  });
  $('btn-menu').addEventListener('click', function () {
    hideAllOverlays();
    S.phase = 'menu';
    S.piece = null;
    updateLevelPicker();
    show('ov-menu');
  });

  $('btn-pause').addEventListener('click', togglePause);
  $('btn-mute').addEventListener('click', function () {
    Sound.muted = !Sound.muted;
    Store.set('muted', Sound.muted);
    $('btn-mute').textContent = Sound.muted ? '🔇' : '🔊';
    $('btn-mute').setAttribute('aria-pressed', String(Sound.muted));
    if (!Sound.muted) { Sound.unlock(); Sound.rotate(); }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && (S.phase === 'play' || S.phase === 'clearing' || S.phase === 'settling')) {
      togglePause();
    }
  });

  /* ----------------------------------------------------------------- boot */

  if (self.ResizeObserver) {
    new ResizeObserver(layout).observe(playfield);
  }
  self.addEventListener('resize', layout);
  self.addEventListener('orientationchange', function () { setTimeout(layout, 120); });

  $('btn-mute').textContent = Sound.muted ? '🔇' : '🔊';
  $('btn-mute').setAttribute('aria-pressed', String(Sound.muted));
  S.board = C.seedLevel(S.startLevel);
  updateLevelPicker();
  refreshHUD();
  layout();
  requestAnimationFrame(frame);

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    self.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () { /* offline is optional */ });
    });
  }
})();
