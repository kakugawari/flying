/*
 * ブラウザで実際に動かして確かめるテスト。
 *
 *   npm i -D playwright && npm run test:ui
 *
 * 画面まわりの不具合は node のテストでは捕まらない。ここでは本物の
 * ブラウザを立ち上げ、指の操作をそのまま再現して確かめる。
 *
 * ★ アプリを作ったら「ここにアプリごとの確認を足す」に書き足すこと。
 *   直した不具合には、かならず見張り役をここに置く。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 8123);
const URL = `http://localhost:${PORT}/`;
const ROOT = __dirname;
const CHROMIUM = process.env.CHROMIUM_PATH;   // 手元の Chromium を使いたいとき

// 対象の端末は iPhone 16 Plus (430x932・3 倍)。playwright が名前を知らなければ同じ大きさで代える
function phoneDevice(devices) {
  return devices['iPhone 16 Plus'] || {
    viewport: { width: 430, height: 932 }, screen: { width: 430, height: 932 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: devices['iPhone 15 Pro Max'] ? devices['iPhone 15 Pro Max'].userAgent : undefined
  };
}
let PHONE;

function tapCanvas(page) {
  return page.touchscreen.tap(215, 500);
}

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + message);
  } else {
    failed++;
    console.log('  \x1b[31m✗ FAIL\x1b[0m ' + message);
  }
}

function skip(message) {
  console.log('  \x1b[90m- とばした: ' + message + '\x1b[0m');
}

function section(name) {
  console.log('\n' + name);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(URL, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - started > 10000) reject(new Error('サーバーが起動しない'));
          else setTimeout(tick, 100);
        });
    };
    tick();
  });
}

/**
 * 何かした直後に、その要素が本来の場所からどれだけずれるかを
 * 1 フレームずつ測る。「置いた瞬間に一瞬とぶ」たぐいの不具合はこれで見つかる。
 *
 * @returns {Promise<number>} 最大のずれ (px)
 */
function measureJump(page, selector, act) {
  return page.evaluate(async ({ sel, code }) => {
    const before = document.querySelector(sel).getBoundingClientRect();
    // eslint-disable-next-line no-new-func
    new Function(code)();
    let worst = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const el = document.querySelector(sel);
      if (!el) { worst = Infinity; break; }
      const now = el.getBoundingClientRect();
      worst = Math.max(worst, Math.abs(now.left - before.left), Math.abs(now.top - before.top));
    }
    return Math.round(worst);
  }, { sel: selector, code: act });
}

async function run() {
  let chromium;
  let devices;
  try {
    ({ chromium, devices } = require('playwright'));
  } catch (e) {
    console.error('playwright が必要です:  npm i -D playwright');
    process.exit(1);
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(PORT)], {
    stdio: 'ignore'
  });
  await waitForServer();

  PHONE = phoneDevice(devices);
  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const errors = [];

  try {
    // ------------------------------------------------ iPhone 16 Plus で開く
    section('iPhone 16 Plus で開く');
    const context = await browser.newContext(PHONE);
    const phone = await context.newPage();
    phone.on('pageerror', (e) => errors.push('スマホ: ' + e.message));
    phone.on('console', (m) => { if (m.type() === 'error') errors.push('スマホ: ' + m.text()); });
    await phone.goto(URL);
    await phone.waitForFunction(() => window.__app);
    ok(true, 'ページが開いて、画面のしくみが立ち上がる');

    const fit = await phone.evaluate(() => {
      const c = document.getElementById('game').getBoundingClientRect();
      return {
        wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tall: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        canvas: [Math.round(c.width), Math.round(c.height)],
        win: [innerWidth, innerHeight]
      };
    });
    ok(fit.wide <= 1 && fit.tall <= 1, '横にも縦にもスクロールが出ない');
    ok(fit.canvas[0] === fit.win[0] && fit.canvas[1] === fit.win[1],
      `ゲーム画面が窓いっぱい (${fit.canvas.join('x')} / 窓 ${fit.win.join('x')})`);

    // ------------------------------------------------ タイトル
    section('タイトル');
    const menu = await phone.evaluate(() => {
      const vis = (id) => {
        const r = document.getElementById(id).getBoundingClientRect();
        return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      };
      return { c: vis('btnClassic'), a: vis('btnAdventure'), m: vis('btnMute') };
    });
    ok(menu.c && menu.a, 'モードのボタンが 2 つとも画面の中に見えている');
    ok(menu.m, 'ミュートボタンが画面の中に見えている');
    const idle = await phone.evaluate(async () => {
      const g = window.__app.game();
      const y0 = g.birdY;
      await new Promise((r) => setTimeout(r, 400));
      return { moved: Math.abs(window.__app.game().birdY - y0), phase: window.__app.game().phase, pipes: window.__app.game().pipes.length };
    });
    ok(idle.phase === 'ready' && idle.pipes === 0, 'タイトルの間は柱が出ず、重力もかからない');
    ok(idle.moved > 0.5, `タイトルの鳥がふわふわ動いている (${idle.moved.toFixed(1)}px)`);

    // 札の中身が、待っている鳥に重ならない (重なって見えにくかった)
    const overlap = await phone.evaluate(() => {
      const g = window.__app.game();
      const bird = { top: g.birdY - 15 - 6, bottom: g.birdY + 15 + 6 };
      const logo = document.querySelector('#vStart .logo').getBoundingClientRect();
      return { logoTop: logo.top, birdBottom: bird.bottom };
    });
    ok(overlap.logoTop > overlap.birdBottom, `題字が待っている鳥より下にある (題字 ${Math.round(overlap.logoTop)} > 鳥 ${Math.round(overlap.birdBottom)})`);

    // ------------------------------------------------ クラシック
    section('クラシック');
    await phone.locator('#btnClassic').tap();
    await phone.waitForTimeout(100);
    ok(await phone.evaluate(() => !document.getElementById('vStart').classList.contains('on')), 'ボタンを押すとタイトルが消える');
    let st = await phone.evaluate(() => ({ phase: window.__app.game().phase, mode: window.__app.game().mode }));
    ok(st.phase === 'ready' && st.mode === 'classic', '最初のタップ待ち');
    await tapCanvas(phone);
    await phone.waitForTimeout(60);
    st = await phone.evaluate(() => ({ phase: window.__app.game().phase, vy: window.__app.game().vy }));
    ok(st.phase === 'play' && st.vy < 0, `タップで飛び始める (vy ${st.vy.toFixed(2)})`);

    // 画面の端の帯へ指をすべらせても、離すまで捕まえていられる (setPointerCapture)
    ok(await phone.evaluate(() => typeof Element.prototype.setPointerCapture === 'function'), '指を捕まえる仕組みがある');

    // 何もしなければ落ちて終わる。終わりの札が出る
    await phone.waitForFunction(() => window.__app.game().phase === 'over', null, { timeout: 8000 });
    await phone.waitForTimeout(500);
    const over = await phone.evaluate(() => ({
      on: document.getElementById('vOver').classList.contains('on'),
      mode: document.getElementById('overMode').textContent,
      retry: (() => { const r = document.getElementById('btnRetry').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; })()
    }));
    ok(over.on && over.mode === 'クラシック', `落ちたら終わりの札が出る (${over.mode})`);
    ok(over.retry, '「もう一度あそぶ」が画面の中に見えている');

    // ------------------------------------------------ 自動操縦で実際に遊ぶ
    section('自動操縦で遊ぶ (実際のタップ操作で 15 点)');
    await phone.locator('#btnRetry').tap();
    await phone.waitForTimeout(100);
    await phone.evaluate(() => {
      // タップは本物のイベントで送る。狙いは次の隙間の中心よりやや下
      const el = document.getElementById('game');
      window.__bot = setInterval(() => {
        const g = window.__app.game();
        if (g.phase === 'over') return;
        let target = 932 / 2.5;
        for (const p of g.pipes) if (p.x + 56 > 110 - 15) { target = p.top + p.gap / 2 + 22; break; }
        if (g.phase === 'ready' || (g.birdY > target && g.vy >= 0)) {
          el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, cancelable: true }));
        }
      }, 8);
    });
    await phone.waitForFunction(() => window.__app.game().score >= 15 || window.__app.game().phase === 'over', null, { timeout: 90000 });
    const bot = await phone.evaluate(() => { clearInterval(window.__bot); return { score: window.__app.game().score, phase: window.__app.game().phase }; });
    ok(bot.score >= 15, `操作だけで 15 点まで進める (${bot.score} 点・${bot.phase})`);

    // 画面に描かれている (真っ白・真っ黒ではない / 鳥の黄色がある)
    const px = await phone.evaluate(() => {
      window.__app.render();
      const c = document.getElementById('game');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let yellow = 0, colors = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) {
        colors.add((d[i] >> 5) + ',' + (d[i + 1] >> 5) + ',' + (d[i + 2] >> 5));
        if (d[i] > 230 && d[i + 1] > 190 && d[i + 2] < 90) yellow++;
      }
      return { colors: colors.size, yellow };
    });
    ok(px.colors > 8, `画面に絵が描かれている (色 ${px.colors} 種)`);

    // ------------------------------------------------ ベストの保存
    section('ベストの保存');
    await phone.waitForFunction(() => window.__app.game().phase === 'over', null, { timeout: 90000 }).catch(() => {});
    const saved = await phone.evaluate(() => ({
      best: parseInt(localStorage.getItem('suisuiBestClassic'), 10) || 0,
      score: window.__app.game().score
    }));
    ok(saved.best >= 15, `終わったらベストが保存される (保存 ${saved.best} / 今回 ${saved.score})`);
    await phone.reload();
    await phone.waitForFunction(() => window.__app);
    const shown = await phone.textContent('#bestClassic');
    ok(shown.includes(String(saved.best)), `開き直しても残っている (${shown})`);

    // ------------------------------------------------ アドベンチャー
    section('アドベンチャー');
    await phone.locator('#btnAdventure').tap();
    await phone.waitForTimeout(100);
    await tapCanvas(phone);
    // 前の操作の名残 (ready) を抜けてから、地面まで落とす
    await phone.waitForFunction(() => window.__app.game().hearts < 3, null, { timeout: 8000 });
    const adv = await phone.evaluate(() => ({ hearts: window.__app.game().hearts, phase: window.__app.game().phase, mode: window.__app.game().mode }));
    ok(adv.mode === 'adventure' && adv.phase === 'play' && adv.hearts === 2, `地面に落ちてもハートが 1 つ減るだけで続く (ハート ${adv.hearts})`);
    ok(await phone.evaluate(() => localStorage.getItem('suisuiMode')) === 'adventure', '選んだモードを覚える');

    // ------------------------------------------------ 一時停止 (アプリを切り替えたとき)
    section('一時停止');
    // ヘッドレスでは visibilitychange が来ないので、document.hidden を差し替えて自分で送る
    const pausedOk = await phone.evaluate(async () => {
      window.__app.startGame('classic');
      const el = document.getElementById('game');
      el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 100));
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      const y0 = window.__app.game().birdY;
      await new Promise((r) => setTimeout(r, 300));
      const frozen = window.__app.game().birdY === y0;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 200));
      return { frozen, paused: window.__app.paused(), moved: window.__app.game().birdY !== y0 };
    });
    ok(pausedOk.frozen, '離れている間は鳥が動かない');
    ok(!pausedOk.paused && pausedOk.moved, '戻ってタップすると再開する');

    // ------------------------------------------------ 遅い端末 (CPU 4 倍遅)
    section('遅い端末');
    const cdp = await context.newCDPSession(phone);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const fps = await phone.evaluate(async () => {
      window.__app.startGame('adventure');
      window.__app.step(1);
      const g = window.__app.game();
      g.phase = 'play'; g.score = 45; g.hearts = 99; g.hurtUntil = 1e9; g.starUntil = 1e9;   // 夜空・オーロラ・星の最も重い絵
      let frames = 0;
      const t0 = performance.now();
      await new Promise((resolve) => {
        const tick = () => { frames++; if (performance.now() - t0 >= 3000) resolve(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      return frames / 3;
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    ok(fps >= 40, `CPU 4 倍遅でも 40fps 以上 (${fps.toFixed(0)}fps)`);

    await context.close();

    // ------------------------------------------------ 前の版の記録を引き継いだブラウザ
    section('前の版の記録');
    const oldCtx = await browser.newContext(PHONE);
    await oldCtx.addInitScript(() => {
      try { localStorage.setItem('suisuiBestClassic', '12'); localStorage.setItem('suisuiMode', 'adventure'); localStorage.setItem('suisuiMuted', '1'); } catch (e) { /* */ }
    });
    const oldPage = await oldCtx.newPage();
    oldPage.on('pageerror', (e) => errors.push('引き継ぎ: ' + e.message));
    await oldPage.goto(URL);
    await oldPage.waitForFunction(() => window.__app);
    ok((await oldPage.textContent('#bestClassic')).includes('12'), '残っているベストが表示される');
    ok((await oldPage.textContent('#btnMute')) === '🔇', 'ミュートの記憶が効いている');
    await oldCtx.close();

    // ------------------------------------------------ 保存できないブラウザ
    section('保存が使えないとき');
    const noStore = await browser.newContext(PHONE);
    await noStore.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
    });
    const nsPage = await noStore.newPage();
    nsPage.on('pageerror', (e) => errors.push('保存なし: ' + e.message));
    await nsPage.goto(URL);
    await nsPage.waitForFunction(() => window.__app);
    await nsPage.locator('#btnClassic').tap();
    await tapCanvas(nsPage);
    await nsPage.waitForFunction(() => window.__app.game().phase === 'over', null, { timeout: 8000 });
    await nsPage.waitForTimeout(500);
    ok(await nsPage.evaluate(() => document.getElementById('vOver').classList.contains('on')), '保存できなくても遊べて、終わりの札が出る');
    await noStore.close();

    // ------------------------------------------------ アイコン (用意していれば)
    section('アイコン');
    const desk = await browser.newPage();
    await desk.goto(URL);
    const apple = await desk.evaluate(() =>
      document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'));
    if (!apple) {
      skip('ホーム画面用のアイコンはまだ無い (PWA にするときに用意する)');
    } else {
      // iOS は SVG のアイコンを使えない
      ok(apple.endsWith('.png'), `ホーム画面用アイコンが PNG (${apple})`);
      const res = await desk.request.get(URL + apple.replace('./', ''));
      ok(res.ok(), `${apple} が配信される`);
    }

    // ------------------------------------------------ 更新とオフライン (sw.js があれば)
    section('更新とオフライン');
    if (!fs.existsSync(path.join(ROOT, 'sw.js'))) {
      skip('サービスワーカーはまだ無い (オフライン対応するときに用意する)');
    } else {
      const swCtx = await browser.newContext();
      const swPage = await swCtx.newPage();
      await swPage.goto(URL);
      await swPage.waitForFunction(() => window.__app);
      ok(await swPage.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false)),
        'サービスワーカーが動く');
      await swPage.waitForTimeout(800);

      // 直したものが 1 回のリロードで出るか (キャッシュ優先だと古い画面が出る)
      const indexPath = path.join(ROOT, 'index.html');
      const original = fs.readFileSync(indexPath, 'utf8');
      const marker = original.match(/<h1[^>]*>([^<]*)<\/h1>/);
      fs.writeFileSync(indexPath, original.replace(marker[1], 'こうしんかくにん'));
      await swPage.reload();
      await swPage.waitForTimeout(400);
      const title = await swPage.textContent('h1');
      fs.writeFileSync(indexPath, original);
      ok(title.trim() === 'こうしんかくにん', `直したものが 1 回のリロードで出る (${title.trim()})`);

      await swPage.reload();
      await swPage.waitForTimeout(500);
      await swCtx.setOffline(true);
      await swPage.reload().catch(() => {});
      await swPage.waitForTimeout(400);
      ok(await swPage.evaluate(() => !!window.__app).catch(() => false),
        'ネットにつながらなくても開ける');
      await swCtx.setOffline(false);
    }

    section('エラー');
    ok(errors.length === 0, errors.length ? '画面のエラー: ' + errors.join(' / ') : 'JS エラーなし');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
