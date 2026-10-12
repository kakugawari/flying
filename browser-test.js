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
      // 周期は約 1.3 秒。揺れの端で測ると差が小さく出るので、1.5 秒のあいだの最大と最小の幅を見る
      let lo = Infinity, hi = -Infinity;
      const t0 = performance.now();
      while (performance.now() - t0 < 1500) {
        const y = window.__app.game().birdY; lo = Math.min(lo, y); hi = Math.max(hi, y);
        await new Promise((r) => setTimeout(r, 30));
      }
      return { moved: hi - lo, phase: window.__app.game().phase, pipes: window.__app.game().pipes.length };
    });
    ok(idle.phase === 'ready' && idle.pipes === 0, 'タイトルの間は柱が出ず、重力もかからない');
    ok(idle.moved > 8, `タイトルの鳥がふわふわ動いている (1.5 秒で ${idle.moved.toFixed(1)}px の幅)`);

    // 待っている鳥 (y≒373) が、ロゴ・「タップでスタート」・モード選択のどれにも隠れない (鳥は ロゴ と 札 のあいだ)
    const layout = await phone.evaluate(() => {
      const g = window.__app.game();
      const bird = { top: g.birdY - 30, bottom: g.birdY + 30 };
      const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      const logo = r('#vStart .title-logo'), start = r('#btnQuick'), panel = r('#vStart .title-panel');
      return { bird, logoBottom: logo.bottom, logoTop: logo.top, startTop: start.top, startBottom: start.bottom, panelTop: panel.top, panelBottom: panel.bottom,
               logoW: logo.width, panelW: panel.width, startW: start.width };
    });
    ok(layout.logoBottom < layout.bird.top && layout.startTop > layout.bird.bottom,
      `待っている鳥が、ロゴと「タップでスタート」のあいだに見える (ロゴの下 ${layout.logoBottom.toFixed(0)} < 鳥 ${layout.bird.top.toFixed(0)}〜${layout.bird.bottom.toFixed(0)} < 札の上 ${layout.startTop.toFixed(0)})`);
    ok(layout.logoTop >= 59 && layout.panelBottom <= 932 - 34 && layout.startBottom < layout.panelTop, `タイトルの部品が、安全域をよけて重ならずに収まる (${layout.logoTop.toFixed(0)}〜${layout.panelBottom.toFixed(0)}pt)`);
    ok(layout.logoW <= 430 && layout.panelW <= 430 && layout.startW <= 430, 'タイトルの部品が、画面の幅に収まる');

    // 絵のボタンの上に、押せる範囲 (透明なボタン) と、ベストの数字が正しく重なる
    const hit = await phone.evaluate(() => {
      const res = {};
      for (const [id, best] of [['btnClassic', 'bestClassic'], ['btnAdventure', 'bestAdventure']]) {
        const b = document.getElementById(id).getBoundingClientRect(), s = document.getElementById(best).getBoundingClientRect();
        const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        res[id] = { top: document.elementFromPoint(cx, cy) === document.getElementById(id), bestInside: s.left >= b.left && s.right <= b.right && s.top >= b.top && s.bottom <= b.bottom, w: b.width, h: b.height };
      }
      const q = document.getElementById('btnQuick').getBoundingClientRect();
      res.quick = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2) === document.getElementById('btnQuick');
      return res;
    });
    ok(hit.btnClassic.top && hit.btnAdventure.top && hit.quick, 'モードのボタンと「タップでスタート」の真上は、それぞれのボタン (ほかの物に隠れない)');
    ok(hit.btnClassic.bestInside && hit.btnAdventure.bestInside, 'ベストの数字が、それぞれのボタンの絵の中に収まる');
    ok(hit.btnClassic.h >= 44 && hit.btnAdventure.h >= 44, `ボタンは指で押せる大きさ (高さ ${hit.btnClassic.h.toFixed(0)}/${hit.btnAdventure.h.toFixed(0)}pt)`);

    // タイトルの絵: 読め、四隅が透明で、背景の赤紫が残らず、絵の中に「ベスト」の文字の跡が無い (本物のテキストを重ねるため)
    const titleArt = await phone.evaluate(async () => {
      const load = async (src) => {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        return { w: img.width, h: img.height, d: x.getImageData(0, 0, img.width, img.height).data };
      };
      const info = (im) => {
        const A = (xx, yy) => im.d[(yy * im.w + xx) * 4 + 3];
        let magenta = 0;
        for (let i = 0; i < im.d.length; i += 4) if (im.d[i + 3] > 200 && im.d[i + 2] > im.d[i + 1] * 1.6 && im.d[i] > 150 && im.d[i + 1] < im.d[i] * 0.45) magenta++;
        return { size: [im.w, im.h], magenta, corner: A(0, 0) + A(im.w - 1, 0) + A(0, im.h - 1) + A(im.w - 1, im.h - 1) };
      };
      const logo = await load('assets/title-logo.webp'), start = await load('assets/title-start.webp'), panel = await load('assets/title-panel.webp');
      // 消した文字の場所 (札の絵の 2 倍の画素。ベストの数字の中心) に、文字の色が残っていないか
      const ink = (x0, y0, test) => { let n = 0; for (let y = y0 - 14; y <= y0 + 14; y++) for (let x = x0 - 56; x <= x0 + 56; x++) { const i = (y * panel.w + x) * 4; if (panel.d[i + 3] > 200 && test(panel.d[i], panel.d[i + 1], panel.d[i + 2])) n++; } return n; };
      const orange = ink(354, 248, (r, g, b) => r > 215 && g < 165 && b < 70), red = ink(355, 449, (r, g, b) => r > 190 && g < 110 && b < 110);
      return { logo: info(logo), start: info(start), panel: info(panel), orange, red };
    });
    ok(titleArt.logo.size.join('x') === '725x348' && titleArt.start.size.join('x') === '549x161' && titleArt.panel.size.join('x') === '666x522', 'タイトルの絵 3 枚が、決めた大きさで読み込める');
    ok([titleArt.logo, titleArt.start, titleArt.panel].every((a) => a.corner === 0 && a.magenta === 0), `タイトルの絵の四隅が透明で、背景の赤紫が残らない (${titleArt.logo.magenta}/${titleArt.start.magenta}/${titleArt.panel.magenta} 画素)`);
    ok(titleArt.orange === 0 && titleArt.red === 0, `絵の中に「ベスト」の文字の跡が無い (橙 ${titleArt.orange} / 赤 ${titleArt.red} 画素。あれば本物の数字と二重に見える)`);

    // 「タップでスタート」: 前回のモードで始まる (記録の無いブラウザは、クラシック)
    const quick = await phone.evaluate(async () => {
      const out = {};
      for (const m of ['adventure', 'classic']) {
        window.__app.showMenu();
        try { localStorage.setItem('suisuiMode', m); } catch (e) { /* ignore */ }
        // 保存したモードを読み直すのは起動時だけなので、ページを開き直さずに「前回」を確かめるため、メニューから選んだ物として扱う
        window.__app.startGame(m); window.__app.showMenu();
        document.getElementById('btnQuick').click();
        out[m] = { mode: window.__app.game().mode, phase: window.__app.game().phase, sheet: document.getElementById('vStart').classList.contains('on') };
      }
      window.__app.showMenu();   // 次の確認がタイトルのボタンを押すので、タイトルに戻しておく
      return out;
    });
    ok(quick.adventure.mode === 'adventure' && quick.classic.mode === 'classic' && !quick.adventure.sheet && quick.adventure.phase === 'ready', '「タップでスタート」で、前回のモードのまま始まり、タイトルが閉じる');

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
    // 折り紙の札: 部品が重ならず、画面 (安全域の下 34pt を除く) に収まる。後ろのゲームが見え、点数は札より濃い
    const sheetInfo = await phone.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const panel = document.querySelector('#vOver .paper-panel').getBoundingClientRect(), rb = r('btnRetry'), mb = r('btnMenu');
      const sc = getComputedStyle(document.getElementById('finalScore')), pn = getComputedStyle(document.querySelector('#vOver .paper-panel'));
      const lum = (c) => { const m = c.match(/\d+(\.\d+)?/g).map(Number); return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255; };
      const sheetBg = getComputedStyle(document.getElementById('vOver')).backgroundColor.match(/[\d.]+/g).map(Number);
      return { gapPB: rb.top - panel.bottom, gapBM: mb.top - rb.bottom, top: panel.top, bottom: mb.bottom, w: panel.width, rbw: rb.width,
               letters: document.querySelectorAll('#overTitle .pl').length, scoreLum: lum(sc.color), sheetA: sheetBg.length > 3 ? sheetBg[3] : 1 };
    });
    ok(sheetInfo.gapPB > 4 && sheetInfo.gapBM > 4, `札とボタンが重ならない (札の下 ${sheetInfo.gapPB.toFixed(0)}pt / ボタンの間 ${sheetInfo.gapBM.toFixed(0)}pt)`);
    ok(sheetInfo.top > 59 && sheetInfo.bottom < 932 - 34, `札とボタンが、安全域をよけて画面に収まる (${sheetInfo.top.toFixed(0)}〜${sheetInfo.bottom.toFixed(0)}pt)`);
    ok(sheetInfo.sheetA <= 0.2, `後ろのゲームが見える (幕の濃さ ${sheetInfo.sheetA})`);
    const scoreDom = await phone.evaluate(() => ({ dg: document.querySelectorAll('#finalScore .dg').length, text: document.getElementById('finalScore').textContent, hidden: document.querySelector('#finalScore .sr-only') !== null }));
    ok(scoreDom.dg === scoreDom.text.length && scoreDom.text.length >= 1 && scoreDom.hidden, `点数は数字の絵が 1 つずつ並び、読み取り用の文字も残る (絵 ${scoreDom.dg} 個・文字 ${scoreDom.text})`);
    ok(sheetInfo.letters === 7, `題字が 1 字ずつの切り紙になっている (${sheetInfo.letters} 字)`);

    // 札の絵の上に、文字が折り目の面ごとに収まる (折り目は上から 46% と 83%)。折り目が文字の真上を通ると読みにくい
    const zones = await phone.evaluate(() => {
      const panel = document.querySelector('#vOver .paper-panel').getBoundingClientRect();
      const rel = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top - panel.top, bottom: r.bottom - panel.top, left: r.left - panel.left, right: r.right - panel.left }; };
      return { h: panel.height, w: panel.width, title: rel('overTitle'), mode: rel('overMode'), score: rel('finalScore'), best: rel('overBest') };
    });
    const c1 = zones.h * 0.46, c2 = zones.h * 0.83;
    ok(zones.title.bottom < c1 - 2 && zones.mode.bottom < c1 - 2, `題字とモード名が、上の折り目 (${c1.toFixed(0)}pt) より上の面に収まる (下端 ${zones.title.bottom.toFixed(0)} / ${zones.mode.bottom.toFixed(0)})`);
    ok(zones.score.top > c1 + 2 && zones.score.bottom < c2 - 2, `点数が、中の面 (${c1.toFixed(0)}〜${c2.toFixed(0)}pt) に収まる (${zones.score.top.toFixed(0)}〜${zones.score.bottom.toFixed(0)})`);
    ok(zones.best.top > c2 - 2 && zones.best.bottom <= zones.h, `ベストが、下の折り返し (${c2.toFixed(0)}pt〜) に収まる (${zones.best.top.toFixed(0)}〜${zones.best.bottom.toFixed(0)})`);
    ok(zones.title.left >= 0 && zones.title.right <= zones.w, `題字が札の幅に収まる (${zones.title.left.toFixed(0)}〜${zones.title.right.toFixed(0)} / ${zones.w.toFixed(0)}pt)`);

    // 札・ボタン・ミュートの絵: 読み込め、四隅が透明で、背景の赤紫が残っていない
    const uiArt = await phone.evaluate(async () => {
      const out = {};
      for (const [k, src] of [['panel', 'assets/panel.webp'], ['retry', 'assets/btn-retry.webp'], ['menu', 'assets/btn-menu.webp'], ['mute', 'assets/btn-mute.webp']]) {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, img.width, img.height).data, A = (xx, yy) => d[(yy * img.width + xx) * 4 + 3];
        let magenta = 0, op = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { op++; if (d[i + 2] > d[i + 1] * 1.5 && d[i] > 120 && d[i + 1] < d[i] * 0.55) magenta++; }
        out[k] = { w: img.width, h: img.height, corner: A(0, 0) + A(img.width - 1, 0) + A(0, img.height - 1) + A(img.width - 1, img.height - 1), magenta, mid: A(img.width >> 1, img.height >> 1) };
      }
      return out;
    });
    ok(uiArt.panel.w === 665 && uiArt.panel.h === 520 && uiArt.retry.w === 546 && uiArt.menu.w === 398 && uiArt.mute.w === 93, '札・ボタン・ミュートの絵が、決めた大きさで読み込める (2 倍の画素)');
    ok(Object.values(uiArt).every((a) => a.corner === 0 && a.magenta === 0 && a.mid === 255), `絵の四隅が透明・中心が不透明・背景の赤紫の名残が無い (赤紫 ${Object.values(uiArt).map((a) => a.magenta).join('/')} 画素)`);

    // 折り紙の数字 (明るい方=ゲーム中の点数、濃い方=札の点数): 絵が読め、背景が残らず、0 の穴が抜けている
    const digitArt = await phone.evaluate(async () => {
      const M = window.__app.digits(), out = {};
      for (const [k, src] of [['light', 'assets/digits-light.webp'], ['dark', 'assets/digits-dark.webp']]) {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, img.width, img.height).data, A = (xx, yy) => d[(yy * img.width + xx) * 4 + 3];
        let magenta = 0, op = 0, lum = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { op++; lum += (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); if (d[i + 2] > d[i + 1] * 1.5 && d[i] > 120 && d[i + 1] < d[i] * 0.55) magenta++; }
        const m = M[k], last = m.x[9] + m.w[9];
        // 各数字の枠が、絵の中に収まり、重ならない
        let fits = last <= img.width && img.height === m.h;
        for (let i = 1; i < 10; i++) if (m.x[i] < m.x[i - 1] + m.w[i - 1]) fits = false;
        // 0 の中 (穴) が透明。8 の中 (2 つの穴のあいだ) は紙
        const zeroHole = A(m.x[0] + (m.w[0] >> 1), m.h >> 1), eightMid = A(m.x[8] + (m.w[8] >> 1), m.h >> 1);
        out[k] = { size: [img.width, img.height], magenta, lum: lum / op, fits, zeroHole, eightMid, corner: A(0, 0) + A(img.width - 1, 0) + A(0, img.height - 1) + A(img.width - 1, img.height - 1) };
      }
      return out;
    });
    ok(digitArt.light.fits && digitArt.dark.fits, '数字の絵の各枠が、絵の中に収まり、重ならない');
    ok(digitArt.light.magenta === 0 && digitArt.dark.magenta === 0 && digitArt.light.corner === 0 && digitArt.dark.corner === 0, `数字の絵に背景の赤紫が残らず、四隅が透明 (赤紫 ${digitArt.light.magenta}/${digitArt.dark.magenta} 画素)`);
    ok(digitArt.light.zeroHole < 30 && digitArt.dark.zeroHole < 30, `0 の穴が抜けている (中心の不透明度 ${digitArt.light.zeroHole}/${digitArt.dark.zeroHole})`);
    ok(digitArt.dark.lum < 90 && digitArt.light.lum > 120 && digitArt.light.lum < 200, `濃い方は札の紙より暗く (明るさ ${digitArt.dark.lum.toFixed(0)})、明るい方は空の上で読める (${digitArt.light.lum.toFixed(0)})`);

    // ------------------------------------------------ 鳥の絵
    section('鳥の絵 (折り紙)');
    await phone.waitForFunction(() => window.__app.birdSpritesReady(), null, { timeout: 5000 }).catch(() => {});
    const sprites = await phone.evaluate(async () => {
      const res = [];
      for (const n of [1, 2, 3]) {
        const img = new Image();
        img.src = 'assets/bird' + n + '.png';
        await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height).data;
        let corner = 0, opaque = 0, magenta = 0, cx = 0, cy = 0, n2 = 0;
        for (let y = 0; y < c.height; y++) for (let xx = 0; xx < c.width; xx++) {
          const i = (y * c.width + xx) * 4, a = d[i + 3];
          if (a > 200) {
            opaque++; cx += xx; cy += y; n2++;
            const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            // 背景のマゼンタの名残 (赤と青が強く、緑が弱い) が残っていない
            if (mx > 120 && (mx - mn) / mx > 0.6 && g < r * 0.55 && b > g * 1.5) magenta++;
          }
        }
        for (const [x0, y0] of [[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1]]) corner += d[(y0 * c.width + x0) * 4 + 3];
        const mid = d[((c.height >> 1) * c.width + (c.width >> 1)) * 4 + 3];
        res.push({ w: img.width, h: img.height, corner, opaque, magenta, mid, gx: cx / n2 / c.width, gy: cy / n2 / c.height });
      }
      return res;
    });
    ok(sprites.every((s) => s.w === 142 && s.h === 124), `鳥の 3 コマが同じ大きさ (142×124。${sprites.map((s) => s.w + 'x' + s.h).join(' / ')})`);
    ok(sprites.every((s) => s.corner === 0), '四隅が透明 (背景が残っていない)');
    ok(sprites.every((s) => s.magenta === 0), `背景のマゼンタが残っていない (${sprites.map((s) => s.magenta).join('/')} 画素)`);
    ok(sprites.every((s) => s.mid === 255), '絵の中心 (体の中心) が不透明 = 当たり判定の丸の中にある');
    ok(await phone.evaluate(() => window.__app.birdSpritesReady()), '絵が読み込まれ、ゲームで使われている');

    // 鳥の絵が実際に画面に出ている (体の黄色が、鳥の位置にある)
    const onScreen = await phone.evaluate(async () => {
      window.__app.startGame('classic');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const g = window.__app.game(), c = document.getElementById('game'), k = c.width / 430;
      const d = c.getContext('2d').getImageData(Math.round((110 - 14) * k), Math.round((g.birdY - 14) * k), Math.round(28 * k), Math.round(28 * k)).data;
      let y = 0, tot = 0;
      for (let i = 0; i < d.length; i += 4) { tot++; if (d[i] > 200 && d[i + 1] > 160 && d[i + 2] < 140) y++; }
      return y / tot;
    });
    ok(onScreen > 0.5, `鳥の位置に体の黄色が描かれている (${(onScreen * 100).toFixed(0)}%)`);

    // ------------------------------------------------ 柱と床の絵
    section('柱と床の絵 (折り紙)');
    await phone.waitForFunction(() => window.__app.pipeSpritesReady() && window.__app.groundArtReady(), null, { timeout: 5000 }).catch(() => {});
    ok(await phone.evaluate(() => window.__app.pipeSpritesReady() && window.__app.groundArtReady()), '柱と床の絵が読み込まれ、ゲームで使われている');
    const artInfo = await phone.evaluate(async () => {
      const load = async (src) => {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        return { w: img.width, h: img.height, d: x.getImageData(0, 0, img.width, img.height).data };
      };
      const A = (im, x, y) => im.d[(y * im.w + x) * 4 + 3];
      const isMagenta = (r, g, b) => b > g * 1.5 && r > 120 && g < r * 0.55;
      const body = await load('assets/pipe-body.png');
      const capT = await load('assets/pipe-cap-top.png'), capB = await load('assets/pipe-cap-bottom.png');
      const ground = await load('assets/ground.jpg');
      const capInfo = (im) => {
        let first = -1, last = -1, magenta = 0, minX = im.w, maxX = -1;
        for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
          const i = (y * im.w + x) * 4;
          if (im.d[i + 3] > 128) {
            if (first < 0) first = y;
            last = y; minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          }
          if (im.d[i + 3] > 200 && isMagenta(im.d[i], im.d[i + 1], im.d[i + 2])) magenta++;
        }
        return { w: im.w, h: im.h, first, last, magenta, vis: maxX - minX + 1,
                 corner: A(im, 0, 0) + A(im, im.w - 1, 0) + A(im, 0, im.h - 1) + A(im, im.w - 1, im.h - 1) };
      };
      // 胴: 全面が不透明、上端と下端の色の差 (繋ぎ目)
      let bodyOpaque = true;
      for (let y = 0; y < body.h; y += 5) for (let x = 0; x < body.w; x++) if (A(body, x, y) < 250) bodyOpaque = false;
      const rowMean = (im, y) => { const m = [0, 0, 0]; for (let x = 0; x < im.w; x++) for (let k = 0; k < 3; k++) m[k] += im.d[(y * im.w + x) * 4 + k]; return m.map((v) => v / im.w); };
      const dist = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
      const seamBody = dist(rowMean(body, 0), rowMean(body, body.h - 1));
      // 床: 左端の列と右端の列の差 (鏡のように繋いである = 同じ列) と、となり合う列の差
      const colMean = (im, x) => { const m = [0, 0, 0]; for (let y = 0; y < im.h; y++) for (let k = 0; k < 3; k++) m[k] += im.d[(y * im.w + x) * 4 + k]; return m.map((v) => v / im.h); };
      let adj = 0; for (let x = 0; x < 200; x++) adj += dist(colMean(ground, x), colMean(ground, x + 1)); adj /= 200;
      const seamGround = dist(colMean(ground, 0), colMean(ground, ground.w - 1));
      let gMagenta = 0, gGreen = 0, gn = 0;
      for (let i = 0; i < ground.d.length; i += 4 * 13) { gn++; if (isMagenta(ground.d[i], ground.d[i + 1], ground.d[i + 2])) gMagenta++; if (ground.d[i + 1] > ground.d[i] + 15) gGreen++; }
      return { body: [body.w, body.h], bodyOpaque, seamBody, capT: capInfo(capT), capB: capInfo(capB),
               ground: [ground.w, ground.h], seamGround, adj, gMagenta, gGreenRate: gGreen / gn };
    });
    ok(artInfo.body[0] === 112 && artInfo.bodyOpaque, `胴は幅 112 で、全面が不透明 (${artInfo.body.join('x')})`);
    ok(artInfo.capT.corner === 0 && artInfo.capB.corner === 0, '口の四隅が透明 (背景が残っていない)');
    ok(artInfo.capT.magenta === 0 && artInfo.capB.magenta === 0, `口にマゼンタの名残が無い (${artInfo.capT.magenta}/${artInfo.capB.magenta} 画素)`);
    ok(artInfo.capB.first <= 2 && artInfo.capT.h - 1 - artInfo.capT.last <= 2,
      `口の絵の縁が、当たりの縁に合う余白で切ってある (下の口の上 ${artInfo.capB.first}px / 上の口の下 ${artInfo.capT.h - 1 - artInfo.capT.last}px)`);
    ok(artInfo.capT.vis / 112 > 1.1 && artInfo.capT.vis / 112 < 1.45 && artInfo.capB.vis / 112 > 1.1 && artInfo.capB.vis / 112 < 1.45,
      `口は胴より少し広い (口 ${artInfo.capT.vis}/${artInfo.capB.vis}px ÷ 胴 112px)`);
    ok(artInfo.seamBody <= 24, `胴を縦に繋いだ継ぎ目の色の差が小さい (${artInfo.seamBody.toFixed(1)})`);
    ok(artInfo.ground[0] === 800 && artInfo.ground[1] === 180, `床の絵は 800×180 (${artInfo.ground.join('x')})`);
    ok(artInfo.seamGround <= Math.max(6, artInfo.adj * 2), `床を横に繋いだ継ぎ目が出ない (端の列の差 ${artInfo.seamGround.toFixed(1)} / となり合う列 ${artInfo.adj.toFixed(1)})`);
    ok(artInfo.gMagenta === 0 && artInfo.gGreenRate > 0.8, `床にマゼンタの名残が無く、緑で埋まっている (緑 ${(artInfo.gGreenRate * 100).toFixed(0)}%)`);

    // ミュートボタン: 押すと切り替わり、絵 (紙の八角形) は残る。切ってあるときは印が付く
    const mute = await phone.evaluate(() => {
      const b = document.getElementById('btnMute'), bg = () => getComputedStyle(b).backgroundImage;
      const before = { off: b.classList.contains('off'), bg: bg().includes('btn-mute') };
      b.click();
      const after = { off: b.classList.contains('off'), bg: bg().includes('btn-mute'), slash: getComputedStyle(b, '::after').content };
      b.click();
      return { before, after, back: b.classList.contains('off'), pressed: b.getAttribute('aria-pressed') };
    });
    ok(mute.before.bg && mute.after.bg, 'ミュートボタンの絵が、切り替えても残る');
    ok(mute.before.off !== mute.after.off && mute.back === mute.before.off, 'ミュートボタンを押すと切り替わり、もう一度押すと戻る');
    ok(mute.after.slash !== 'none' && mute.after.slash !== 'normal', '切ってあるときは、斜めの帯の印が付く');

    // 床の絵を並べた継ぎ目に隙間が出ない。流れる位置をいくつも変えて、床の行が端から端まで不透明か見る
    // (キャンバスは床の外が透明なので、隙間があれば alpha が 0 になる)
    const groundGap = await phone.evaluate(() => {
      window.__app.startGame('classic');
      const g = window.__app.game(), c = document.getElementById('game'), x = c.getContext('2d');
      const k = c.width / 430, worst = { gaps: 0, at: -1 };
      for (const off of [0, 1.7, 77, 199.5, 319, 399.9, 400, 401.3, 1234.5]) {
        g.groundOffset = off; window.__app.render();
        for (const yy of [850, 870, 900, 925]) {
          const d = x.getImageData(0, Math.round(yy * k), c.width, 1).data;
          let gaps = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 255) gaps++;
          if (gaps > worst.gaps) { worst.gaps = gaps; worst.at = off; }
        }
      }
      return worst;
    });
    ok(groundGap.gaps === 0, `床の絵の継ぎ目に隙間が出ない (透けた画素 ${groundGap.gaps}${groundGap.gaps ? '、位置 ' + groundGap.at : ''})`);

    // ゲーム中の点数: 紙の数字 (タン色) が、画面の上の中央に出る。1 桁でも 2 桁でも中央にそろう
    const hud = await phone.evaluate(async () => {
      const res = {};
      for (const sc of [0, 7, 23, 108]) {
        window.__app.startGame('classic');
        const g = window.__app.game(); g.score = sc; g.phase = 'play'; g.birdY = 700; g.vy = 0;
        window.__app.render();
        const c = document.getElementById('game'), k = c.width / 430, x = c.getContext('2d');
        const y0 = 59, y1 = 130;
        const d = x.getImageData(0, Math.round(y0 * k), c.width, Math.round((y1 - y0) * k)).data;
        let n = 0, sx = 0, minX = c.width, maxX = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 200 && d[i] - d[i + 2] > 55 && d[i] > 120) {     // タン色 (空の青より赤が強い)
            const px = (i / 4) % c.width; n++; sx += px; minX = Math.min(minX, px); maxX = Math.max(maxX, px);
          }
        }
        res[sc] = { n, cx: n ? sx / n / k : -1, w: (maxX - minX) / k };
      }
      return res;
    });
    ok(hud[0].n > 400 && hud[7].n > 400, `ゲーム中の点数が、紙の数字で出ている (0 点 ${hud[0].n} 画素 / 7 点 ${hud[7].n} 画素)`);
    ok(Object.values(hud).every((h) => Math.abs(h.cx - 215) <= 8), `1 桁・2 桁・3 桁とも、画面の中央にそろう (中心 ${Object.values(hud).map((h) => h.cx.toFixed(0)).join('/')}pt)`);
    ok(hud[108].w > hud[23].w && hud[23].w > hud[7].w, `桁が増えると幅が広がる (${hud[7].w.toFixed(0)} < ${hud[23].w.toFixed(0)} < ${hud[108].w.toFixed(0)}pt)`);

    // 画面に出た柱と床。当たりの縁と同じ位置に見えるか、夜は沈むか
    const scene = await phone.evaluate(async () => {
      const shoot = async (score, groundOffset) => {
        window.__app.startGame('classic');
        const g = window.__app.game();
        g.phase = 'play'; g.score = score; g.groundOffset = groundOffset || 0;
        g.pipes.push({ x: 200, top: 300, gap: 180, scored: false });
        g.birdY = 700; g.vy = 0;
        window.__app.render();
        const c = document.getElementById('game'), k = c.width / 430, x = c.getContext('2d');
        const px = (xx, yy) => x.getImageData(Math.round(xx * k), Math.round(yy * k), 1, 1).data;
        const orange = (d) => d[0] - d[2] > 40;   // 空は青が強い。橙〜暗い橙は赤が強い
        // 下の柱: 縁 480pt の少し上から下へ見て、最初に橙が出る所
        let botEdge = -1; for (let y = 450; y < 520; y += 0.5) if (orange(px(228, y))) { botEdge = y; break; }
        // 上の柱: 縁 300pt の少し下から上へ見て、最初に橙が出る所
        let topEdge = -1; for (let y = 330; y > 270; y -= 0.5) if (orange(px(228, y))) { topEdge = y; break; }
        const d = x.getImageData(Math.round(210 * k), Math.round(600 * k), Math.round(30 * k), Math.round(30 * k)).data;
        let s = 0, n = 0; for (let i = 0; i < d.length; i += 4) { s += d[i] + d[i + 1] + d[i + 2]; n++; }
        const gd = px(100, 880);
        return { botEdge, topEdge, lum: s / n / 3, ground: [gd[0], gd[1], gd[2]] };
      };
      const day = await shoot(0), deep = await shoot(35);
      return { day, deep };
    });
    ok(Math.abs(scene.day.botEdge - 480) <= 2, `下の柱の口の縁が、当たりの縁 (480pt) に見える (${scene.day.botEdge}pt)`);
    ok(Math.abs(scene.day.topEdge - 300) <= 2, `上の柱の口の縁が、当たりの縁 (300pt) に見える (${scene.day.topEdge}pt)`);
    ok(scene.deep.lum < scene.day.lum * 0.8, `夜は柱が沈んで暗い (朝 ${scene.day.lum.toFixed(0)} → 夜 ${scene.deep.lum.toFixed(0)})`);
    ok(scene.day.ground[1] > scene.day.ground[0] + 20 && scene.day.ground[1] > scene.day.ground[2] + 20, `床が緑で描かれている (${scene.day.ground.join(',')})`);

    // ------------------------------------------------ 空と雲の絵
    section('空と雲の絵 (折り紙)');
    await phone.waitForFunction(() => window.__app.cloudArtReady(), null, { timeout: 5000 }).catch(() => {});
    ok(await phone.evaluate(() => window.__app.cloudArtReady()), '雲の絵 4 枚が読み込まれ、ゲームで使われている');
    const skyArt = await phone.evaluate(async () => {
      const load = async (src) => {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        return { w: img.width, h: img.height, d: x.getImageData(0, 0, img.width, img.height).data };
      };
      const clouds = [];
      for (const n of [1, 2, 3, 4]) {
        const im = await load('assets/cloud' + n + '.png');
        let corner = 0, magenta = 0, rg = 0, op = 0, lum = 0;
        for (const [x, y] of [[0, 0], [im.w - 1, 0], [0, im.h - 1], [im.w - 1, im.h - 1]]) corner += im.d[(y * im.w + x) * 4 + 3];
        for (let i = 0; i < im.d.length; i += 4) if (im.d[i + 3] > 200) {
          op++; rg += im.d[i] - im.d[i + 1]; lum += (im.d[i] + im.d[i + 1] + im.d[i + 2]) / 3;
          if (im.d[i + 2] > im.d[i + 1] * 1.5 && im.d[i] > 120 && im.d[i + 1] < im.d[i] * 0.55) magenta++;
        }
        clouds.push({ w: im.w, h: im.h, corner, magenta, pink: rg / op, lum: lum / op, op });
      }
      const sp = await load('assets/sky-paper.jpg');
      let mean = 0, sq = 0, gray = true, n = 0;
      for (let i = 0; i < sp.d.length; i += 4 * 11) {
        const v = sp.d[i]; mean += v; sq += v * v; n++;
        if (Math.abs(sp.d[i] - sp.d[i + 1]) > 2 || Math.abs(sp.d[i] - sp.d[i + 2]) > 2) gray = false;
      }
      mean /= n;
      return { clouds, sky: [sp.w, sp.h], mean, std: Math.sqrt(sq / n - mean * mean), gray };
    });
    ok(skyArt.clouds.every((c) => c.corner === 0), '雲の四隅が透明 (背景が残っていない)');
    ok(skyArt.clouds.every((c) => c.magenta === 0), `雲にマゼンタの名残が無い (${skyArt.clouds.map((c) => c.magenta).join('/')} 画素)`);
    ok(skyArt.clouds.every((c) => c.pink < 8 && c.lum > 170), `雲が桃色に寄らず、明るい白 (赤−緑 ${skyArt.clouds.map((c) => c.pink.toFixed(1)).join('/')}、明るさ ${skyArt.clouds.map((c) => c.lum.toFixed(0)).join('/')})`);
    ok(skyArt.sky[0] === 538 && skyArt.sky[1] === 1053 && skyArt.gray, `紙の絵は灰色で 538×1053 (${skyArt.sky.join('x')})`);
    ok(Math.abs(skyArt.mean - 128) <= 6 && skyArt.std >= 3 && skyArt.std <= 12, `紙の絵は、中間の灰色 128 まわりで折り目と粒だけを持つ (平均 ${skyArt.mean.toFixed(0)}、ばらつき ${skyArt.std.toFixed(1)})`);

    // 画面に出た空 (スクリーンショットの画素を読む。値ではなく見えている色)
    const skyAt = async (score) => {
      await phone.evaluate((sc) => { window.__app.startGame('classic'); const g = window.__app.game(); g.score = sc; g.phase = 'ready'; window.__app.render(); }, score);
      await phone.waitForTimeout(150);
      const shot = (await phone.screenshot()).toString('base64');
      return phone.evaluate(async (b64) => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const k = img.width / 430;
        const d = x.getImageData(Math.round(20 * k), Math.round(200 * k), Math.round(60 * k), Math.round(40 * k)).data;
        let r = 0, g = 0, b = 0, n = 0, lo = 255, hi = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; const l = (d[i] + d[i + 1] + d[i + 2]) / 3; lo = Math.min(lo, l); hi = Math.max(hi, l); }
        return { r: r / n, g: g / n, b: b / n, spread: hi - lo };
      }, shot);
    };
    const dayPx = await skyAt(0), nightPx = await skyAt(35);
    ok(dayPx.b > dayPx.r + 60 && dayPx.b > 180, `朝の空が紙の青で見えている (${dayPx.r.toFixed(0)},${dayPx.g.toFixed(0)},${dayPx.b.toFixed(0)})`);
    ok(nightPx.b < 130 && nightPx.r < 60, `夜の空は暗い紺で見えている (${nightPx.r.toFixed(0)},${nightPx.g.toFixed(0)},${nightPx.b.toFixed(0)})`);
    ok(dayPx.spread >= 6 || nightPx.spread >= 4, `空に紙の粒・折り目の濃淡が出ている (朝の幅 ${dayPx.spread.toFixed(0)} / 夜 ${nightPx.spread.toFixed(0)})`);
    const skyEls = await phone.evaluate(() => {
      const p = document.getElementById('skyPaper'), s = document.getElementById('sky'), r = p.getBoundingClientRect();
      return { blend: getComputedStyle(p).mixBlendMode, w: Math.round(r.width), h: Math.round(r.height), bg: getComputedStyle(s).backgroundImage.startsWith('linear-gradient'), loaded: p.complete && p.naturalWidth > 0 };
    });
    ok(skyEls.blend === 'overlay' && skyEls.w === 430 && skyEls.h === 842 && skyEls.bg && skyEls.loaded, `空は CSS のグラデーションに、紙の絵を重ね合わせで載せている (${skyEls.blend}、${skyEls.w}x${skyEls.h})`);

    // ------------------------------------------------ アイテムと残りハートの絵
    section('アイテムと残りハートの絵 (折り紙)');
    await phone.waitForFunction(() => window.__app.itemArtReady(), null, { timeout: 5000 }).catch(() => {});
    ok(await phone.evaluate(() => window.__app.itemArtReady()), 'アイテム 3 種と残りハートの絵が読み込まれ、ゲームで使われている');
    const itemArt = await phone.evaluate(async () => {
      const out = {};
      for (const [k, src, size] of [['star', 'assets/item-star.webp', 80], ['slow', 'assets/item-slow.webp', 80], ['heart', 'assets/item-heart.webp', 80], ['hud', 'assets/hud-heart.webp', 52], ['off', 'assets/hud-heart-off.webp', 52]]) {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, img.width, img.height).data;
        let r = 0, g = 0, b = 0, n = 0, magenta = 0, sat = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 100) {     // 足りないハートは半透明 (不透明度 0.6) に作ってあるので、半透明も数える
          n++; r += d[i]; g += d[i + 1]; b += d[i + 2]; sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
          if (d[i + 2] > d[i + 1] * 1.6 && d[i] > 150 && d[i + 1] < d[i] * 0.45) magenta++;
        }
        const A = (xx, yy) => d[(yy * img.width + xx) * 4 + 3];
        out[k] = { size: [img.width, img.height], want: size, n, r: r / n, g: g / n, b: b / n, magenta, sat: sat / n, corner: A(0, 0) + A(img.width - 1, 0) + A(0, img.height - 1) + A(img.width - 1, img.height - 1), mid: A(img.width >> 1, img.height >> 1) };
      }
      return out;
    });
    ok(Object.values(itemArt).every((a) => a.size[0] === a.want && a.size[1] === a.want), 'アイテムと残りハートの絵が、決めた大きさ (80 / 52 の正方形)');
    ok(Object.values(itemArt).every((a) => a.corner === 0 && a.magenta === 0), `四隅が透明で、背景の赤紫が残らない (${Object.values(itemArt).map((a) => a.magenta).join('/')} 画素)`);
    ok(itemArt.star.r > itemArt.star.b + 60 && itemArt.star.g > itemArt.star.b + 30, '星は金色');
    ok(itemArt.heart.r > itemArt.heart.g + 50 && itemArt.hud.r > itemArt.hud.g + 50, 'ハートは赤');
    ok(itemArt.slow.g > itemArt.slow.b + 20, '亀は緑 (甲羅の茶を含む)');
    ok(itemArt.off.sat < itemArt.hud.sat * 0.4, `足りないハートは、同じ絵の色を落としたもの (色の濃さ ${itemArt.off.sat.toFixed(0)} < ${(itemArt.hud.sat * 0.4).toFixed(0)})`);

    // 画面に出たアイテム (キャンバスは動く物だけ。各アイテムの枠に、その色の絵が描かれているか) と、残りハート・効果の印
    const itemScene = await phone.evaluate(async () => {
      window.__app.startGame('adventure');
      const g = window.__app.game();
      g.phase = 'play'; g.score = 3; g.hearts = 2; g.play = 10; g.starUntil = 120; g.slowUntil = 90; g.birdY = 800; g.vy = 0;
      g.items = [{ x: 300, y: 330, type: 'star' }, { x: 300, y: 450, type: 'slow' }, { x: 300, y: 570, type: 'heart' }];
      g.pipes = [];
      window.__app.render();
      const c = document.getElementById('game'), k = c.width / 430, x = c.getContext('2d');
      const region = (cx, cy, half, thr = 200) => {
        const d = x.getImageData(Math.round((cx - half) * k), Math.round((cy - half) * k), Math.round(half * 2 * k), Math.round(half * 2 * k)).data;
        let n = 0, r = 0, gg = 0, b = 0, tot = 0;
        for (let i = 0; i < d.length; i += 4) { tot++; if (d[i + 3] > thr) { n++; r += d[i]; gg += d[i + 1]; b += d[i + 2]; } }
        return { cover: n / tot, r: n ? r / n : 0, g: n ? gg / n : 0, b: n ? b / n : 0 };
      };
      // 絵が無いときの白い丸の縁 (半径 14pt) が、まだ描かれていない: 枠の四隅 (絵の外) に不透明な画素が無い
      const corner = (cx, cy) => region(cx - 17, cy - 17, 3).cover;
      const res = { star: region(300, 330, 14), slow: region(300, 450, 14), heart: region(300, 570, 14),
                    badge: Math.max(corner(300, 330), corner(300, 450), corner(300, 570)),
                    h0: region(14 + 13, 59 + 8 + 13, 10), h1: region(14 + 30 + 13, 59 + 8 + 13, 10), h2: region(14 + 60 + 13, 59 + 8 + 13, 10, 100),
                    fxStar: region(24, 59 + 50, 11), fxSlow: region(24, 59 + 80, 11) };
      return res;
    });
    ok(itemScene.star.cover > 0.25 && itemScene.star.r > itemScene.star.b + 60, `星が金色の絵で描かれている (被り ${(itemScene.star.cover * 100).toFixed(0)}%)`);
    ok(itemScene.slow.cover > 0.2 && itemScene.slow.g > itemScene.slow.b + 20, `亀が緑の絵で描かれている (被り ${(itemScene.slow.cover * 100).toFixed(0)}%)`);
    ok(itemScene.heart.cover > 0.25 && itemScene.heart.r > itemScene.heart.g + 50, `ハートが赤の絵で描かれている (被り ${(itemScene.heart.cover * 100).toFixed(0)}%)`);
    ok(itemScene.badge === 0, '絵のときは、白い丸の縁が描かれない');
    ok(itemScene.h0.r > itemScene.h0.g + 50 && itemScene.h1.r > itemScene.h1.g + 50, '残りハート (2 つ) が赤い折り紙で出ている');
    ok(itemScene.h2.cover > 0.15 && itemScene.h2.r < itemScene.h2.g + 30, '足りない 1 つは、色を落とした薄いハート');
    ok(itemScene.fxStar.cover > 0.2 && itemScene.fxSlow.cover > 0.2, `効果の印 (星・亀) が重ならずに並ぶ (被り ${(itemScene.fxStar.cover * 100).toFixed(0)}% / ${(itemScene.fxSlow.cover * 100).toFixed(0)}%)`);

    // ------------------------------------------------ 自動操縦で実際に遊ぶ
    section('自動操縦で遊ぶ (実際のタップ操作で 15 点)');
    await phone.evaluate(() => window.__app.startGame('classic'));
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
    // 機械ごとに速さが違う (同じ版が 50fps の日も 35fps の日もある)。絶対値だけで線を引かず、
    // 同じ実行の中で「絵を止めた版」と交互に測り、絵を足したぶんの落ち込みを割合で見る
    section('遅い端末');
    const measureFps = async (pg) => {
      await pg.bringToFront();
      return pg.evaluate(async () => {
        window.__app.startGame('adventure');
        window.__app.step(1);
        const g = window.__app.game();
        g.phase = 'play'; g.score = 45; g.hearts = 99; g.hurtUntil = 1e9; g.starUntil = 1e9;   // 夜空・オーロラ・星の最も重い絵
        for (let i = 0; i < 400; i++) { g.birdY = 440; g.vy = 0; window.__app.step(1); }      // 柱が何本も出ている
        let frames = 0;
        const t0 = performance.now();
        await new Promise((resolve) => {
          const tick = () => { frames++; if (performance.now() - t0 >= 2500) resolve(); else requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        });
        return frames / 2.5;
      });
    };
    const plainCtx = await browser.newContext(PHONE);
    const plain = await plainCtx.newPage();
    await plain.route('**/assets/*', (route) => route.abort());     // 絵を読ませない = これまでの描き方
    plain.on('pageerror', (e) => errors.push('絵なし: ' + e.message));
    await plain.goto(URL);
    await plain.waitForFunction(() => window.__app);
    ok(await plain.evaluate(() => { window.__app.startGame('classic'); window.__app.game().score = 12; window.__app.game().phase = 'play'; window.__app.render(); return !window.__app.digitsArtReady(); }), '絵が読めなくても、点数は文字で出る (エラーなし)');
    ok(await plain.evaluate(() => { window.__app.startGame('adventure'); const g = window.__app.game(); g.phase = 'play'; g.hearts = 2; g.starUntil = g.slowUntil = 100; g.items = [{ x: 300, y: 330, type: 'star' }, { x: 300, y: 450, type: 'slow' }, { x: 300, y: 570, type: 'heart' }]; window.__app.render(); return !window.__app.itemArtReady(); }), '絵が読めなくても、アイテム・残りハート・効果の印は元の描き方で出る (エラーなし)');
    await phone.reload();
    await phone.waitForFunction(() => window.__app.pipeSpritesReady() && window.__app.groundArtReady() && window.__app.birdSpritesReady());
    const cdpA = await context.newCDPSession(phone), cdpB = await plainCtx.newCDPSession(plain);
    await cdpA.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdpB.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const withArt = [], without = [];
    for (let i = 0; i < 4; i++) { withArt.push(await measureFps(phone)); without.push(await measureFps(plain)); }
    await cdpA.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdpB.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await plainCtx.close();
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const fa = med(withArt), fb = med(without);
    // 実測 (同じ実行で交互に): 絵あり ÷ 絵なし = 0.81〜0.94 (平均 0.88)。線はその下の 0.75
    ok(fa >= 0.75 * fb, `絵を足しても、絵なしの 75% 以上の速さ (絵あり ${fa.toFixed(0)}fps / 絵なし ${fb.toFixed(0)}fps。${withArt.map((v) => v.toFixed(0)).join('/')} 対 ${without.map((v) => v.toFixed(0)).join('/')})`);
    ok(fa >= 25, `CPU 4 倍遅で 25fps 以上 (${fa.toFixed(0)}fps)`);

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
    ok(await oldPage.evaluate(() => document.getElementById('btnMute').classList.contains('off')), 'ミュートの記憶が効いている (切ってある印が付いている)');
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

    // ------------------------------------------------ 見えている高さが足りないとき (Safari の帯・アプリ内の枠)
    section('画面に合わせる');
    for (const [vw, vh] of [[430, 932], [430, 873], [430, 799]]) {
      const fc = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      const fp = await fc.newPage();
      await fp.goto(URL);
      await fp.waitForFunction(() => window.__app);
      await fp.waitForTimeout(300);
      const r = await fp.evaluate(() => {
        const a = document.getElementById('app').getBoundingClientRect();
        const c = document.getElementById('game').getBoundingClientRect();
        return { top: a.top, bottom: a.bottom, left: a.left, right: a.right, cb: c.bottom, scale: +document.getElementById('app').dataset.scale };
      });
      ok(r.bottom <= vh + 0.5 && r.top >= -0.5, `${vw}x${vh}: 床まで画面に収まる (舞台 ${Math.round(r.top)}〜${Math.round(r.bottom)})`);
      ok(r.right <= vw + 0.5 && r.left >= -0.5, `${vw}x${vh}: 横にはみ出さない (${Math.round(r.left)}〜${Math.round(r.right)})`);
      ok(Math.abs(r.scale - Math.min(vw / 430, vh / 932)) < 0.002, `${vw}x${vh}: 縦横の比そのままで拡縮 (${r.scale})`);
      await fc.close();
    }
    // ホーム画面から開いたとき (standalone) は、窓が足りなくても 100vh まで使う。ここでは窓 = 100vh なので、拡縮は窓どおりのまま
    {
      const sc = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      await sc.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { get: () => true }); });
      const sp = await sc.newPage();
      await sp.goto(URL);
      await sp.waitForFunction(() => window.__app);
      await sp.waitForTimeout(300);
      const k = await sp.evaluate(() => +document.getElementById('app').dataset.scale);
      ok(Math.abs(k - 1) < 0.002, `ホーム画面 (standalone) の 430x932 は 1 倍 (${k})`);
      await sc.close();
    }

    // ホーム画面から開いたときに全画面になる指定 (無いと状態バーの下から始まり、下の 59pt が切れる)
    {
      const mp = await browser.newPage();
      await mp.goto(URL);
      const m = await mp.evaluate(() => ({
        bar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content,
        cap: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content,
        vp: document.querySelector('meta[name="viewport"]')?.content || '',
      }));
      ok(m.cap === 'yes' && m.bar === 'black-translucent', `ホーム画面から全画面で開く指定 (capable ${m.cap} / status-bar-style ${m.bar})`);
      ok(/viewport-fit=cover/.test(m.vp), '安全域を読むための viewport-fit=cover');
      await mp.close();
    }

    // ------------------------------------------------ 夜・星空・オーロラの空の絵
    section('空の絵 (朝〜オーロラ)');
    {
      const nc = await browser.newContext(PHONE);
      const np = await nc.newPage();
      await np.goto(URL);
      await np.waitForFunction(() => window.__app);
      await np.locator('#btnAdventure').tap();
      // 切り替わりは CSS で 0.6 秒かけて動くので、目標の値 (style.opacity) を読む
      const ops = (sc) => np.evaluate((sc) => { const g = window.__app.game(); g.phase = 'play'; g.score = sc; g.pipes.length = 0; g.items.length = 0; window.__app.render();
        return ['skyMorning', 'skyNoon', 'skySunset', 'skyDusk', 'skyNight', 'skyStarry', 'skyAurora'].map((id) => +document.getElementById(id).style.opacity); }, sc);
      const arts = await np.evaluate(async () => {
        const out = {};
        for (const id of ['skyMorning', 'skyNoon', 'skySunset', 'skyDusk', 'skyNight', 'skyStarry', 'skyAurora']) {
          const im = document.getElementById(id); await im.decode();
          const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
          const g = c.getContext('2d'); g.drawImage(im, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let gold = 0, green = 0, lum = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] > 200 && d[i + 1] > 150 && d[i + 2] < 120) gold++;
            if (d[i + 1] > 140 && d[i + 1] > d[i] + 40 && d[i + 1] > d[i + 2] + 10) green++;   // オーロラの緑 (青緑の空や海は、青の方が強いので入らない)
            lum += (d[i] + d[i + 1] + d[i + 2]) / 3;
          }
          // 金色の塊の大きさ: 月 (いちばん大きい塊と、そのまわり。陰の所は別の塊に割れる) 以外の星が、アイテムの星 (40pt) と見分けがつくくらい小さいか
          const W = c.width, H = c.height, seen = new Uint8Array(W * H), blobs = [];
          const isGold = (i) => d[i * 4] > 170 && d[i * 4 + 1] > 120 && d[i * 4 + 2] < 140 && d[i * 4] > d[i * 4 + 2] + 60;
          for (let p0 = 0; p0 < W * H; p0++) {
            if (seen[p0] || !isGold(p0)) continue;
            let x0 = W, x1 = 0, y0 = H, y1 = 0, area = 0; const st = [p0]; seen[p0] = 1;
            while (st.length) { const p = st.pop(), x = p % W, y = (p / W) | 0; area++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
              for (const q of [p - 1, p + 1, p - W, p + W]) if (q >= 0 && q < W * H && !seen[q] && isGold(q)) { seen[q] = 1; st.push(q); } }
            blobs.push({ x0, x1, y0, y1, area, size: Math.max(x1 - x0, y1 - y0) + 1 });
          }
          const moon = blobs.reduce((m, b) => (b.area > m.area ? b : m), { area: 0, x0: 0, x1: -1, y0: 0, y1: -1 });
          const nearMoon = (b) => b.x1 >= moon.x0 - 14 && b.x0 <= moon.x1 + 14 && b.y1 >= moon.y0 - 14 && b.y0 <= moon.y1 + 14;
          const big = Math.max(0, ...blobs.filter((b) => b !== moon && !nearMoon(b)).map((b) => b.size));
          out[id] = { w: c.width, h: c.height, gold, green, big, lum: lum / (d.length / 4) };
        }
        return out;
      });
      const ids5 = ['skyMorning', 'skyNoon', 'skySunset', 'skyDusk', 'skyNight', 'skyStarry', 'skyAurora'];
      for (const id of ids5) ok(arts[id].w === 538 && arts[id].h === 1053, `${id} は 538x1053 (${arts[id].w}x${arts[id].h})`);
      ok(arts.skyNight.gold > 300 && arts.skyStarry.gold > 300, `夜と星空の絵に金の星が写っている (${arts.skyNight.gold} / ${arts.skyStarry.gold} 画素)`);
      const others = ids5.filter((i) => i !== 'skyAurora').map((i) => arts[i].green);
      ok(arts.skyAurora.green > 20000 && arts.skyAurora.green > 2.5 * Math.max(...others), `緑が多いのはオーロラの絵 (${arts.skyAurora.green} 画素 / 他 ${others.join(',')})`);
      const bigs = ['skyNight', 'skyStarry', 'skyAurora'].map((i) => arts[i].big);
      ok(bigs.every((v) => v <= 24), `背景の星は小さい (金色の星の最大 ${bigs.join(' / ')} 画素。538 幅で 24 画素 = 19pt 以下。アイテムの星は 40pt)`);
      ok(arts.skyNight.lum < 110 && arts.skyStarry.lum < 110 && arts.skyAurora.lum < 110 && arts.skyDusk.lum < 120, `夜の 4 枚は暗い (明るさ ${['skyDusk', 'skyNight', 'skyStarry', 'skyAurora'].map((i) => arts[i].lum.toFixed(0)).join(' / ')})`);
      ok(arts.skyMorning.lum > 90 && arts.skyNoon.lum > 90, `朝と昼は明るい (${arts.skyMorning.lum.toFixed(0)} / ${arts.skyNoon.lum.toFixed(0)})`);
      ok(arts.skyNoon.lum > arts.skySunset.lum && arts.skySunset.lum > arts.skyDusk.lum && arts.skyDusk.lum > arts.skyNight.lum - 5, `明るさは 昼 > 夕方 > 夕方から夜 > 夜 の順に落ちる (${['skyNoon', 'skySunset', 'skyDusk', 'skyNight'].map((i) => arts[i].lum.toFixed(0)).join(' / ')})`);
      const o = {}; for (const sc of [0, 9, 10, 19, 20, 25, 29, 30, 39, 40, 49, 50, 70]) o[sc] = await ops(sc);
      ok(o[0].join() === '1,0,0,0,0,0,0' && o[9].join() === '1,0,0,0,0,0,0', `0〜9 点は朝の絵 (${o[0]} / ${o[9]})`);
      ok(o[10].join() === '1,1,0,0,0,0,0' && o[19].join() === '1,1,0,0,0,0,0', `10〜19 点は昼の絵 (${o[10]} / ${o[19]})`);
      ok(o[20].join() === '1,1,1,0,0,0,0', `20 点は夕方の絵 (${o[20]})`);
      ok(o[25][3] > 0.3 && o[25][3] < 0.7 && o[25][4] === 0, `25 点は夕方から夜の絵が途中 (${o[25]})`);
      ok(o[30].join() === '1,1,1,1,1,0,0' && o[39].join() === '1,1,1,1,1,0,0', `30〜39 点は夜の絵 (${o[30]} / ${o[39]})`);
      ok(o[40].join() === '1,1,1,1,1,1,0' && o[49].join() === '1,1,1,1,1,1,0', `40〜49 点は星空の絵 (${o[40]} / ${o[49]})`);
      ok(o[50].every((v) => v === 1) && o[70].every((v) => v === 1), `50 点からオーロラの絵まで全部 (${o[50]})`);
      // 月が二つ重なって見える時間は短い: 重ね合わせは 0.6 秒以内
      const tr = await np.evaluate(() => { const cs = getComputedStyle(document.getElementById('skyStarry')); return { dur: cs.transitionDuration, prop: cs.transitionProperty }; });
      ok(tr.prop === 'opacity' && parseFloat(tr.dur) > 0 && parseFloat(tr.dur) <= 0.7, `絵はぱっと替わるとき短い重ね合わせ (${tr.prop} ${tr.dur})`);
      await nc.close();

      // 1 枚でも絵が読めなければ、元のグラデーション + 星と月 (canvas) のまま
      const bc = await browser.newContext(PHONE);
      await bc.route('**/sky-starry.jpg', (r) => r.abort());
      const bp = await bc.newPage();
      await bp.goto(URL);
      await bp.waitForFunction(() => window.__app);
      await bp.locator('#btnAdventure').tap();
      const ob = await bp.evaluate(() => { const g = window.__app.game(); g.phase = 'play'; g.score = 45; g.pipes.length = 0; g.items.length = 0; window.__app.render();
        return ['skyMorning', 'skyNoon', 'skySunset', 'skyDusk', 'skyNight', 'skyStarry', 'skyAurora'].map((id) => +document.getElementById(id).style.opacity); });
      ok(ob.every((v) => v === 0), `絵が 1 枚でも読めないときは、どれも出さない (${ob})`);
      await bc.close();
    }

    // ------------------------------------------------ 無敵 (星) の鳥は光る
    section('無敵の光');
    {
      const gc = await browser.newContext(PHONE);
      const gp = await gc.newPage();
      await gp.goto(URL);
      await gp.waitForFunction(() => window.__app);
      await gp.locator('#btnAdventure').tap();
      const glow = await gp.evaluate(() => {
        const a = window.__app, g = a.game(), cv = document.getElementById('game');
        const k = cv.width / 430, ctx = cv.getContext('2d');
        const measure = (starOn, frame) => {
          g.phase = 'play'; g.birdY = 400; g.vy = 0; g.pipes.length = 0; g.items.length = 0; g.play = 100; g.frames = frame;
          g.starUntil = starOn ? 1e9 : 0; g.hurtUntil = 0;
          a.render();
          // 鳥の中心から 28〜44pt の輪のあいだ (体のまわり) に、どれだけ色が乗っているか (不透明度の合計 / 面積)
          const cx = 110 * k, cy = 400 * k, x0 = Math.floor(cx - 50 * k), y0 = Math.floor(cy - 50 * k), n = Math.ceil(100 * k);
          const d = ctx.getImageData(x0, y0, n, n).data;
          let sum = 0, cnt = 0;
          for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            const r = Math.hypot(x + x0 - cx, y + y0 - cy) / k;
            if (r >= 28 && r <= 44) { sum += d[(y * n + x) * 4 + 3] / 255; cnt++; }
          }
          return sum / cnt;
        };
        // 脈打つ光なので、位相を変えて 3 回測り、いちばん弱い回でも比べる
        const on = [], off = [];
        for (const f of [100, 110, 120]) on.push(measure(true, f));
        for (const f of [100, 110, 120]) off.push(measure(false, f));
        return { on: Math.min(...on), off: Math.max(...off) };
      });
      ok(glow.on > glow.off + 0.08, `無敵の鳥は、体のまわりに光が乗る (光あり ${glow.on.toFixed(2)} / なし ${glow.off.toFixed(2)})`);
      await gc.close();
    }

    // ------------------------------------------------ 無敵 (星) の曲
    section('無敵の曲');
    {
      const mc = await browser.newContext(PHONE);
      const mp = await mc.newPage();
      await mp.goto(URL);
      await mp.waitForFunction(() => window.__app);
      await mp.locator('#btnAdventure').tap();
      await mp.waitForFunction(() => window.__app.audio());
      // 出口の音量を 50ms ごとに測る。2 秒 (120 コマ) だけ無敵にして、鳥は浮かべたままにする
      await mp.evaluate(() => {
        const a = window.__app.audio(), g = window.__app.game();
        const an = a.ctx.createAnalyser(); an.fftSize = 1024; a.master.connect(an);
        const buf = new Float32Array(an.fftSize);
        window.__probe = { t0: performance.now(), peaks: [] };
        g.phase = 'play'; g.starUntil = g.play + 120;
        setInterval(() => {
          g.birdY = 400; g.vy = 0; g.pipes.length = 0; g.items.length = 0;
          an.getFloatTimeDomainData(buf);
          let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v));
          window.__probe.peaks.push({ t: (performance.now() - window.__probe.t0) / 1000, m, star: g.play < g.starUntil });
        }, 50);
      });
      await mp.waitForTimeout(2600);
      const pr = await mp.evaluate(() => window.__probe.peaks);
      const peak = (a, b) => Math.max(0, ...pr.filter((x) => x.t >= a && x.t < b).map((x) => x.m));
      const during = peak(0.3, 0.9), after = peak(1.5, 1.95);
      const starAt19 = pr.filter((x) => x.t >= 1.5 && x.t < 1.95).every((x) => x.star);
      ok(during > 0.02, `無敵のあいだ曲が鳴る (最大 ${during.toFixed(3)})`);
      ok(starAt19 && after < 0.005, `無敵が切れる前 (1.5〜1.95 秒。まだ無敵) に、音は元に戻って静か (最大 ${after.toFixed(4)})`);
      ok(during < 0.5, `曲が大きすぎない (最大 ${during.toFixed(3)} < 0.5)`);
      await mc.close();
    }

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
      // 絵の中身: 180x180・四隅が不透明 (iOS は透明を黒で埋める)・黄の鳥と青い空が入っている
      const px = await desk.evaluate(async (u) => {
        const im = new Image(); im.src = u; await im.decode();
        const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
        const g = c.getContext('2d'); g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let yellow = 0, blue = 0, minA = 255;
        for (let i = 0; i < d.length; i += 4) {
          minA = Math.min(minA, d[i + 3]);
          if (d[i] > 220 && d[i + 1] > 180 && d[i + 2] < 120) yellow++;
          if (d[i + 2] > 180 && d[i] < 140) blue++;
        }
        return { w: c.width, h: c.height, minA, yellow, blue };
      }, URL + apple.replace('./', ''));
      ok(px.w === 180 && px.h === 180, `ホーム画面用アイコンは 180x180 (${px.w}x${px.h})`);
      ok(px.minA === 255, `アイコンに透明な画素が無い (最小 alpha ${px.minA})`);
      ok(px.yellow > 1500 && px.blue > 3000, `アイコンに黄の鳥と青い空が入っている (黄 ${px.yellow} / 青 ${px.blue} 画素)`);
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
