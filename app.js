'use strict';

/* ============================================================
   种草 —— 记录想买但不会马上买的东西，随时给渴望度打分

   核心不是清单，是那条曲线：每次打分都存一条带时间戳的记录，
   攒出来的走势能区分「一时上头」和「真的想要」。
   ============================================================ */

/* ============ 常量 ============ */
const CATS = [
  { id: 'digital', label: '数码' },
  { id: 'clothes', label: '服饰' },
  { id: 'home', label: '家居' },
  { id: 'book', label: '书' },
  { id: 'other', label: '其他' },
];
const CAT_LABEL = Object.fromEntries(CATS.map((c) => [c.id, c.label]));
const normCat = (c) => (CAT_LABEL[c] ? c : 'other');

const DAY = 86400000;
const STALE_DAYS = 7;  // 超过这个天数没复评 → 进批量复评
const COOL_SCORE = 40; // 热度到 2★ 及以下 → 视为已冷却

const TABS = [
  { id: 'wish', label: '种草中' },
  { id: 'bought', label: '已入手' },
  { id: 'dropped', label: '已放下' },
];

/* ============ 状态 ============ */
let items = [];
let pulsesByItem = Object.create(null);
let tab = 'wish';

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
const isStale = (it) => it.status === 'wish' && sinceLast(it) > STALE_DAYS * DAY;
/** 与首次打分的差值：正数=越想越想要，负数=在冷下来 */
const deltaOf = (it) => {
  const p = pulsesOf(it.id);
  return p.length < 2 ? 0 : p[p.length - 1].score - p[0].score;
};
const isCooled = (it) => it.status === 'wish' && heatOf(it) <= COOL_SCORE;

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
  if (it.photo) return `<img class="thumb" src="${esc(it.photo)}" alt="" />`;
  return `<div class="thumb thumb-ph">${esc((it.name || '?').trim().slice(0, 1))}</div>`;
}

function reviewBarHtml() {
  const n = items.filter((i) => i.status === 'wish' && isStale(i)).length;
  if (!n) return '';
  return `<button class="review-bar" data-nav="review">
      <span>${n} 件超过 ${STALE_DAYS} 天没复评</span>
      <span class="rb-go">去打分 ›</span>
    </button>`;
}

/** 打分后单独刷新提醒条，不用整页重渲染 */
function updateReviewBar() {
  const html = reviewBarHtml();
  const bar = $('.review-bar');
  if (bar) {
    if (html) bar.outerHTML = html;
    else bar.remove();
  } else if (html) {
    const tabs = $('.tabs');
    if (tabs) tabs.insertAdjacentHTML('beforebegin', html);
  }
}

function cardHtml(it) {
  const delta = deltaOf(it);
  const cooled = isCooled(it);
  const color = delta > 0 ? 'var(--up)' : 'var(--cool)';
  const meta = [`${ageDays(it)}天`];
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
      <button class="icon-btn" data-nav="add" aria-label="添加">+</button>
    </header>

    <div class="metrics">
      <div class="metric"><div class="m-label">种草中</div><div class="m-val">${wish.length}</div></div>
      <div class="metric"><div class="m-label">忍住了</div><div class="m-val">${money(saved)}</div></div>
      <div class="metric"><div class="m-label">已入手</div><div class="m-val">${money(spent)}</div></div>
    </div>

    ${reviewBarHtml()}

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

/* ============ 页面：详情 ============ */
function renderItem(id) {
  const app = $('#app');
  const it = items.find((i) => i.id === id);
  if (!it) {
    go('home');
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

    ${it.photo ? `<div class="hero"><img src="${esc(it.photo)}" alt="" /></div>` : ''}

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
let formPhoto = null; // 待保存的图（dataURL）
let formPhotoDirty = false;

function renderForm(id) {
  const app = $('#app');
  const it = id ? items.find((i) => i.id === id) : null;
  formPhoto = it ? it.photo || null : null;
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

      <details class="more"${it ? ' open' : ''}>
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
        if (formPhotoDirty) it.photo = formPhoto;
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
      go(it ? 'item/' + it.id : 'home');
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
      const dataUrl = await compressImage(file);
      formPhoto = dataUrl;
      formPhotoDirty = true;
      $('#photo-preview').innerHTML = `<img src="${esc(dataUrl)}" alt="" />`;
    } catch (err) {
      toast('图片处理失败');
    }
  });

  $('#photo-clear').addEventListener('click', () => {
    formPhoto = null;
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
      const max = 1000;
      let w = img.width;
      let h = img.height;
      const scale = Math.min(1, max / Math.max(w, h));
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片读取失败'));
    };
    img.src = url;
  });
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
    const onReview = location.hash.replace(/^#\/?/, '').split('/')[0] === 'review';
    const card = document.querySelector('.card[data-open="' + id + '"]');
    const fresh = items.find((i) => i.id === id);
    if (!onReview && card && fresh) {
      card.outerHTML = cardHtml(fresh);
      updateReviewBar();
    } else {
      render(); // 复评页要的是"打完就移出列表"，该重排就重排
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
  go('home');
}

/* ============ 路由 ============ */
let canBack = false; // 本次会话是否发生过站内前进
function go(hash) {
  canBack = true;
  location.hash = '#/' + hash;
}
function back() {
  // 有上一页就正常返回；直接停在子页面刷新过的话，跳回首页，免得一路退出应用
  if (canBack) {
    canBack = false;
    history.back();
  } else {
    location.hash = '#/home';
  }
}

function render() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, arg] = raw.split('/');
  if (name === 'add') return renderForm(null);
  if (name === 'edit' && arg) return renderForm(arg);
  if (name === 'item' && arg) return renderItem(arg);
  if (name === 'review') return renderReview();
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
async function boot() {
  try {
    await refresh();
    render();
  } catch (err) {
    renderError(err);
  }
}

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  boot();
});
