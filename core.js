/*!
 * core.js — ふわりバードのロジック。DOM を触らないので node でテストできる。
 * 1 コマ = 1/60 秒の固定刻み。画面側は step() を呼ぶ回数だけ決める。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Core = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 画面は iPhone 16 Plus (430 x 932pt) 決め打ち
  const W = 430;
  const H = 932;
  const GROUND = 90;           // 下の安全域 34pt を含む
  const BIRD_X = 110;
  const BIRD_R = 15;
  const GRAVITY = 0.45;
  const FLAP = -7.5;
  const MAX_FALL = 10;
  const PIPE_W = 56;
  const PIPE_SPACING = 250;
  const FIRST_PIPE_DELAY = 100;
  const PIPE_MIN_TOP = 110;
  const PIPE_MARGIN = 110;     // 下の柱の最小の高さ
  const MAX_SHIFT = 240;       // 隣り合う隙間の中心が離れてよい上限 (登れる高さの範囲内)
  const MAX_HEARTS = 3;
  const HURT_FRAMES = 72;
  const STAR_FRAMES = 180;
  const SLOW_FRAMES = 240;
  const SLOW_RATE = 0.6;
  const ITEM_EVERY = 4;
  const ITEM_FROM_SCORE = 2;
  const ITEM_R = 14;
  const STAGE_LEN = 10;

  // クラシックは一発勝負。アドベンチャーはハート 3 つで、難しさもなだらかに上がる
  const MODES = {
    classic:   { gapStart: 180, gapMin: 140, gapStep: 4, speedStart: 2.1, speedMax: 2.5, speedStep: 0.04,  hearts: 1 },
    adventure: { gapStart: 200, gapMin: 150, gapStep: 2, speedStart: 2.1, speedMax: 2.5, speedStep: 0.016, hearts: 3 }
  };

  // 10 点ごとの空。隣の段へ 1 点ずつ色を混ぜる
  const STAGES = [
    { name: '朝',       sky: [[94, 171, 212], [131, 186, 207]], pipe: [[236, 140, 106], [201, 107, 78], [217, 120, 90]], ground: [[222, 216, 149], [210, 176, 72]], shade: 0, cloud: 0.7,  stars: 0,   moon: 0,   aurora: 0 },
    { name: '昼',       sky: [[64, 150, 224], [160, 214, 248]],  pipe: [[95, 182, 90], [62, 138, 59], [79, 163, 74]],     ground: [[190, 214, 110], [160, 140, 58]], shade: 0, cloud: 0.85, stars: 0,   moon: 0,   aurora: 0 },
    { name: '夕やけ',   sky: [[240, 110, 80], [255, 205, 120]],  pipe: [[160, 82, 106], [111, 52, 72], [138, 68, 89]],    ground: [[204, 160, 100], [150, 100, 60]], shade: 0.12, cloud: 0.55, stars: 0,   moon: 0,   aurora: 0 },
    { name: '夜',       sky: [[20, 28, 70], [58, 66, 128]],      pipe: [[64, 68, 112], [38, 41, 78], [52, 56, 96]],       ground: [[86, 96, 116], [54, 60, 86]],     shade: 0.42, cloud: 0.18, stars: 0.7, moon: 1,   aurora: 0 },
    { name: '星空',     sky: [[6, 8, 32], [30, 36, 86]],         pipe: [[46, 49, 90], [26, 28, 54], [38, 41, 74]],        ground: [[62, 68, 94], [38, 42, 64]],      shade: 0.58, cloud: 0.06, stars: 1,   moon: 1,   aurora: 0 },
    { name: 'オーロラ', sky: [[4, 22, 44], [12, 66, 78]],        pipe: [[32, 80, 94], [18, 50, 58], [26, 68, 80]],        ground: [[42, 84, 94], [26, 52, 62]],      shade: 0.5, cloud: 0.04, stars: 1,   moon: 0.6, aurora: 1 }
  ];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpRgb(a, b, t) {
    return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
  }

  function stageIndex(score) { return Math.min(STAGES.length - 1, Math.floor(score / STAGE_LEN)); }

  function palette(score) {
    const idx = stageIndex(score);
    const next = Math.min(STAGES.length - 1, idx + 1);
    const t = idx === next ? 0 : (score - idx * STAGE_LEN) / STAGE_LEN;
    const a = STAGES[idx], b = STAGES[next];
    return {
      sky: [lerpRgb(a.sky[0], b.sky[0], t), lerpRgb(a.sky[1], b.sky[1], t)],
      pipe: [0, 1, 2].map(function (i) { return lerpRgb(a.pipe[i], b.pipe[i], t); }),
      ground: [lerpRgb(a.ground[0], b.ground[0], t), lerpRgb(a.ground[1], b.ground[1], t)],
      shade: lerp(a.shade, b.shade, t),
      cloud: lerp(a.cloud, b.cloud, t),
      stars: lerp(a.stars, b.stars, t),
      moon: lerp(a.moon, b.moon, t),
      aurora: lerp(a.aurora, b.aurora, t)
    };
  }

  const BOB_Y = H / 2.5;

  /** seed を渡せば、柱の高さもアイテムも毎回同じになる。 */
  function create(mode, seed) {
    const m = mode === 'adventure' ? 'adventure' : 'classic';
    return {
      mode: m,
      cfg: MODES[m],
      rng: mulberry32(seed === undefined ? (Math.random() * 4294967296) >>> 0 : seed),
      phase: 'ready',      // ready: 最初のタップ待ち / play / over
      birdY: BOB_Y,
      vy: 0,
      pipes: [],
      items: [],
      score: 0,
      pipeCount: 0,
      frames: 0,           // 常に進む (描画の動き用)
      play: 0,             // 遊んでいる間だけ進む (無敵などの時間)
      groundOffset: 0,
      hearts: MODES[m].hearts,
      hurtUntil: 0,
      starUntil: 0,
      slowUntil: 0,
      lastTop: null,
      stage: 0,
      stats: { items: 0, heartsUsed: 0 },
      events: []           // 画面が拾って音などにする: flap pass stage hit item over
    };
  }

  function gapFor(s) { return Math.max(s.cfg.gapMin, s.cfg.gapStart - s.score * s.cfg.gapStep); }
  function speedFor(s) {
    const v = Math.min(s.cfg.speedMax, s.cfg.speedStart + s.score * s.cfg.speedStep);
    return s.play < s.slowUntil ? v * SLOW_RATE : v;
  }
  function isProtected(s) { return s.play < s.hurtUntil || s.play < s.starUntil; }

  function spawnPipe(s) {
    const gap = gapFor(s);
    const maxTop = H - GROUND - gap - PIPE_MARGIN;
    let lo = PIPE_MIN_TOP, hi = maxTop;
    // 前の隙間から離れすぎると、登りきれずに詰む
    if (s.lastTop !== null) {
      lo = Math.max(lo, s.lastTop - MAX_SHIFT);
      hi = Math.min(hi, s.lastTop + MAX_SHIFT);
    }
    const top = lo + s.rng() * (hi - lo);
    s.lastTop = top;
    s.pipes.push({ x: W, top: top, gap: gap, scored: false });
    s.pipeCount++;
    // アイテムは隙間の中央。取りに行く動きがそのまま練習になる
    if (s.mode === 'adventure' && s.score >= ITEM_FROM_SCORE && s.pipeCount % ITEM_EVERY === 0) {
      const r = s.rng();
      let type = r < 0.4 ? 'star' : r < 0.75 ? 'slow' : 'heart';
      if (type === 'heart' && s.hearts >= MAX_HEARTS) type = 'star';
      s.items.push({ x: W + PIPE_W / 2, y: top + gap / 2, type: type });
    }
  }

  /** 'ground' | 'pipe' | null (天井は死なずに頭打ち) */
  function collision(s) {
    const br = BIRD_R - 2;
    if (s.birdY + br >= H - GROUND) return 'ground';
    for (let i = 0; i < s.pipes.length; i++) {
      const p = s.pipes[i];
      if (BIRD_X + br > p.x && BIRD_X - br < p.x + PIPE_W) {
        if (s.birdY - br < p.top || s.birdY + br > p.top + p.gap) return 'pipe';
      }
    }
    return null;
  }

  function loseHeart(s) {
    s.hearts--;
    s.hurtUntil = s.play + HURT_FRAMES;
    s.stats.heartsUsed++;
    s.events.push('hit');
  }

  function takeItem(s, it) {
    if (it.type === 'star') s.starUntil = s.play + STAR_FRAMES;
    else if (it.type === 'slow') s.slowUntil = s.play + SLOW_FRAMES;
    else s.hearts = Math.min(MAX_HEARTS, s.hearts + 1);
    s.stats.items++;
    s.events.push('item');
  }

  function flap(s) {
    if (s.phase === 'over') return;
    if (s.phase === 'ready') s.phase = 'play';
    s.vy = FLAP;
    s.events.push('flap');
  }

  function step(s) {
    if (s.phase === 'over') return;
    s.frames++;
    if (s.phase === 'ready') {
      s.birdY = BOB_Y + Math.sin(s.frames * 0.08) * 6;
      return;
    }
    s.play++;
    s.vy = Math.min(s.vy + GRAVITY, MAX_FALL);
    s.birdY += s.vy;
    if (s.birdY - BIRD_R < 0) {
      s.birdY = BIRD_R;
      if (s.vy < 0) s.vy = 0;
    }

    const speed = speedFor(s);
    s.groundOffset += speed;
    if (s.play >= FIRST_PIPE_DELAY &&
        (s.pipes.length === 0 || s.pipes[s.pipes.length - 1].x <= W - PIPE_SPACING)) {
      spawnPipe(s);
    }
    for (let i = s.pipes.length - 1; i >= 0; i--) {
      const p = s.pipes[i];
      p.x -= speed;
      if (!p.scored && p.x + PIPE_W < BIRD_X) {
        p.scored = true;
        s.score++;
        if (s.score % STAGE_LEN === 0) {
          s.stage = s.score / STAGE_LEN;
          s.events.push('stage');
        } else {
          s.events.push('pass');
        }
      }
      if (p.x + PIPE_W < 0) s.pipes.splice(i, 1);
    }
    for (let j = s.items.length - 1; j >= 0; j--) {
      const it = s.items[j];
      it.x -= speed;
      const dx = it.x - BIRD_X, dy = it.y - s.birdY, reach = BIRD_R + ITEM_R;
      if (dx * dx + dy * dy < reach * reach) {
        takeItem(s, it);
        s.items.splice(j, 1);
      } else if (it.x < -ITEM_R) {
        s.items.splice(j, 1);
      }
    }

    const hit = collision(s);
    if (hit) {
      if (s.mode === 'adventure') {
        if (hit === 'ground') {
          // 地面は跳ね返す。無敵中でなければハートを 1 つ失う
          s.birdY = H - GROUND - (BIRD_R - 2);
          s.vy = FLAP * 1.3;
          if (!isProtected(s)) loseHeart(s);
        } else if (!isProtected(s)) {
          loseHeart(s);
        }
        if (s.hearts <= 0) { s.phase = 'over'; s.events.push('over'); }
      } else {
        s.hearts = 0;
        s.phase = 'over';
        s.events.push('over');
      }
    }
  }

  return {
    W: W, H: H, GROUND: GROUND, BIRD_X: BIRD_X, BIRD_R: BIRD_R, PIPE_W: PIPE_W,
    PIPE_SPACING: PIPE_SPACING, MAX_HEARTS: MAX_HEARTS, ITEM_R: ITEM_R,
    STAR_FRAMES: STAR_FRAMES, SLOW_FRAMES: SLOW_FRAMES, HURT_FRAMES: HURT_FRAMES,
    STAGE_LEN: STAGE_LEN, STAGES: STAGES, MODES: MODES, MAX_SHIFT: MAX_SHIFT,
    mulberry32: mulberry32, create: create, flap: flap, step: step,
    palette: palette, stageIndex: stageIndex, gapFor: gapFor, isProtected: isProtected
  };
});
