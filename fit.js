// 画面に合わせて全体を拡縮する。430x932 は決め打ちのまま、見えている高さが足りないとき
// (Safari の帯・アプリ内の枠など) に、縦横の比そのままで縮めて、床まで収める。
// ホーム画面から開いたとき (932 ある) は 1 倍のまま。
(function () {
  var app = document.getElementById('app');
  var sky = document.getElementById('sky');
  var vis = null;   // 親の枠が下を切っているときの、見えている範囲 (top, height)

  function fit() {
    var w = window.innerWidth, h = window.innerHeight, y0 = 0;
    if (vis && vis.height >= 100) { y0 = Math.max(0, vis.top); h = Math.min(h - y0, vis.height); }
    if (!(w >= 1 && h >= 1)) return;   // 回転中などに 0 が渡ってくる
    var s = Math.min(w / 430, h / 932);
    app.style.transform = 'translate(' + ((w - 430 * s) / 2) + 'px,' + (y0 + (h - 932 * s) / 2) + 'px) scale(' + s + ')';
    app.dataset.scale = s.toFixed(4);
  }

  // 左右・上下の余白は、いまの空の色に合わせる
  function tint() {
    if (sky && sky.style.background) document.documentElement.style.background = sky.style.background;
  }
  if (sky && window.MutationObserver) new MutationObserver(tint).observe(sky, { attributes: true, attributeFilter: ['style'] });

  // 窓は、見えている高さより大きく渡されることがある (Claude アプリの枠など)。見えている範囲を測る
  try {
    var pr = document.createElement('div');
    pr.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none';
    document.body.appendChild(pr);
    var th = []; for (var i = 0; i <= 50; i++) th.push(i / 50);
    new IntersectionObserver(function (es) {
      var e = es[es.length - 1], r = e.intersectionRect, b = e.boundingClientRect;
      vis = { top: r.top - b.top, height: r.height };
      fit();
    }, { threshold: th }).observe(pr);
  } catch (err) { /* 測れなければ窓の大きさのまま */ }

  tint(); fit();
  window.addEventListener('resize', fit);
})();
