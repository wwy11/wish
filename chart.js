'use strict';

/* ============================================================
   曲线：手写 SVG

   一条 sparkline 本质上就是十几个坐标点连成的 polyline。
   引 Chart.js 要 ~70KB，比整个应用都大，不划算。

   两个注意点：
     · x 轴按真实时间比例，不是等距 —— 衰减快慢才看得出来
     · preserveAspectRatio="none" 会把 stroke 一起拉变形，
       所以统一加 vector-effect="non-scaling-stroke"
   ============================================================ */
const Spark = (() => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** points: [{at, score}]，score 0-100，按 at 升序 */
  function geom(points, box) {
    if (!points.length) return null;
    const t0 = points[0].at;
    const t1 = points[points.length - 1].at;
    const span = t1 - t0;
    const { x0, x1, y0, y1 } = box;
    return points.map((p) => ({
      x: span > 0 ? x0 + ((p.at - t0) / span) * (x1 - x0) : (x0 + x1) / 2,
      y: y1 - (clamp(p.score, 0, 100) / 100) * (y1 - y0),
    }));
  }

  const fmt = (n) => n.toFixed(1);

  /** 卡片里的迷你曲线：只给形状，不给坐标 */
  function line(points, opts) {
    opts = opts || {};
    const w = opts.w || 200;
    const h = opts.h || 28;
    const pad = opts.pad != null ? opts.pad : 5;
    const color = opts.color || 'currentColor';
    const g = geom(points, { x0: pad, x1: w - pad, y0: pad, y1: h - pad });
    if (!g) return '';
    const tail = g[g.length - 1];
    const svg = (inner) =>
      `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="渴望度走势">${inner}</svg>`;
    // 只有一次打分画不出线，就画一个点
    if (g.length === 1) return svg(`<circle cx="${fmt(tail.x)}" cy="${fmt(tail.y)}" r="2.6" fill="${color}"/>`);
    const d = g.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');
    return svg(
      `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
        `<circle cx="${fmt(tail.x)}" cy="${fmt(tail.y)}" r="2.4" fill="${color}"/>`
    );
  }

  /** 详情页大图：带星位网格、首末日期、每个打分点 */
  function detail(points, opts) {
    opts = opts || {};
    const w = opts.w || 320;
    const h = opts.h || 150;
    const l = 30;
    const r = 8;
    const t = 12;
    const b = 22;
    const color = opts.color || 'currentColor';
    const g = geom(points, { x0: l, x1: w - r, y0: t, y1: h - b });
    if (!g) return '';

    let out = `<svg class="curve" viewBox="0 0 ${w} ${h}" role="img" aria-label="渴望度变化曲线">`;
    // 星位网格：1★ / 3★ / 5★
    [[100, '5★'], [60, '3★'], [20, '1★']].forEach(([score, label]) => {
      const y = (h - b) - (score / 100) * (h - b - t);
      out +=
        `<line x1="${l}" y1="${fmt(y)}" x2="${w - r}" y2="${fmt(y)}" stroke="currentColor" stroke-opacity=".14" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
        `<text x="${l - 6}" y="${fmt(y)}" text-anchor="end" dominant-baseline="central" font-size="10" fill="currentColor" fill-opacity=".55">${label}</text>`;
    });
    if (g.length > 1) {
      out += `<polyline points="${g.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    }
    g.forEach((p) => {
      out += `<circle cx="${fmt(p.x)}" cy="${fmt(p.y)}" r="3.2" fill="${color}"/>`;
    });
    // 首末日期
    const d0 = new Date(points[0].at);
    const d1 = new Date(points[points.length - 1].at);
    const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
    out += `<text x="${l}" y="${h - 6}" font-size="10" fill="currentColor" fill-opacity=".55">${md(d0)}</text>`;
    if (points.length > 1) {
      out += `<text x="${w - r}" y="${h - 6}" text-anchor="end" font-size="10" fill="currentColor" fill-opacity=".55">${md(d1)}</text>`;
    }
    return out + '</svg>';
  }

  return { line, detail };
})();
