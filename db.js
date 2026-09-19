'use strict';

/* ============================================================
   存储层：IndexedDB

   两个 store：
     items  —— 物品本身
     pulses —— 每一次打分（带时间戳）

   这个应用真正的价值在 pulses 这条时间序列上，所以它独立成表，
   不塞进 item 里：以后按时间查、按物品查都方便，也方便整条删。

   数据量很小（几百个物品 / 几千条打分），启动时全量读进内存，
   渲染一律基于内存快照，只有写操作才落库。
   ============================================================ */
const DB = (() => {
  const NAME = 'wish-db';
  const VER = 1;
  const ITEMS = 'items';
  const PULSES = 'pulses';
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(NAME, VER); // 隐私模式下访问 indexedDB 可能同步抛错
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ITEMS)) {
          db.createObjectStore(ITEMS, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains(PULSES)) {
          const p = db.createObjectStore(PULSES, { keyPath: 'id' });
          p.createIndex('itemId', 'itemId');
          p.createIndex('at', 'at');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
    // 失败就把缓存的 promise 清掉，下次调用重新尝试打开；
    // 否则一次失败会被永久记住，之后所有请求跟着一起失败
    dbp.catch(() => { dbp = null; });
    return dbp;
  }

  function store(name, mode) {
    return open().then((db) => db.transaction(name, mode).objectStore(name));
  }

  function wrap(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }

  function getAll(name) {
    return store(name, 'readonly').then((s) => wrap(s.getAll()));
  }

  return {
    /** 一次读全：物品按加入时间倒序，打分按时间正序（画曲线要用） */
    async snapshot() {
      const [items, pulses] = await Promise.all([getAll(ITEMS), getAll(PULSES)]);
      items.sort((a, b) => b.createdAt - a.createdAt);
      pulses.sort((a, b) => a.at - b.at);
      return { items, pulses };
    },

    putItem(item) {
      return store(ITEMS, 'readwrite').then((s) => wrap(s.put(item)));
    },

    /** 删物品时把它整条时间序列一起删掉，不留孤儿数据 */
    removeItem(id) {
      return open().then((db) => {
        const t = db.transaction([ITEMS, PULSES], 'readwrite');
        t.objectStore(ITEMS).delete(id);
        const cur = t.objectStore(PULSES).index('itemId').openKeyCursor(IDBKeyRange.only(id));
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          t.objectStore(PULSES).delete(c.primaryKey);
          c.continue();
        };
        return new Promise((res, rej) => {
          t.oncomplete = () => res();
          t.onerror = () => rej(t.error);
          t.onabort = () => rej(t.error || new Error('删除被中断'));
        });
      });
    },

    putPulse(p) {
      return store(PULSES, 'readwrite').then((s) => wrap(s.put(p)));
    },

    removePulse(id) {
      return store(PULSES, 'readwrite').then((s) => wrap(s.delete(id)));
    },
  };
})();
