'use strict';

/* ============================================================
   种草 —— 记录想买但不会马上买的东西，随时给渴望度打分

   核心不是清单，是那条曲线：每次打分都存一条带时间戳的记录，
   攒出来的走势能区分「一时上头」和「真的想要」。
   ============================================================ */

/* ============ 常量 ============ */
const CATS = [
  { id: 'digital', label: '数码' },
  { id: 'accessory', label: '周边' },
  { id: 'home', label: '家居' },
  { id: 'clothes', label: '服饰' },
  { id: 'other', label: '其他' },
];
const CAT_LABEL = Object.fromEntries(CATS.map((c) => [c.id, c.label]));
const normCat = (c) => (CAT_LABEL[c] ? c : 'other');

const DAY = 86400000;

/* 提醒阈值：这几个数本来就是拍脑袋定的，不同人种草的节奏差很远，
   所以做成设置项，让用户按自己的节奏调，别替他决定。 */
const STALE_OPTIONS = [
  { d: 7, label: '7 天' },
  { d: 30, label: '1 个月' },
  { d: 90, label: '3 个月' },
  { d: 180, label: '半年' },
  { d: 365, label: '1 年' },
];
const COOL_OPTIONS = [
  { s: 2, label: '2★ 及以下' },
  { s: 1, label: '1★' },
];

const TABS = [
  { id: 'wish', label: '种草中' },
  { id: 'bought', label: '已入手' },
  { id: 'dropped', label: '已放下' },
];

/* 齿轮用 SVG：字符 ⚙ 在 iOS 上会被渲染成彩色 emoji，跟这个界面完全不搭 */
const GEAR =
  '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="3.1"/>' +
  '<path d="M12 2.6v2.3M12 19.1v2.3M2.6 12h2.3M19.1 12h2.3M4.4 7.3l2 1.15M17.6 15.55l2 1.15M4.4 16.7l2-1.15M17.6 8.45l2-1.15"/>' +
  '</svg>';

/* ============ 状态 ============ */
let items = [];
let pulsesByItem = Object.create(null);
let tab = 'wish';
/* 应用内跳转栈：go() 压入出发页，back()/finishTo() 消费。
   只在应用内跳转时有值——刷新后/直接打开深链时它是空的，
   此时退无可退，就用 location.replace 原地换页，不会退出 app。
   （从 coffee 抄的同一思路） */
let navStack = [];

/* ============ 工具 ============ */
const $ = (sel, root) => (root || document).querySelector(sel);
const esc = (s) =>
  s == null ? '' : String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const startOfDay = (ts) => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const money = (n) => '¥' + Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const md = (ts) => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

let toastTimer = null;
function toast(msg) {
  let t = $('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

/* ============ 设置 ============ */
const SETTINGS_KEY = 'wish-settings';
const DEFAULT_SETTINGS = { staleDays: 7, coolStar: 2, theme: 'auto' };
let settings = Object.assign({}, DEFAULT_SETTINGS);

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s && typeof s === 'object') Object.assign(settings, s);
  } catch (e) {} // 隐私模式下 localStorage 会抛错 → 用默认值继续，不要因此打不开 app
  if (!STALE_OPTIONS.some((o) => o.d === settings.staleDays)) settings.staleDays = DEFAULT_SETTINGS.staleDays;
  if (!COOL_OPTIONS.some((o) => o.s === settings.coolStar)) settings.coolStar = DEFAULT_SETTINGS.coolStar;
  if (['auto', 'light', 'dark'].indexOf(settings.theme) < 0) settings.theme = 'auto';
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {}
}

function applyTheme() {
  const t = settings.theme;
  const dark =
    t === 'dark' || (t === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', dark ? '#171412' : '#fbf8f4');
}

const staleLabel = () => (STALE_OPTIONS.find((o) => o.d === settings.staleDays) || STALE_OPTIONS[0]).label;

/* ============ 派生指标 ============ */
const pulsesOf = (id) => pulsesByItem[id] || [];
const lastPulse = (it) => {
  const p = pulsesOf(it.id);
  return p.length ? p[p.length - 1] : null;
};
const heatOf = (it) => {
  const p = lastPulse(it);
  return p ? p.score : 0;
};
const starOf = (score) => clamp(Math.round((score || 0) / 20), 1, 5);
const ageDays = (it) => Math.max(0, Math.floor((Date.now() - it.createdAt) / DAY));
const sinceLast = (it) => {
  const p = lastPulse(it);
  return Date.now() - (p ? p.at : it.createdAt);
};
const isStale = (it) => it.status === 'wish' && sinceLast(it) > settings.staleDays * DAY;
/** 与首次打分的差值：正数=越想越想要，负数=在冷下来 */
const deltaOf = (it) => {
  const p = pulsesOf(it.id);
  return p.length < 2 ? 0 : p[p.length - 1].score - p[0].score;
};
const isCooled = (it) => it.status === 'wish' && heatOf(it) <= settings.coolStar * 20;

async function refresh() {
  const snap = await DB.snapshot();
  items = snap.items;
  pulsesByItem = Object.create(null);
  snap.pulses.forEach((p) => {
    (pulsesByItem[p.itemId] || (pulsesByItem[p.itemId] = [])).push(p);
  });
}

/* ============ 组件 ============ */
function starsHtml(it, big) {
  const s = starOf(heatOf(it));
  let out = `<span class="stars${big ? ' big' : ''}">`;
  for (let i = 1; i <= 5; i++) {
    out += `<button type="button" class="star${i <= s ? ' on' : ''}" data-rate="${esc(it.id)}" data-star="${i}" aria-label="打 ${i} 星">★</button>`;
  }
  return out + '</span>';
}

function thumbHtml(it) {
  // 列表只吃小图（photoThumb，160px）。拿 1000px 原图塞进 48px 的格子，
  // iPhone 每次回首页都要重新解析+解码 N 张大图 —— 这才是「几秒空屏」的真凶。
  const src = it.photoThumb || it.photo;
  if (src) return `<img class="thumb" src="${esc(src)}" alt="" decoding="async" />`;
  return `<div class="thumb thumb-ph">${esc((it.name || '?').trim().slice(0, 1))}</div>`;
}

/** 首页提醒区：待复评 + 已冷却，各自有各自的去处 */
function remindersHtml() {
  const nStale = items.filter((i) => i.status === 'wish' && isStale(i)).length;
  const nCool = items.filter((i) => i.status === 'wish' && isCooled(i)).length;
  return (
    (nStale
      ? `<button class="remind-bar" data-nav="review">
      <span>${nStale} 件超过 ${staleLabel()}没复评</span>
      <span class="rb-go">去打分 ›</span>
    </button>`
      : '') +
    (nCool
      ? `<button class="remind-bar cool" data-nav="cool">
      <span>${nCool} 件已经冷下来了</span>
      <span class="rb-go">去清理 ›</span>
    </button>`
      : '')
  );
}

/** 打分后只刷新提醒区：列表里那张卡由 rate() 就地替换，这里别整页重排 */
function updateReminders() {
  const box = $('#reminders');
  if (box) box.innerHTML = remindersHtml();
}

function cardHtml(it) {
  const delta = deltaOf(it);
  const cooled = isCooled(it);
  const color = delta > 0 ? 'var(--up)' : 'var(--cool)';
  const meta = [CAT_LABEL[normCat(it.category)], `${ageDays(it)}天`];
  const dStar = Math.abs(Math.round(delta / 20)) || 1;
  // 用 +/- 而不是 ↑↓：11px 下箭头渲染出来像数字 1，会被读成「11★」
  if (delta > 0) meta.push(`+${dStar}★`);
  else if (delta < 0) meta.push(`-${dStar}★`);
  if (cooled) meta.push('已冷却');
  else if (isStale(it)) meta.push('待复评');
  return `<article class="card${cooled ? ' cooled' : ''}" data-open="${esc(it.id)}">
    <div class="card-row">
      ${thumbHtml(it)}
      <div class="card-main">
        <div class="card-line1">
          <span class="name">${esc(it.name)}</span>
          <span class="price">${it.price ? money(it.price) : ''}</span>
        </div>
        <div class="card-line2">${starsHtml(it)}<span class="meta">${esc(meta.join(' · '))}</span></div>
      </div>
    </div>
    <div class="card-spark">${Spark.line(pulsesOf(it.id), { color })}</div>
  </article>`;
}

/* ============ 页面：首页 ============ */
function renderHome() {
  const app = $('#app');
  const wish = items.filter((i) => i.status === 'wish');
  const list = items.filter((i) => i.status === tab);
  // 冷却的沉底，其余按热度降序
  list.sort((a, b) => {
    const ca = isCooled(a) ? 1 : 0;
    const cb = isCooled(b) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    return heatOf(b) - heatOf(a);
  });
  const saved = items.filter((i) => i.status === 'dropped').reduce((s, i) => s + (Number(i.price) || 0), 0);
  const spent = items.filter((i) => i.status === 'bought').reduce((s, i) => s + (Number(i.price) || 0), 0);

  const emptyText = {
    wish: '还没有种草的东西。看到想买的，先记下来，别急着下单。',
    bought: '还没有入手的东西。',
    dropped: '还没有放下的东西。放下之后这里会累计你省下的钱。',
  }[tab];

  app.innerHTML = `
    <header class="topbar">
      <h1 class="title">种草</h1>
      <div class="topbar-actions">
        <button class="icon-btn" data-nav="settings" aria-label="设置">${GEAR}</button>
        <button class="icon-btn" data-nav="add" aria-label="添加">+</button>
      </div>
    </header>

    <div class="metrics">
      <div class="metric"><div class="m-label">种草中</div><div class="m-val">${wish.length}</div></div>
      <div class="metric"><div class="m-label">忍住了</div><div class="m-val">${money(saved)}</div></div>
      <div class="metric"><div class="m-label">已入手</div><div class="m-val">${money(spent)}</div></div>
    </div>

    <div class="reminders" id="reminders">${remindersHtml()}</div>

    <nav class="tabs">${TABS.map(
      (t) => `<button class="tab${t.id === tab ? ' on' : ''}" data-tab="${t.id}">${t.label}</button>`
    ).join('')}</nav>

    <div class="list">${list.length ? list.map(cardHtml).join('') : `<div class="empty">${esc(emptyText)}</div>`}</div>
  `;
}

/* ============ 页面：批量复评 ============ */
function renderReview() {
  const app = $('#app');
  const list = items.filter((i) => i.status === 'wish' && isStale(i));
  // 最久没碰的排最前
  list.sort((a, b) => sinceLast(b) - sinceLast(a));
  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn left" data-back aria-label="返回">‹</button>
      <h1 class="title">批量复评</h1>
      <span class="topbar-pad"></span>
    </header>
    <p class="hint">现在还想要吗？点一下星星。打完分的会自动移出这个列表。</p>
    <div class="list">
      ${
        list.length
          ? list
              .map(
                (it) => `<article class="card review-card">
        <div class="card-row">
          ${thumbHtml(it)}
          <div class="card-main">
            <div class="card-line1">
              <span class="name">${esc(it.name)}</span>
              <span class="price">${it.price ? money(it.price) : ''}</span>
            </div>
            <div class="card-line2">${starsHtml(it)}<span class="meta">${Math.floor(sinceLast(it) / DAY)}天没评</span></div>
          </div>
        </div>
      </article>`
              )
              .join('')
          : '<div class="empty">都评过了，没有待复评的东西。</div>'
      }
    </div>
  `;
}

/* ============ 页面：已冷却（清理） ============ */
function renderCool() {
  const app = $('#app');
  const list = items.filter((i) => i.status === 'wish' && isCooled(i));
  // 最冷的排最前，好从最没感觉的开始清
  list.sort((a, b) => heatOf(a) - heatOf(b) || sinceLast(b) - sinceLast(a));
  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn left" data-back aria-label="返回">‹</button>
      <h1 class="title">已经冷下来的</h1>
      <span class="topbar-pad"></span>
    </header>
    <p class="hint">渴望度掉到 ${settings.coolStar}★ 及以下了。真不想要就放下，省下的钱会累计到首页；又想要了就重新打高分。</p>
    <div class="list">
      ${list.length ? list.map(coolCardHtml).join('') : '<div class="empty">没有冷下来的东西。</div>'}
    </div>
  `;
}

function coolCardHtml(it) {
  return `<article class="card cool-card">
    <div class="card-row">
      ${thumbHtml(it)}
      <div class="card-main">
        <div class="card-line1">
          <span class="name">${esc(it.name)}</span>
          <span class="price">${it.price ? money(it.price) : ''}</span>
        </div>
        <div class="card-line2">${starsHtml(it)}<span class="meta">${Math.floor(sinceLast(it) / DAY)}天没评</span></div>
      </div>
    </div>
    <div class="cool-actions">
      <button class="btn small" data-status="dropped" data-id="${esc(it.id)}">放下了</button>
      <button class="btn small danger" data-del="${esc(it.id)}">删除</button>
    </div>
  </article>`;
}

/* ============ 页面：详情 ============ */
function renderItem(id) {
  const app = $('#app');
  const it = items.find((i) => i.id === id);
  if (!it) {
    // replace 而不是 go()：go() 会把首页压到详情上面，给系统右滑留脏历史
    location.replace('#/home');
    return;
  }
  const ps = pulsesOf(id);
  const delta = deltaOf(it);
  const history = ps
    .slice()
    .reverse()
    .slice(0, 12)
    .map((p) => `<li><span class="h-date">${md(p.at)}</span><span class="h-star">${'★'.repeat(starOf(p.score))}</span></li>`)
    .join('');

  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn left" data-back aria-label="返回">‹</button>
      <h1 class="title">详情</h1>
      <button class="icon-btn" data-edit="${esc(it.id)}" aria-label="编辑">✎</button>
    </header>

    ${it.photo ? `<div class="hero"><img src="${esc(it.photo)}" alt="" decoding="async" /></div>` : ''}

    <div class="detail-head">
      <div class="d-name">${esc(it.name)}</div>
      <div class="d-sub">${it.price ? money(it.price) + ' · ' : ''}${esc(CAT_LABEL[normCat(it.category)])} · 加入 ${ageDays(it)} 天</div>
    </div>

    <section class="block">
      <div class="block-title">现在有多想要</div>
      ${starsHtml(it, true)}
      <div class="heat-line">${
        delta === 0
          ? '还没有变化'
          : delta > 0
            ? `比刚加入时更想要（+${Math.round(delta / 20)}★）`
            : `比刚加入时冷了一些（-${Math.abs(Math.round(delta / 20))}★）`
      }</div>
    </section>

    <section class="block">
      <div class="block-title">渴望度走势</div>
      <div class="curve-wrap">${Spark.detail(ps, { color: delta > 0 ? 'var(--up)' : 'var(--cool)' })}</div>
    </section>

    ${
      ps.length
        ? `<section class="block">
      <div class="block-title">打分记录</div>
      <ul class="history">${history}</ul>
    </section>`
        : ''
    }

    ${it.note ? `<section class="block"><div class="block-title">备注</div><div class="note">${esc(it.note)}</div></section>` : ''}
    ${
      it.url
        ? `<section class="block"><a class="link" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">打开链接 ›</a></section>`
        : ''
    }

    <section class="block actions">
      ${
        it.status === 'wish'
          ? `<button class="btn" data-status="bought" data-id="${esc(it.id)}">买了</button>
             <button class="btn" data-status="dropped" data-id="${esc(it.id)}">放下了</button>`
          : `<button class="btn" data-status="wish" data-id="${esc(it.id)}">重新种草</button>`
      }
      <button class="btn danger" data-del="${esc(it.id)}">删除</button>
    </section>
  `;
}

/* ============ 页面：添加 / 编辑 ============ */
let formPhoto = null; // 待保存的大图（dataURL，最长边 1000px）
let formThumb = null; // 对应的列表小图（160px）
let formPhotoDirty = false;

function renderForm(id) {
  const app = $('#app');
  const it = id ? items.find((i) => i.id === id) : null;
  formPhoto = it ? it.photo || null : null;
  formThumb = it ? it.photoThumb || null : null;
  formPhotoDirty = false;
  const cur = it ? starOf(heatOf(it)) : 3;

  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn left" data-back aria-label="返回">‹</button>
      <h1 class="title">${it ? '编辑' : '添加'}</h1>
      <span class="topbar-pad"></span>
    </header>

    <form id="item-form" class="form">
      <label class="field">
        <span class="f-label">想买什么</span>
        <input name="name" type="text" required maxlength="60" placeholder="比如 Sony WH-1000XM6" value="${it ? esc(it.name) : ''}" autocomplete="off" />
      </label>

      <label class="field">
        <span class="f-label">价格 <span class="f-hint">不填不计入统计</span></span>
        <input name="price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0" value="${it && it.price != null ? it.price : ''}" />
      </label>

      <div class="field">
        <span class="f-label">现在有多想要</span>
        <div class="form-stars" id="form-stars">
          ${[1, 2, 3, 4, 5]
            .map((i) => `<button type="button" class="star big${i <= cur ? ' on' : ''}" data-formstar="${i}" aria-label="打 ${i} 星">★</button>`)
            .join('')}
        </div>
      </div>

      <details class="more" open>
        <summary>更多（分类 / 链接 / 照片 / 备注）</summary>
        <label class="field">
          <span class="f-label">分类</span>
          <select name="category">
            ${CATS.map((c) => `<option value="${c.id}"${it && normCat(it.category) === c.id ? ' selected' : ''}>${c.label}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span class="f-label">链接</span>
          <input name="url" type="url" placeholder="https://" value="${it ? esc(it.url || '') : ''}" autocomplete="off" />
        </label>
        <div class="field">
          <span class="f-label">照片</span>
          <div class="photo-row">
            <div class="photo-preview" id="photo-preview">${formPhoto ? `<img src="${esc(formPhoto)}" alt="" />` : ''}</div>
            <div class="photo-actions">
              <label class="btn small">选择<input type="file" id="photo-input" accept="image/*" hidden /></label>
              <button type="button" class="btn small" id="photo-clear">清除</button>
            </div>
          </div>
        </div>
        <label class="field">
          <span class="f-label">备注</span>
          <textarea name="note" rows="3" maxlength="500" placeholder="等降价到 1800">${it ? esc(it.note || '') : ''}</textarea>
        </label>
      </details>

      <button type="submit" class="btn primary">${it ? '保存' : '加进清单'}</button>
    </form>
  `;

  const form = $('#item-form');
  let picked = cur;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    if (!name) return;
    const priceRaw = String(fd.get('price') || '').trim();
    const price = priceRaw === '' ? null : Number(priceRaw);
    const submit = form.querySelector('button[type=submit]');
    submit.disabled = true;

    try {
      if (it) {
        it.name = name;
        it.price = Number.isFinite(price) ? price : null;
        it.category = normCat(fd.get('category'));
        it.url = String(fd.get('url') || '').trim();
        it.note = String(fd.get('note') || '').trim();
        if (formPhotoDirty) {
          it.photo = formPhoto;
          it.photoThumb = formThumb;
        }
        await DB.putItem(it);
        toast('已保存');
      } else {
        const rec = {
          id: uid(),
          name,
          price: Number.isFinite(price) ? price : null,
          category: normCat(fd.get('category')),
          url: String(fd.get('url') || '').trim(),
          photo: formPhoto,
          photoThumb: formThumb,
          note: String(fd.get('note') || '').trim(),
          createdAt: Date.now(),
          status: 'wish',
          decidedAt: null,
          satisfaction: null,
        };
        await DB.putItem(rec);
        // 创建即写第一条打分，这样每个物品都有一条曲线起点
        await DB.putPulse({ id: uid(), itemId: rec.id, score: picked * 20, at: Date.now() });
        toast('已加进清单');
      }
      await refresh();
      finishTo(it ? 'item/' + it.id : 'home');
    } catch (err) {
      submit.disabled = false;
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'));
    }
  });

  $('#form-stars').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-formstar]');
    if (!b) return;
    picked = Number(b.dataset.formstar);
    $('#form-stars')
      .querySelectorAll('.star')
      .forEach((s) => s.classList.toggle('on', Number(s.dataset.formstar) <= picked));
  });

  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const out = await compressImage(file);
      formPhoto = out.full;
      formThumb = out.thumb;
      formPhotoDirty = true;
      $('#photo-preview').innerHTML = `<img src="${esc(out.full)}" alt="" />`;
    } catch (err) {
      toast('图片处理失败');
    }
  });

  $('#photo-clear').addEventListener('click', () => {
    formPhoto = null;
    formThumb = null;
    formPhotoDirty = true;
    $('#photo-preview').innerHTML = '';
  });
}

/** 压到最长边 1000px / jpeg 0.75：不压的话几张图就能吃掉配额，且 iOS 超配额是静默失败 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      // 同时出两张：大图给详情页，小图给列表（列表塞大图是 iOS 上回首页卡顿的真凶）
      resolve({ full: scaleTo(img, 1000, 0.75), thumb: scaleTo(img, 160, 0.6) });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
}

/** 把已加载的 <img> 缩到最长边 max、jpeg quality，返回 dataURL */
function scaleTo(img, max, quality) {
  let w = img.width;
  let h = img.height;
  const scale = Math.min(1, max / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}

/** 用已有的 dataURL 现生成小图（给旧数据补 photoThumb 用） */
function makeThumb(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(scaleTo(img, 160, 0.6));
    img.onerror = () => reject(new Error('缩略图生成失败'));
    img.src = dataUrl;
  });
}

/* ============ 页面：设置 ============ */
function segBtns(opts, key, cur) {
  return opts
    .map(
      (o) =>
        `<button type="button" class="seg-btn${String(o.v) === String(cur) ? ' on' : ''}" data-seg="${esc(key)}" data-val="${esc(o.v)}">${esc(o.label)}</button>`
    )
    .join('');
}

function bindSeg(sel, onPick) {
  const box = $(sel);
  if (!box) return;
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-seg]');
    if (!b || b.classList.contains('on')) return;
    box.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('on', x === b));
    onPick(b.dataset.val);
  });
}

function renderSettings() {
  const app = $('#app');
  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn left" data-back aria-label="返回">‹</button>
      <h1 class="title">设置</h1>
      <span class="topbar-pad"></span>
    </header>

    <section class="block">
      <div class="block-title">外观</div>
      <div class="seg" id="seg-theme">
        ${segBtns(
          [
            { v: 'auto', label: '跟随系统' },
            { v: 'light', label: '浅色' },
            { v: 'dark', label: '深色' },
          ],
          'theme',
          settings.theme
        )}
      </div>
    </section>

    <section class="block">
      <div class="block-title">复评提醒</div>
      <p class="hint">多久没更新渴望度就算「该复评了」。首页会提醒，点进去一口气打完。</p>
      <div class="seg wrap" id="seg-stale">
        ${segBtns(STALE_OPTIONS.map((o) => ({ v: o.d, label: o.label })), 'stale', settings.staleDays)}
      </div>
    </section>

    <section class="block">
      <div class="block-title">冷却线</div>
      <p class="hint">渴望度降到这条线以下就算冷下来了：主列表里沉底，首页提醒你清理。</p>
      <div class="seg" id="seg-cool">
        ${segBtns(COOL_OPTIONS.map((o) => ({ v: o.s, label: o.label })), 'cool', settings.coolStar)}
      </div>
    </section>

    <section class="block">
      <div class="block-title">数据</div>
      <div class="actions">
        <button class="btn" id="btn-export">导出备份</button>
        <button class="btn" id="btn-import">导入备份</button>
      </div>
      <input type="file" id="import-input" accept="application/json,.json" hidden />
      <p class="hint">数据只存在这台设备里。换手机或清缓存之前先导出一份——时间序数据丢了就真攒不回来了。</p>
    </section>

    <section class="block">
      <div class="block-title">关于</div>
      <div class="ver-line" id="ver-line">版本检测中…</div>
    </section>
  `;

  bindSeg('#seg-theme', (v) => {
    settings.theme = v;
    saveSettings();
    applyTheme();
  });
  // 改阈值只影响首页提醒，当前就在首页的话就地刷新提醒区
  bindSeg('#seg-stale', (v) => {
    settings.staleDays = Number(v);
    saveSettings();
    updateReminders();
  });
  bindSeg('#seg-cool', (v) => {
    settings.coolStar = Number(v);
    saveSettings();
    updateReminders();
  });

  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => $('#import-input').click());
  $('#import-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = ''; // 清空才能连续导入同一个文件
    if (f) importData(f);
  });

  fillVersionLine();
}

/* ============ 版本号 ============ */
/**
 * 版本号取自 Service Worker 的缓存名（wish-vN）——唯一事实来源，
 * 不用在 app.js 里再维护一份常量，否则两边迟早对不上。
 */
async function currentVersion() {
  if (!('caches' in window)) return null;
  try {
    const keys = await caches.keys();
    const vs = keys
      .filter((k) => /^wish-v\d+$/.test(k))
      .map((k) => Number(k.slice(6)))
      .filter((n) => Number.isFinite(n));
    return vs.length ? 'v' + Math.max.apply(null, vs) : null;
  } catch (e) {
    return null;
  }
}

async function fillVersionLine() {
  const el = $('#ver-line');
  if (!el) return;
  const v = await currentVersion();
  if (!v) {
    el.textContent = '版本未知（离线缓存未启用）';
    return;
  }
  let seen = '';
  try {
    const key = 'wish-seen-' + v;
    seen = localStorage.getItem(key) || '';
    if (!seen) {
      seen = fmtDateTime(Date.now());
      localStorage.setItem(key, seen);
      // 旧版本的记录清掉，别越攒越多
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf('wish-seen-') === 0 && k !== key) localStorage.removeItem(k);
      }
    }
  } catch (e) {}
  el.textContent = `版本 ${v}${seen ? ' · ' + seen + ' 生效' : ''}`;
}

/* ============ 导入 / 导出 ============ */
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
};
const fmtDateTime = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

async function exportData() {
  const btn = $('#btn-export');
  if (btn) btn.disabled = true;
  try {
    const snap = await DB.snapshot();
    const payload = {
      app: 'wish',
      version: 1,
      exportedAt: new Date().toISOString(),
      items: snap.items,
      pulses: snap.pulses,
    };
    const text = JSON.stringify(payload, null, 2);
    const name = 'wish-' + ymd(Date.now()) + '.json';

    // iOS 上最顺手的是系统分享（存「文件」、发微信都行），不支持才退回下载
    const file = typeof File === 'function' ? new File([text], name, { type: 'application/json' }) : null;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // 用户自己取消的，不算失败
      }
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已导出 ' + name);
  } catch (err) {
    toast('导出失败：' + (err && err.message ? err.message : '未知错误'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function importData(file) {
  let text;
  try {
    text = await file.text();
  } catch (e) {
    return toast('读不出这个文件');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return toast('不是合法的 JSON 文件');
  }
  if (!data || !Array.isArray(data.items)) return toast('文件里没有物品数据');

  const inItems = [];
  data.items.forEach((r) => {
    const it = sanitizeItem(r);
    if (it) inItems.push(it);
  });
  if (!inItems.length) return toast('文件里没有可用的物品');

  const ids = Object.create(null);
  inItems.forEach((i) => {
    ids[i.id] = true;
  });
  const inPulses = [];
  (Array.isArray(data.pulses) ? data.pulses : []).forEach((r) => {
    const p = sanitizePulse(r, ids);
    if (p) inPulses.push(p);
  });

  // 合并还是覆盖必须让用户自己选：这一步选错会丢数据，不能替他决定
  sheet(`导入 ${inItems.length} 个物品 · ${inPulses.length} 条打分`, '合并保留现有数据、只补进新的；覆盖会先清空这台设备上的数据。', [
    { label: '合并', primary: true, onClick: () => doImport(inItems, inPulses, false) },
    { label: '覆盖（清空当前数据）', danger: true, onClick: () => doImport(inItems, inPulses, true) },
    { label: '取消' },
  ]);
}

/** 外部文件一律当脏数据看待：缺字段补默认、越界值夹住、没名字的丢掉 */
function sanitizeItem(r) {
  if (!r || typeof r !== 'object') return null;
  const name = String(r.name == null ? '' : r.name).trim();
  if (!name) return null;
  // 没填价格必须保住 null：Number(null) 是 0，直接转会让物品显示成「¥0」
  const pRaw = r.price;
  const pNum = Number(pRaw);
  const price = pRaw == null || String(pRaw).trim() === '' || !Number.isFinite(pNum) || pNum < 0 ? null : pNum;
  const photo = typeof r.photo === 'string' && r.photo.indexOf('data:image/') === 0 ? r.photo : null;
  // 小图：格式合法且体积正常才收（几十 KB 级）。异常大的说明不是 160px 缩略图，
  // 宁可丢掉——启动时的 backfillThumbs() 会按大图重新生成。
  const thumb =
    photo && typeof r.photoThumb === 'string' && r.photoThumb.indexOf('data:image/') === 0 && r.photoThumb.length < 262144
      ? r.photoThumb
      : null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : uid(),
    name: name.slice(0, 60),
    price,
    category: normCat(r.category),
    url: typeof r.url === 'string' ? r.url.trim().slice(0, 2000) : '',
    photo,
    photoThumb: thumb,
    note: typeof r.note === 'string' ? r.note.slice(0, 500) : '',
    createdAt: Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : Date.now(),
    status: ['wish', 'bought', 'dropped'].indexOf(r.status) >= 0 ? r.status : 'wish',
    decidedAt: Number.isFinite(Number(r.decidedAt)) ? Number(r.decidedAt) : null,
    satisfaction: Number.isFinite(Number(r.satisfaction)) ? Number(r.satisfaction) : null,
  };
}

function sanitizePulse(r, validIds) {
  if (!r || typeof r !== 'object') return null;
  const itemId = typeof r.itemId === 'string' ? r.itemId : '';
  if (!validIds[itemId]) return null; // 找不到主人的打分，丢掉
  const score = Math.round(Number(r.score));
  if (!Number.isFinite(score)) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : uid(),
    itemId,
    score: clamp(score, 0, 100),
    at: Number.isFinite(Number(r.at)) ? Number(r.at) : Date.now(),
  };
}

async function doImport(inItems, inPulses, replace) {
  try {
    if (replace) await DB.replaceAll(inItems, inPulses);
    else await DB.mergeAll(inItems, inPulses);
    await refresh();
    render();
    backfillThumbs(); // 导入的旧数据同样补小图
    toast(replace ? '已覆盖导入' : '已合并导入');
  } catch (err) {
    toast('导入失败：' + (err && err.message ? err.message : '未知错误'));
  }
}

/** 底部选择面板：比原生 confirm 多一个选项，导入这种不可逆操作需要它 */
function sheet(title, desc, actions) {
  const old = $('.sheet-mask');
  if (old) old.remove();
  const mask = document.createElement('div');
  mask.className = 'sheet-mask';
  const box = document.createElement('div');
  box.className = 'sheet';
  box.innerHTML = `<div class="sheet-title">${esc(title)}</div>${desc ? `<div class="sheet-desc">${esc(desc)}</div>` : ''}`;
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn sheet-btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    b.addEventListener('click', () => {
      mask.remove();
      if (a.onClick) a.onClick();
    });
    box.appendChild(b);
  });
  mask.appendChild(box);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.remove();
  });
  document.body.appendChild(mask);
}

/* ============ 交互 ============ */
async function rate(id, star) {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  const score = star * 20;
  const today = startOfDay(Date.now());
  const list = pulsesOf(id);
  // 同一天重复打分 → 覆盖当天那条，而不是堆成噪声
  const same = list.find((p) => startOfDay(p.at) === today);
  try {
    if (same) {
      same.score = score;
      same.at = Date.now();
      await DB.putPulse(same);
      toast('今天的打分已更新');
    } else {
      const p = { id: uid(), itemId: id, score, at: Date.now() };
      await DB.putPulse(p);
      list.push(p);
      toast(`记下了 · ${star}★`);
    }
    await refresh();

    // 首页只替换这一张卡，不整页重排 —— 否则刚点完的卡片会立刻从手指底下跳走，
    // 用户会不确定自己刚才点的是哪一条。重排留到下次进入首页时自然发生。
    const onHome = !!$('#reminders');
    const card = document.querySelector('.card[data-open="' + id + '"]');
    const fresh = items.find((i) => i.id === id);
    if (onHome && card && fresh) {
      card.outerHTML = cardHtml(fresh);
      updateReminders();
    } else {
      render(); // 复评页/冷却页要的是「打完就移出列表」，该重排就重排
    }
  } catch (err) {
    toast('打分没存住：' + (err && err.message ? err.message : '未知错误'));
  }
}

async function setStatus(id, status) {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  it.status = status;
  it.decidedAt = status === 'wish' ? null : Date.now();
  await DB.putItem(it);
  await refresh();
  toast(status === 'bought' ? '已标记为入手' : status === 'dropped' ? '放下了，钱省下来了' : '重新种草');
  render();
}

async function removeItem(id) {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  if (!confirm(`删除「${it.name}」？它的打分记录会一起删掉。`)) return;
  await DB.removeItem(id);
  await refresh();
  toast('已删除');
  finishTo('home');
}

/* ============ 路由 ============ */
/**
 * 导航完全照抄饮记（同项目、真机验证过丝滑）：原生历史 + navStack 判断有没有上一页。
 *   - go() 一律 push（location.hash = ）：首页永远留在栈底，子页面右滑天然能回；
 *     首页底下没有条目，系统右滑自然什么都不做——不需要守卫。
 *   - back()/finishTo() 有上一页就 history.back()，退无可退（刷新/深链）才 replace 原地换页。
 * 教训（v6/v7）：从首页出发用 replace + pushState 垫守卫，等于给了首页一个假「上一页」，
 * 右滑会真的发生一次历史切换——iOS 上就是「空屏一下，然后又回一次首页」。
 */
function go(hash) {
  navStack.push((location.hash || '#/home').replace(/^#\/?/, '') || 'home');
  location.hash = '#/' + hash;
}

function back() {
  if (navStack.length > 0) {
    navStack.pop();
    history.back();
  } else {
    location.replace('#/home');
  }
}

/**
 * 保存、删除这类「完事回上一页」专用：能回到上一页就用上一页，否则落到 fallback。
 * 关键：保存后不能 go()——go 会把父页面再压一层，下次返回就回到那个父页面而不是孙页面。
 */
function finishTo(fallback) {
  if (navStack.length > 0) {
    navStack.pop();
    history.back();
  } else {
    location.replace('#/' + fallback);
  }
}

function render() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, arg] = raw.split('/');
  if (name === 'add') return renderForm(null);
  if (name === 'edit' && arg) return renderForm(arg);
  if (name === 'item' && arg) return renderItem(arg);
  if (name === 'review') return renderReview();
  if (name === 'cool') return renderCool();
  if (name === 'settings') return renderSettings();
  return renderHome();
}

function renderError(err) {
  $('#app').innerHTML = `
    <div class="empty err">
      <p>数据打不开：${esc(err && err.message ? err.message : '未知错误')}</p>
      <p class="err-hint">如果是隐私模式或存储空间不足，换普通模式或清一点空间再试。</p>
      <button class="btn primary" id="retry">重试</button>
    </div>`;
  $('#retry').addEventListener('click', () => boot());
}

/* ============ 事件委托 ============ */
function bindEvents() {
  const app = $('#app');
  app.addEventListener('click', async (e) => {
    const t = e.target;

    const rateBtn = t.closest('button[data-rate]');
    if (rateBtn) {
      e.stopPropagation();
      rate(rateBtn.dataset.rate, Number(rateBtn.dataset.star));
      return;
    }
    const navEl = t.closest('[data-nav]');
    if (navEl) return go(navEl.dataset.nav);
    const delEl = t.closest('[data-del]');
    if (delEl) return removeItem(delEl.dataset.del);
    const stEl = t.closest('[data-status]');
    if (stEl) return setStatus(stEl.dataset.id, stEl.dataset.status);
    const edEl = t.closest('[data-edit]');
    if (edEl) return go('edit/' + edEl.dataset.edit);
    const tabEl = t.closest('[data-tab]');
    if (tabEl) {
      tab = tabEl.dataset.tab;
      return renderHome();
    }
    if (t.closest('[data-back]')) return back();
    const openEl = t.closest('[data-open]');
    if (openEl) return go('item/' + openEl.dataset.open);
  });
}

/* ============ 启动 ============ */
const onHome = () => {
  const h = location.hash.replace(/^#\/?/, '');
  return !h || h === 'home';
};

/** 旧分类一次性归并：2026-09-19 分类改成 数码/周边/家居/服饰/其他，
    老数据里的「书」等已移除的取值统一并到「其他」并落库。
    放在首次渲染之前跑，界面上不会先闪一下旧分类。幂等：并完就没得并了。 */
async function migrateCats() {
  const valid = new Set(CATS.map((c) => c.id));
  const bad = items.filter((i) => !valid.has(i.category));
  if (!bad.length) return;
  for (const it of bad) {
    it.category = 'other';
    try {
      await DB.putItem(it);
    } catch (e) {} // 个别失败不影响其他条目，下次启动会重试
  }
  await refresh();
}

/** 旧数据没有 photoThumb（早期版本把 1000px 大图直接塞进列表）：启动后在后台补生成，
    补完静默刷一次首页——列表图片体积从几 MB 掉到几十 KB，回首页才不卡。
    只在首页刷新，别打断用户正在填的表单。 */
async function backfillThumbs() {
  const need = items.filter((i) => i.photo && !i.photoThumb);
  if (!need.length) return;
  let changed = false;
  for (const it of need) {
    try {
      it.photoThumb = await makeThumb(it.photo);
      await DB.putItem(it);
      changed = true;
    } catch (e) {} // 个别图坏了不能拖垮其余
  }
  if (changed && onHome()) render();
}

async function boot() {
  loadSettings();
  applyTheme(); // 首帧脚本已经定过一次，这里再同步一遍（顺带处理设置页改完主题的情况）
  // navStack 不初始化：刷新/深链打开时它应该是空的，
  // 此时 in-app 返回用 location.replace 而不是 history.back
  try {
    await refresh();
    await migrateCats(); // 旧分类先并到「其他」，再渲染，避免界面闪旧值
    render();
    backfillThumbs(); // 不 await：后台补旧数据的小图，别拖慢开屏
  } catch (err) {
    renderError(err);
  }
}

/* 只有 hashchange 一个渲染入口（同饮记）。曾经挂过 popstate 再渲染一次去同步 navStack，
   结果同一次导航渲染两遍、首页重建两次；而且延后渲染会打断 iOS 系统右滑的转场快照。
   navStack 现在由 back()/finishTo() 自己 pop，跟饮记一样。 */
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  boot();
});
