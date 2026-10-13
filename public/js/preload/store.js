// 预载资源 (this build): the persistent local cache of preloaded assets.
//
// `http://IP` is not a secure context, so neither a Service Worker nor Cache Storage (`caches`) is available — the only
// persistent store a browser gives us there is **IndexedDB**, holding the file bytes as Blobs. The game reads them back
// through the small resolver in ./cache.js.
//
// Two object stores: `files` (key = the manifest URL, value { url, blob, size, category, at }) and `meta`
// (key/value; `version` = the asset manifest's `hash`). A new build does NOT drop the cache: the files are kept and
// only what the new manifest adds is fetched (the preloader prunes URLs it no longer lists) — so an update downloads
// just the delta instead of everything.
//
// The IndexedDB handle is injectable: Node tests pass `createMemoryStore()` and exercise the same API with no browser.

/** In-memory implementation of the store API (tests, and a fallback when IndexedDB is unavailable). */
export function createMemoryStore() {
  const files = new Map();
  const meta = new Map();
  return {
    /** Same contract as the IndexedDB store: adopt the manifest version but KEEP the cached files (incremental). */
    async ready(manifestVersion = '') {
      if (manifestVersion) meta.set('version', manifestVersion);
      return true;
    },
    async get(url) { return files.get(url)?.blob ?? null; },
    async has(url) { return files.has(url); },
    async put(url, blob, info = {}) {
      files.set(url, { url, blob, size: blob?.size ?? 0, category: info.category ?? null, at: 0 });
    },
    async del(url) { files.delete(url); },
    async clear() { files.clear(); meta.clear(); },
    async stats() {
      let bytes = 0;
      for (const f of files.values()) bytes += f.size;
      return { count: files.size, bytes };
    },
    async list() { return [...files.values()]; },
    async getMeta(k) { return meta.get(k) ?? null; },
    async setMeta(k, v) { meta.set(k, v); },
  };
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error || new Error('indexedDB request failed'));
});

/**
 * The IndexedDB-backed store. `idb` defaults to `globalThis.indexedDB`; without one (Node, or a browser that blocked
 * it) `ready()` resolves false and every read misses — the game then simply stays on the network path.
 * @param {{ idb?: IDBFactory|null, name?: string, version?: number, manifestVersion?: string }} [opts]
 */
export function createStore({ idb = globalThis.indexedDB, name = 'sp-preload', version = 1 } = {}) {
  let db = null;
  let opening = null;

  const open = () => {
    if (!opening) {
      opening = new Promise((resolve) => {
        if (!idb || typeof idb.open !== 'function') { resolve(null); return; }
        let r;
        try { r = idb.open(name, version); } catch { resolve(null); return; }
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'url' });
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.onblocked = () => resolve(null);
      });
    }
    return opening;
  };

  const tx = async (stores, mode, fn) => {
    const d = await open();
    if (!d) return null;
    try {
      return await new Promise((resolve, reject) => {
        const t = d.transaction(stores, mode);
        let out;
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error || new Error('indexedDB transaction failed'));
        t.onabort = () => reject(t.error || new Error('indexedDB transaction aborted'));
        out = fn(t);
      });
    } catch { return null; }
  };

  return {
    /**
     * Open the database and adopt `manifestVersion` (the asset manifest's `hash`) — **incremental**: the cached files
     * are KEPT across builds, so an update downloads only what it adds (the preloader prunes the URLs the new manifest
     * no longer lists). `clear()` is still there for an explicit reset.
     * @param {string} [manifestVersion]
     */
    async ready(manifestVersion = '') {
      const d = await open();
      if (!d) return false;
      if (manifestVersion) await this.setMeta('version', manifestVersion);
      return true;
    },
    async get(url) {
      const d = await open();
      if (!d) return null;
      const rec = await req(d.transaction('files', 'readonly').objectStore('files').get(url));
      return rec ? rec.blob : null;
    },
    async has(url) {
      const d = await open();
      if (!d) return false;
      const k = await req(d.transaction('files', 'readonly').objectStore('files').getKey(url));
      return k !== undefined;
    },
    /**
     * Store one file. Throws on failure — a phone that ran out of quota must stop the run (the service reads the
     * error's name), never silently drop files.
     */
    async put(url, blob, info = {}) {
      const d = await open();
      if (!d) throw new Error('indexedDB unavailable');
      await new Promise((resolve, reject) => {
        let t;
        try { t = d.transaction('files', 'readwrite'); } catch (err) { reject(err); return; }
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error || new Error('put failed'));
        t.onabort = () => reject(t.error || new Error('put aborted'));
        t.objectStore('files').put({ url, blob, size: blob?.size ?? 0, category: info.category ?? null, at: info.at ?? 0 });
      });
    },
    async del(url) { await tx(['files'], 'readwrite', (t) => { t.objectStore('files').delete(url); }); },
    async clear() {
      await tx(['files', 'meta'], 'readwrite', (t) => { t.objectStore('files').clear(); t.objectStore('meta').clear(); });
    },
    async stats() {
      const rows = await this.list();
      let bytes = 0;
      for (const f of rows) bytes += f.size || 0;
      return { count: rows.length, bytes };
    },
    /**
     * The metadata of every stored file (`{ url, size, category, at }`) — the seed the service adopts on boot.
     * A cursor, one record at a time: `getAll()` would materialize every Blob at once (ordering of a gigabyte), which
     * on a real cache fails outright and made a reload re-download everything (the bug this replaces).
     */
    async list() {
      const d = await open();
      if (!d) return [];
      const out = [];
      try {
        await new Promise((resolve, reject) => {
          const t = d.transaction('files', 'readonly');
          const cur = t.objectStore('files').openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) { resolve(); return; }
            const v = c.value || {};
            out.push({ url: v.url, size: v.size || 0, category: v.category ?? null, at: v.at ?? 0 });
            c.continue();
          };
          cur.onerror = () => reject(cur.error || new Error('cursor failed'));
          t.onabort = () => reject(t.error || new Error('list aborted'));
        });
      } catch { return []; }
      return out;
    },
    async getMeta(k) {
      const d = await open();
      if (!d) return null;
      const v = await req(d.transaction('meta', 'readonly').objectStore('meta').get(k));
      return v === undefined ? null : v;
    },
    async setMeta(k, v) { await tx(['meta'], 'readwrite', (t) => { t.objectStore('meta').put(v, k); }); },
  };
}
