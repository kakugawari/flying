/*!
 * app.js — ふわりバードの操作と描画。ゲームの中身は core.js。
 */
(function () {
  'use strict';

  const C = window.Core;
  const W = C.W, H = C.H, GROUND = C.GROUND, BIRD_X = C.BIRD_X, R = C.BIRD_R, PIPE_W = C.PIPE_W;
  const SAFE_TOP = 59;                 // iPhone 16 Plus の上の安全域
  const STEP_MS = 1000 / 60;
  const MAX_CATCHUP_MS = 50;           // 止まっていたあとに一気に進めない

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const els = {
    vStart: document.getElementById('vStart'),
    vOver: document.getElementById('vOver'),
    finalScore: document.getElementById('finalScore'),
    overMode: document.getElementById('overMode'),
    overBest: document.getElementById('overBest'),
    bestClassic: document.getElementById('bestClassic'),
    bestAdventure: document.getElementById('bestAdventure'),
    mute: document.getElementById('btnMute')
  };

  let game = C.create('classic');
  let mode = 'classic';
  let paused = false;
  let lastT = null;
  let acc = 0;
  let overTimer = null;
  let banner = { text: '', until: 0 };
  let shootingStar = null;

  // ---- 保存 (ベストと、前回のモード) ----
  function bestKey(m) { return m === 'adventure' ? 'suisuiBestAdventure' : 'suisuiBestClassic'; }
  function loadBest(m) {
    try { return parseInt(localStorage.getItem(bestKey(m)), 10) || 0; } catch (e) { return 0; }
  }
  function saveBest(m, v) {
    try { localStorage.setItem(bestKey(m), String(v)); } catch (e) { /* 保存できなくても遊べる */ }
  }
  function showBests() {
    els.bestClassic.textContent = 'ベスト ' + loadBest('classic');
    els.bestAdventure.textContent = 'ベスト ' + loadBest('adventure');
  }

  // ---- 音 (WebAudio でその場で合成。短い音は終わりを 0 に落としてバチッを避ける) ----
  let actx = null, master = null, muted = false;
  try { muted = localStorage.getItem('suisuiMuted') === '1'; } catch (e) { /* ignore */ }

  function unlockAudio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(actx.destination);
    }
    if (actx.state === 'suspended') actx.resume();
  }
  function tone(freq, dur, type, vol, delay, slideTo) {
    if (!actx || muted) return;
    const t0 = actx.currentTime + (delay || 0);
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  function sfx(name) {
    if (name === 'flap') tone(380, 0.09, 'triangle', 0.25, 0, 620);
    else if (name === 'pass') tone(880, 0.1, 'square', 0.12);
    else if (name === 'stage') { tone(660, 0.12, 'square', 0.14); tone(880, 0.12, 'square', 0.14, 0.11); tone(1320, 0.2, 'square', 0.14, 0.22); }
    else if (name === 'item') { tone(988, 0.08, 'sine', 0.25); tone(1480, 0.14, 'sine', 0.25, 0.08); }
    else if (name === 'hit') tone(220, 0.2, 'sawtooth', 0.2, 0, 90);
    else if (name === 'over') tone(300, 0.45, 'sawtooth', 0.22, 0, 70);
  }
  function showMute() { els.mute.textContent = muted ? '🔇' : '🔊'; }

  // ---- 流れの切り替え ----
  function startGame(m) {
    if (m) {
      mode = m;
      try { localStorage.setItem('suisuiMode', mode); } catch (e) { /* ignore */ }
    }
    clearTimeout(overTimer);
    game = C.create(mode);
    paused = false;
    banner = { text: '', until: 0 };
    shootingStar = null;
    els.vStart.classList.remove('on');
    els.vOver.classList.remove('on');
    unlockAudio();
  }

  function showMenu() {
    clearTimeout(overTimer);
    game = C.create(mode);   // 鳥がふわふわ待つだけの画面
    paused = false;
    els.vOver.classList.remove('on');
    els.vStart.classList.add('on');
    showBests();
  }

  function onOver() {
    sfx('over');
    const best = loadBest(game.mode);
    const isNew = game.score > best;
    if (isNew) saveBest(game.mode, game.score);
    const finalScore = game.score;
    const m = game.mode;
    clearTimeout(overTimer);
    overTimer = setTimeout(function () {
      els.finalScore.textContent = finalScore;
      els.overMode.textContent = m === 'adventure' ? 'アドベンチャー' : 'クラシック';
      els.overBest.textContent = isNew ? '自己ベスト更新！' : 'ベスト: ' + best;
      els.vOver.classList.add('on');
    }, 300);
  }

  function handleEvents() {
    const ev = game.events.splice(0);
    for (const e of ev) {
      if (e === 'stage') {
        banner = { text: 'ステージ' + (game.stage + 1) + '  ' + C.STAGES[C.stageIndex(game.score)].name, until: game.play + 100 };
      }
      sfx(e);
      if (e === 'over') onOver();
    }
  }

  // ---- 入力 ----
  function tap() {
    if (els.vStart.classList.contains('on') || els.vOver.classList.contains('on')) return;
    if (paused) { paused = false; return; }
    if (game.phase === 'over') return;
    unlockAudio();
    C.flap(game);
  }

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    tap();
  });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
      e.preventDefault();
      if (els.vStart.classList.contains('on')) startGame();   // キーボードは前回のモードで即スタート
      else tap();
    }
  });
  document.getElementById('btnClassic').addEventListener('click', function () { startGame('classic'); });
  document.getElementById('btnAdventure').addEventListener('click', function () { startGame('adventure'); });
  document.getElementById('btnRetry').addEventListener('click', function () { startGame(); });
  document.getElementById('btnMenu').addEventListener('click', showMenu);
  els.mute.addEventListener('click', function () {
    muted = !muted;
    try { localStorage.setItem('suisuiMuted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
    unlockAudio();
    if (master) master.gain.value = muted ? 0 : 0.5;
    showMute();
  });

  // アプリを離れたら一時停止。戻ってタップで再開
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && game.phase === 'play') paused = true;
  });

  // ---- 色 ----
  function rgb(c, a) {
    return a === undefined ? 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'
      : 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }

  // ---- 描画 ----
  function drawCloud(x, y, size, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff';
    ctx.beginPath();   // 1 つの経路で塗るので、丸どうしのふちは出ない
    ctx.arc(x, y, 18 * size, 0, Math.PI * 2);
    ctx.arc(x + 20 * size, y - 8 * size, 22 * size, 0, Math.PI * 2);
    ctx.arc(x + 42 * size, y, 18 * size, 0, Math.PI * 2);
    ctx.arc(x + 20 * size, y + 6 * size, 20 * size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawStars(strength) {
    ctx.save();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 50; i++) {
      const x = (i * 137 + 23) % W;
      const y = (i * 89 + 11) % (H - GROUND - 260) + 20;
      const tw = 0.5 + 0.5 * Math.sin(game.frames * 0.05 + i * 1.7);
      ctx.globalAlpha = strength * (0.35 + 0.65 * tw);
      ctx.beginPath();
      ctx.arc(x, y, i % 3 === 0 ? 1.8 : 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    if (shootingStar) {
      ctx.globalAlpha = strength * Math.min(1, shootingStar.life / 10);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(shootingStar.x, shootingStar.y);
      ctx.lineTo(shootingStar.x + 36, shootingStar.y - 18);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMoon(strength) {
    ctx.save();
    ctx.globalAlpha = strength;
    ctx.fillStyle = '#fff4c2';
    ctx.beginPath(); ctx.arc(350, SAFE_TOP + 110, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(20,28,70,0.9)';
    ctx.beginPath(); ctx.arc(362, SAFE_TOP + 103, 22, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawAurora(strength) {
    ctx.save();
    const colors = ['rgba(90,255,190,', 'rgba(120,200,255,', 'rgba(200,120,255,'];
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = colors[k] + (0.13 * strength) + ')';
      ctx.beginPath();
      const base = 220 + k * 50;
      const wave = function (x) { return base + Math.sin(x * 0.018 + game.frames * 0.02 + k * 2) * 26; };
      ctx.moveTo(0, wave(0) - 30);
      for (let x = 0; x <= W; x += 20) ctx.lineTo(x, wave(x) - 30);
      for (let x = W; x >= 0; x -= 20) ctx.lineTo(x, wave(x) + 30);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBackground(pal) {
    const g = ctx.createLinearGradient(0, 0, 0, H - GROUND);
    g.addColorStop(0, rgb(pal.sky[0]));
    g.addColorStop(1, rgb(pal.sky[1]));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H - GROUND);
    if (pal.stars > 0.01) drawStars(pal.stars);
    if (pal.aurora > 0.01) drawAurora(pal.aurora);
    if (pal.moon > 0.01) drawMoon(pal.moon);
    const span = W + 160;
    const drift = (game.frames * 0.3) % span;
    drawCloud(W + 80 - drift, 170, 1.0, pal.cloud);
    drawCloud(W + 80 - ((drift + 230) % span), 290, 0.7, pal.cloud);
    drawCloud(W + 80 - ((drift + 380) % span), 130, 0.55, pal.cloud);
    drawCloud(W + 80 - ((drift + 120) % span), 420, 0.8, pal.cloud);
  }

  function drawGround(pal) {
    const top = H - GROUND;
    ctx.fillStyle = rgb(pal.ground[0]);
    ctx.fillRect(0, top, W, GROUND);
    ctx.fillStyle = rgb(pal.ground[1]);
    const off = game.groundOffset % 24;
    for (let x = -24 - off; x < W + 24; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, top); ctx.lineTo(x + 12, top); ctx.lineTo(x, top + 12); ctx.lineTo(x - 12, top + 12);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillRect(0, top, W, 3);
  }

  function drawPipe(p, pal) {
    const main = rgb(pal.pipe[0]), dark = rgb(pal.pipe[1]), lip = rgb(pal.pipe[2]);
    const bottom = p.top + p.gap, bh = H - GROUND - bottom;
    ctx.fillStyle = main; ctx.fillRect(p.x, 0, PIPE_W, p.top);
    ctx.fillStyle = dark; ctx.fillRect(p.x + PIPE_W - 10, 0, 10, p.top);
    ctx.fillStyle = lip;  ctx.fillRect(p.x - 3, p.top - 24, PIPE_W + 6, 24);
    ctx.fillStyle = dark; ctx.fillRect(p.x + PIPE_W - 7, p.top - 24, 10, 24);
    ctx.fillStyle = main; ctx.fillRect(p.x, bottom, PIPE_W, bh);
    ctx.fillStyle = dark; ctx.fillRect(p.x + PIPE_W - 10, bottom, 10, bh);
    ctx.fillStyle = lip;  ctx.fillRect(p.x - 3, bottom, PIPE_W + 6, 24);
    ctx.fillStyle = dark; ctx.fillRect(p.x + PIPE_W - 7, bottom, 10, 24);
  }

  function drawItem(it) {
    const y = it.y + Math.sin(game.frames * 0.1 + it.x * 0.01) * 3;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(it.x, y, C.ITEM_R, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = it.type === 'star' ? '#f4b41a' : it.type === 'heart' ? '#ff4f6d' : '#3cb371';
    ctx.lineWidth = 2.5; ctx.stroke();
    ctx.font = '17px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.fillText(it.type === 'star' ? '⭐' : it.type === 'heart' ? '💗' : '🐢', it.x, y + 1);
    ctx.restore();
  }

  function drawBird() {
    const playing = game.phase === 'play';
    if (playing && game.play < game.hurtUntil && Math.floor(game.play / 4) % 2 === 0) return;   // 被弾中は点滅
    ctx.save();
    ctx.translate(BIRD_X, game.birdY);
    ctx.rotate(game.phase === 'ready' ? 0 : Math.max(-0.5, Math.min(1.2, game.vy * 0.1)));
    if (playing && game.play < game.starUntil) {
      const g = ctx.createRadialGradient(0, 0, R, 0, 0, R + 14);
      g.addColorStop(0, 'rgba(255,240,120,0.75)');
      g.addColorStop(1, 'rgba(255,240,120,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, R + 14, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#ffd93d';
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#c99700'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#f4b41a';
    ctx.beginPath(); ctx.ellipse(-4, 3 + Math.sin(game.frames * 0.4) * 4, 9, 5, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(6, -5, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath(); ctx.arc(8, -5, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f26b3a';
    ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(22, 4); ctx.lineTo(12, 8); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function outlinedText(text, x, y, font, fill) {
    ctx.save();
    ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill || '#fff';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawHeart(x, y, s, filled) {
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.3);
    ctx.bezierCurveTo(x, y, x - s / 2, y, x - s / 2, y + s * 0.3);
    ctx.bezierCurveTo(x - s / 2, y + s * 0.6, x, y + s * 0.8, x, y + s);
    ctx.bezierCurveTo(x, y + s * 0.8, x + s / 2, y + s * 0.6, x + s / 2, y + s * 0.3);
    ctx.bezierCurveTo(x + s / 2, y, x, y, x, y + s * 0.3);
    ctx.closePath();
    ctx.fillStyle = filled ? '#ff4f6d' : 'rgba(255,255,255,0.35)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawEffectBar(icon, ratio, y, color) {
    ctx.save();
    ctx.font = '16px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000'; ctx.fillText(icon, 14, y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fillRect(38, y - 5, 60, 10);
    ctx.fillStyle = color; ctx.fillRect(38, y - 5, 60 * Math.max(0, ratio), 10);
    ctx.restore();
  }

  function drawHud() {
    if (els.vStart.classList.contains('on')) return;
    outlinedText(String(game.score), W / 2, SAFE_TOP + 40, 'bold 52px sans-serif');
    if (game.mode === 'adventure') {
      for (let i = 0; i < C.MAX_HEARTS; i++) drawHeart(26 + i * 28, SAFE_TOP + 12, 22, i < game.hearts);
      let y = SAFE_TOP + 50;
      if (game.play < game.starUntil) { drawEffectBar('⭐', (game.starUntil - game.play) / C.STAR_FRAMES, y, '#f4b41a'); y += 24; }
      if (game.play < game.slowUntil) drawEffectBar('🐢', (game.slowUntil - game.play) / C.SLOW_FRAMES, y, '#3cb371');
    }
    if (banner.until > game.play && game.phase === 'play') {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (banner.until - game.play) / 20);
      outlinedText(banner.text, W / 2, 300, 'bold 30px sans-serif', '#fff4a0');
      ctx.restore();
    }
    if (game.phase === 'ready') {
      const pulse = 0.6 + 0.4 * Math.sin(game.frames * 0.12);
      ctx.save();
      ctx.globalAlpha = pulse;
      outlinedText('タップで飛ぶ！', W / 2, game.birdY + 80, 'bold 26px sans-serif');
      ctx.font = '32px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('👆', W / 2, game.birdY + 125 - pulse * 8);
      ctx.restore();
    }
    if (paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, W, H);
      outlinedText('タップで再開', W / 2, H / 2, 'bold 28px sans-serif');
    }
  }

  function render() {
    const pal = C.palette(game.score);
    drawBackground(pal);
    for (const p of game.pipes) drawPipe(p, pal);
    for (const it of game.items) drawItem(it);
    drawGround(pal);
    drawBird();
    drawHud();
  }

  // ---- ループ ----
  function advance() {
    if (paused) return;
    C.step(game);
    if (game.stage >= 4 && game.phase === 'play') {   // 星空以降はたまに流れ星
      if (shootingStar) {
        shootingStar.x += 6; shootingStar.y -= 3;
        if (--shootingStar.life <= 0) shootingStar = null;
      } else if (Math.random() < 0.006) {
        shootingStar = { x: Math.random() * (W - 120), y: SAFE_TOP + 80 + Math.random() * 250, life: 30 };
      }
    }
    handleEvents();
  }

  function frame(t) {
    // 1 コマ目の差は負になることがある。上も下も止める
    const dt = lastT === null ? 0 : Math.min(MAX_CATCHUP_MS, Math.max(0, t - lastT));
    lastT = t;
    acc += dt;
    while (acc >= STEP_MS) { advance(); acc -= STEP_MS; }
    render();
    requestAnimationFrame(frame);
  }

  // ---- 画面の大きさ ----
  function setupCanvas() {
    // 塗る面積がそのまま重さになる。1.25 倍なら CPU4倍遅でも 50fps 前後 (1.5 倍は 37〜41fps と振れ、3 倍は 14fps)。絵は平たい図形なので細かさは足りる
    const dpr = Math.min(1.25, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function main() {
    setupCanvas();
    try {
      const saved = localStorage.getItem('suisuiMode');
      if (saved === 'adventure' || saved === 'classic') mode = saved;
    } catch (e) { /* ignore */ }
    showMute();
    showBests();
    game = C.create(mode);
    requestAnimationFrame(frame);

    // 自動テストから中身をのぞくための入口
    window.__app = {
      game: function () { return game; },
      paused: function () { return paused; },
      step: function (n) { for (let i = 0; i < (n || 1); i++) advance(); },
      render: render,
      startGame: startGame,
      showMenu: showMenu
    };
  }

  main();
})();
