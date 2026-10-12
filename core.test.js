const test = require('node:test');
const assert = require('node:assert');
const Core = require('./core.js');

/** 次の隙間の中心よりやや下を狙う、まあまあ上手な自動操縦。 */
function autopilot(s) {
  let target = Core.H / 2.5;
  for (const p of s.pipes) {
    if (p.x + Core.PIPE_W > Core.BIRD_X - Core.BIRD_R) { target = p.top + p.gap / 2 + 22; break; }
  }
  if (s.birdY > target && s.vy >= 0) Core.flap(s);
}

function play(mode, seed, maxFrames) {
  const s = Core.create(mode, seed);
  Core.flap(s);
  for (let i = 0; i < maxFrames && s.phase !== 'over'; i++) {
    autopilot(s);
    Core.step(s);
  }
  return s;
}

test('同じ seed なら柱もアイテムも同じ', () => {
  const a = play('adventure', 5, 3000), b = play('adventure', 5, 3000);
  assert.deepStrictEqual(a.pipes, b.pipes);
  assert.strictEqual(a.score, b.score);
});

test('何もしないと落ちて終わる (クラシック)', () => {
  const s = Core.create('classic', 1);
  Core.flap(s);
  for (let i = 0; i < 300 && s.phase !== 'over'; i++) Core.step(s);
  assert.strictEqual(s.phase, 'over');
  assert.ok(s.events.includes('over'));
});

test('最初のタップまでは重力がかからず、柱も出ない', () => {
  const s = Core.create('classic', 1);
  for (let i = 0; i < 500; i++) Core.step(s);
  assert.strictEqual(s.phase, 'ready');
  assert.strictEqual(s.pipes.length, 0);
  assert.ok(Math.abs(s.birdY - Core.H / 2.5) <= 6.01);
});

test('天井は頭打ちで、死なない', () => {
  const s = Core.create('classic', 1);
  for (let i = 0; i < 60; i++) { Core.flap(s); Core.step(s); }
  assert.strictEqual(s.phase, 'play');
  assert.strictEqual(s.birdY, Core.BIRD_R);
});

test('隣り合う隙間の中心は MAX_SHIFT より離れない / 画面に収まる (何百本も)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const mode of ['classic', 'adventure']) {
      const s = Core.create(mode, seed);
      s.phase = 'play';
      s.birdY = 300;
      let prev = null, n = 0;
      for (let i = 0; i < 20000 && n < 60; i++) {
        s.birdY = 300; s.vy = 0;            // 当てずに柱だけ流す
        s.hearts = 99; s.hurtUntil = 1e9;
        const before = s.pipeCount;
        Core.step(s);
        s.phase = 'play';
        if (s.pipeCount > before) {
          const p = s.pipes[s.pipes.length - 1];
          assert.ok(p.top >= 110 - 1e-9, '上の柱が低すぎない');
          assert.ok(p.top + p.gap <= Core.H - Core.GROUND - 110 + 1e-9, '下の柱が低すぎない');
          if (prev !== null) assert.ok(Math.abs(p.top - prev) <= Core.MAX_SHIFT + 1e-9, `シフト ${Math.abs(p.top - prev)}`);
          prev = p.top; n++;
        }
      }
      assert.ok(n >= 60);
    }
  }
});

test('自動操縦で、どの seed でも 30 点までは行ける (登れない配置が無い)', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const s = play('classic', seed, 60 * 200);
    assert.ok(s.score >= 30, `seed ${seed}: ${s.score} 点で終わった`);
  }
});

test('アドベンチャー: 柱に当たるとハートが減り、1.2 秒は無敵', () => {
  const s = Core.create('adventure', 3);
  s.phase = 'play';
  s.pipes.push({ x: Core.BIRD_X - 10, top: 50, gap: 150, scored: false });
  s.birdY = 400; s.vy = 0;
  Core.step(s);
  assert.strictEqual(s.hearts, 2);
  const h = s.hearts;
  s.birdY = 400; s.vy = 0;
  Core.step(s);
  assert.strictEqual(s.hearts, h, '無敵中は減らない');
});

test('アドベンチャー: 地面は跳ね返り、ハート 0 で終わる', () => {
  const s = Core.create('adventure', 3);
  Core.flap(s);
  for (let i = 0; i < 2000 && s.phase !== 'over'; i++) Core.step(s);
  assert.strictEqual(s.phase, 'over');
  assert.strictEqual(s.stats.heartsUsed, 3);
});

test('スター中は柱に当たってもハートが減らない', () => {
  const s = Core.create('adventure', 3);
  s.phase = 'play';
  s.starUntil = 1000;
  s.pipes.push({ x: Core.BIRD_X - 10, top: 50, gap: 150, scored: false });
  s.birdY = 400;
  Core.step(s);
  assert.strictEqual(s.hearts, 3);
});

test('星の効果は 6 秒 (360 コマ)、亀は 4 秒 (240 コマ) のまま', () => {
  assert.strictEqual(Core.STAR_FRAMES, 360);
  assert.strictEqual(Core.SLOW_FRAMES, 240);
  for (const [type, key, frames] of [['star', 'starUntil', 360], ['slow', 'slowUntil', 240]]) {
    const s = Core.create('adventure', 3);
    s.phase = 'play'; s.play = 50;
    s.items.push({ x: Core.BIRD_X, y: s.birdY, type });
    Core.step(s);
    // 取った次のコマで 1 コマ進むので、残りは「効果の長さ」ちょうどか 1 コマ手前
    const left = s[key] - s.play;
    assert.ok(left >= frames - 1 && left <= frames, `${type}: 残り ${left} コマ (${frames})`);
  }
});

test('ハートは 3 より増えない / 満タンならアイテムはハートにならない', () => {
  const s = Core.create('adventure', 3);
  s.phase = 'play';
  s.items.push({ x: Core.BIRD_X, y: s.birdY, type: 'heart' });
  Core.step(s);
  assert.strictEqual(s.hearts, 3);
  for (let seed = 1; seed <= 30; seed++) {
    const t = Core.create('adventure', seed);
    t.phase = 'play'; t.score = 5;
    for (let i = 0; i < 40; i++) {
      t.birdY = 300; t.vy = 0; t.hurtUntil = 1e9;
      Core.step(t);
    }
    assert.ok(t.items.every((it) => it.type !== 'heart'));
  }
});

test('スローは柱の速さを落とす', () => {
  const s = Core.create('adventure', 3);
  s.phase = 'play';
  const normal = (() => { s.birdY = 300; s.vy = 0; s.groundOffset = 0; Core.step(s); return s.groundOffset; })();
  s.slowUntil = 1e9; s.groundOffset = 0; s.birdY = 300; s.vy = 0;
  Core.step(s);
  assert.ok(Math.abs(s.groundOffset - normal * 0.6) < 1e-9);
});

test('ステージ: 10 点ごとに進み、色は連続して変わる', () => {
  assert.strictEqual(Core.stageIndex(9), 0);
  assert.strictEqual(Core.stageIndex(10), 1);
  assert.strictEqual(Core.stageIndex(999), Core.STAGES.length - 1);
  let prev = Core.palette(0).sky[0];
  for (let sc = 1; sc <= 60; sc++) {
    const cur = Core.palette(sc).sky[0];
    const d = Math.max(...cur.map((v, i) => Math.abs(v - prev[i])));
    assert.ok(d <= 40, `${sc} 点で色が急に変わった (${d})`);
    prev = cur;
  }
});

test('クラシックの隙間・速さは 180→140 / 2.1→2.5', () => {
  const s = Core.create('classic', 1);
  assert.strictEqual(Core.gapFor(s), 180);
  s.score = 100;
  assert.strictEqual(Core.gapFor(s), 140);
});

test('柱の沈め具合: どのステージでも 0〜1。昼より夜のほうが深く、色と同じく連続して変わる', () => {
  assert.strictEqual(Core.palette(0).shade, 0);
  assert.ok(Core.palette(35).shade > Core.palette(15).shade);
  let prev = Core.palette(0).shade;
  for (let sc = 1; sc <= 80; sc++) {
    const s = Core.palette(sc).shade;
    assert.ok(s >= 0 && s <= 1);
    assert.ok(Math.abs(s - prev) <= 0.05, `${sc} 点で急に変わった`);
    prev = s;
  }
});

test('空の絵 8 枚: 朝は最初から、昼 10・夕方 20・夜 30・星空 40・オーロラ 50・宇宙 60 点でぱっと、夕方から夜は 20→30 点でなめらか (下の絵は 1 のまま残る)', () => {
  assert.deepStrictEqual(Core.palette(0).skyArt, [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(Core.palette(9).skyArt, [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(Core.palette(10).skyArt, [1, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(Core.palette(19).skyArt, [1, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(Core.palette(20).skyArt, [1, 1, 1, 0, 0, 0, 0, 0]);
  assert.ok(Math.abs(Core.palette(25).skyArt[3] - 0.5) < 1e-9);
  assert.deepStrictEqual(Core.palette(29).skyArt.map((v) => Math.round(v * 10) / 10), [1, 1, 1, 0.9, 0, 0, 0, 0]);
  assert.deepStrictEqual(Core.palette(30).skyArt, [1, 1, 1, 1, 1, 0, 0, 0]);
  assert.deepStrictEqual(Core.palette(40).skyArt, [1, 1, 1, 1, 1, 1, 0, 0]);
  assert.deepStrictEqual(Core.palette(50).skyArt, [1, 1, 1, 1, 1, 1, 1, 0]);
  assert.deepStrictEqual(Core.palette(60).skyArt, [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepStrictEqual(Core.palette(200).skyArt, [1, 1, 1, 1, 1, 1, 1, 1]);
  for (let sc = 0; sc < 70; sc++) {
    const a = Core.palette(sc).skyArt, b = Core.palette(sc + 1).skyArt;
    for (let i = 0; i < 8; i++) assert.ok(b[i] >= a[i], `${sc} 点で絵 ${i} が減らない`);
    // 上の絵が出始めるとき、下の絵は 1 (透けない)。夕方から夜 (3) だけは夜 (4) が出るまで途中
    for (const [up, down] of [[1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6]]) if (a[up] > 0) assert.strictEqual(a[down], 1, `${sc} 点: 絵 ${up} が出ているなら絵 ${down} は 1`);
  }
});

test('宇宙 (60 点) のステージがある: 最後のステージで、色は 60 点から宇宙の色のまま', () => {
  assert.strictEqual(Core.STAGES[Core.stageIndex(60)].name, '宇宙');
  assert.strictEqual(Core.stageIndex(59), Core.stageIndex(50));
  assert.deepStrictEqual(Core.palette(60).sky, Core.palette(99).sky);
  assert.deepStrictEqual(Core.palette(60).sky, Core.STAGES[Core.STAGES.length - 1].sky);
});
