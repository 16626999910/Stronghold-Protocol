// 预载资源 (this build): the background downloader that fills the local cache (./store.js) with every asset of the
// manifest (./manifest.js).
//
// Shaped like the other long-lived browser services (public/js/battle/runner.js): a `create…` factory taking its
// dependencies (so Node tests run it against a memory store) plus a browser singleton installed by installPreload
// (public/js/main.js). The UI subscribes with `subscribe(fn)` and renders `state()`.
//
// Behaviour:
//   * a pool of `concurrency` workers (default 16, adjustable while running) pulls from the pending queue;
//   * every file the store already holds is skipped, so a reload continues where the last session stopped — and a NEW
//     BUILD keeps the old cache too: only what its manifest adds is fetched (URLs no longer listed are pruned);
//   * `pause()` lets the in-flight downloads finish and stops the pool; `resume()` restarts it;
//   * a failing file retries a few times, then counts as failed (the game falls back to the network for it) without
//     failing the run;
//   * `clear()` empties the store and resets the counters.
//
// Spine models and fonts are downloaded too — that warms the browser's own HTTP cache — but they are NOT served back
// from this store: pixi-spine resolves an atlas's page images relative to the .skel URL, which a blob: URL breaks
// (see ./cache.js). Everything else the game loads through assets.js / audio.js is served from here.

import { collectAssets, CATEGORIES, isRequired } from './manifest.js';

/** How many files are downloaded at once by default; the panel offers this as 下载并发. */
export const DEFAULT_CONCURRENCY = 16;
export const CONCURRENCY_OPTIONS = Object.freeze([4, 8, 16, 32]);
/**
 * 长时间不游玩 (this build): a local cache last visited longer ago than this is dropped on the next visit — so the
 * 「长时间不游玩，预载资源会自动删除。」 note is true and predictable (the browser would evict it under storage
 * pressure anyway). Lazy by necessity: nothing runs while the player is away, so the cleanup happens on the visit that
 * follows (that visit starts the download over). 0 / a negative value keeps the cache forever.
 */
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** Retries per file (a transient network error should not leave a hole in the cache). */
const RETRIES = 3;
const RETRY_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Required = the five 必需 categories (anything unclassified counts as required too). */
const requiredOf = (category) => category === 'other' || isRequired(category);

/**
 * Whether a store error means the device is out of storage — the browser's IndexedDB quota for this origin ran out
 * (phones hit this: the quota is shared with everything). Chrome/Edge word the write failure as 「内存不足 /
 * not enough memory」 (a LevelDB backend error, name often `AbortError`, not `QuotaExceededError`), so a plain
 * /quota/ test misses it and the run keeps hammering the store instead of stopping with a clear message.
 */
export const isQuotaError = (err) => /quota|memory|内存|存储/i.test(`${(err && err.name) || ''} ${(err && err.message) || ''}`);

/**
 * @param {{
 *   store: any, fetch?: typeof fetch, collect?: typeof collectAssets,
 *   concurrency?: number, retries?: number, retryMs?: number, now?: () => number,
 *   log?: { warn?: Function, info?: Function },
 * }} deps
 */
export function createPreloader({
  store,
  fetch: doFetch = (...a) => globalThis.fetch(...a),
  collect = collectAssets,
  concurrency = DEFAULT_CONCURRENCY,
  retries = RETRIES,
  retryMs = RETRY_MS,
  now = () => Date.now(),
  staleMs = STALE_AFTER_MS,
  log = console,
}) {
  const listeners = new Set();
  /** @type {{url:string, category:string}[]} */
  let files = [];
  /** url → stored byte size, for the files the store holds (seeded from the store, extended as we download). */
  let sizeOf = new Map();
  let queue = [];
  let manifestVersion = '';
  let aggregateBytes = 0;
  let bytesKnown = false;      // whether `aggregateBytes` came from the manifest (the reference's 总 MB)
  let running = false;
  let paused = false;
  let active = 0;
  let failed = 0;
  let failedUrls = [];
  let includeOptional = true;
  let speed = concurrency;
  let quota = false;           // the device ran out of storage: the run stopped (see snapshot().error)
  let quotaBytes = null;       // navigator.storage.estimate() quota for this origin (bytes), null when unavailable
  let usageBytes = null;       // the estimate's current usage (bytes)
  let generation = 0;          // bumped by refresh()/clear() so stale workers stop touching the counters

  /** Read the browser's storage estimate (IndexedDB quota/usage) so the panel can name the real limit. */
  async function refreshEstimate() {
    try {
      const est = globalThis.navigator?.storage?.estimate ? await globalThis.navigator.storage.estimate() : null;
      if (est && Number.isFinite(est.quota)) { quotaBytes = est.quota; usageBytes = Number.isFinite(est.usage) ? est.usage : null; }
    } catch { /* estimate is best-effort */ }
  }

  const has = (f) => sizeOf.has(f.url);

  const snapshot = () => {
    let done = 0, reqTotal = 0, reqDone = 0, optTotal = 0, optDone = 0, bytes = 0;
    const categories = Object.fromEntries(CATEGORIES.map((c) => [c.id, { done: 0, total: 0, bytes: 0 }]));
    for (const f of files) {
      const c = categories[f.category] || (categories[f.category] = { done: 0, total: 0, bytes: 0 });
      c.total++;
      const cached = has(f);
      const size = sizeOf.get(f.url) || 0;
      if (cached) { c.done++; c.bytes += size; done++; bytes += size; }
      if (requiredOf(f.category)) { reqTotal++; if (cached) reqDone++; } else { optTotal++; if (cached) optDone++; }
    }
    // 'done' once nothing is left to fetch — a file that failed all its retries counts as settled (the game falls back
    // to the network for it), so the panel never sits on 'running' forever
    const settled = files.length > 0 && done + failed >= files.length;
    return {
      status: paused && (running || active > 0) ? 'paused' : running ? 'running' : settled ? 'done' : 'idle',
      total: files.length,
      done,
      bytes,
      /** the manifest's own `stats.bytes` (known before any download), else null */
      aggregateBytes: bytesKnown ? aggregateBytes : null,
      required: { done: reqDone, total: reqTotal },
      optional: { done: optDone, total: optTotal },
      categories,
      failed,
      failedUrls: failedUrls.slice(0, 20),
      /** 'quota' when the device ran out of storage and the run stopped; anything already stored still works */
      error: quota ? 'quota' : null,
      /** the browser's storage estimate for this origin (bytes), null when unavailable — shows the panel the real limit */
      quotaBytes,
      usageBytes,
      concurrency: speed,
      includeOptional,
      active,
    };
  };

  const notify = () => {
    const s = snapshot();
    for (const fn of [...listeners]) { try { fn(s); } catch { /* a listener must not break the run */ } }
  };

  /** Adopt what the store already holds (after a reload, a clear, or a version change). */
  async function reseed() {
    sizeOf = new Map();
    try {
      for (const rec of (await store.list?.()) || []) if (rec && rec.url) sizeOf.set(rec.url, Number(rec.size) || 0);
    } catch { /* no store: everything is pending */ }
    buildQueue();
  }

  function buildQueue() {
    queue = files.filter((f) => (includeOptional || requiredOf(f.category)) && !has(f));
  }

  /**
   * 增量预载: after adopting the store, drop the entries the CURRENT manifest no longer lists (assets removed between
   * builds) so the cache tracks the manifest instead of growing forever — the kept URLs are what makes an update only
   * download its delta. Best-effort and scoped to our own /assets/ and /fonts/ URLs; errors never break the refresh.
   */
  async function pruneRemoved() {
    if (typeof store?.del !== 'function' || typeof store?.list !== 'function') return;
    const keep = new Set(files.map((f) => f.url));
    let removed = 0;
    try {
      for (const rec of (await store.list()) || []) {
        const url = rec && rec.url;
        if (!url || keep.has(url)) continue;
        if (!(url.startsWith('/assets/') || url.startsWith('/fonts/'))) continue;
        try { await store.del(url); sizeOf.delete(url); removed++; } catch { /* keep it */ }
      }
    } catch { /* no store / a read error: nothing pruned */ }
    if (removed) log?.info?.(`[preload] 已清理 ${removed} 个不再出现在清单里的旧文件（增量预载）`);
  }

  /**
   * 长时间不游玩: drop the whole cache when this browser last visited longer ago than `staleMs` — cleaned up lazily,
   * on the return visit (nothing runs while the player is away). The visit time is always recorded, so the next visit
   * compares against it. Errors never break the refresh.
   */
  async function expireIfStale() {
    if (!(staleMs > 0) || typeof store?.getMeta !== 'function' || typeof store?.setMeta !== 'function') return;
    const at = now();
    let seen = 0;
    try { seen = Number(await store.getMeta('seen')) || 0; } catch { return; }
    if (seen > 0 && at - seen > staleMs) {
      try {
        await store.clear?.();
        await store.setMeta('version', manifestVersion);
        log?.info?.('[preload] 长时间未游玩，已清空预载缓存（', Math.round((at - seen) / 86_400_000), '天）');
      } catch { /* keep going — a failed clear just leaves the old cache */ }
    }
    try { await store.setMeta('seen', at); } catch { /* ignore */ }
  }

  async function download(url) {
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await doFetch(url, { cache: 'no-cache' });
        if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`);
        return await res.blob();
      } catch (err) {
        lastErr = err;
        if (i < retries && running && !paused && generation === gen0()) await sleep(retryMs * (i + 1));
      }
    }
    throw lastErr || new Error('download failed');
  }
  const gen0 = () => generation;

  async function worker(gen) {
    while (running && !paused && gen === generation) {
      const f = queue.shift();
      if (!f) return;
      active++;
      try {
        const blob = await download(f.url);
        if (gen !== generation) return;
        await store.put(f.url, blob, { category: f.category, at: now() });
        sizeOf.set(f.url, blob.size);
        notify();
      } catch (err) {
        if (gen !== generation) return;
        if (isQuotaError(err)) {
          // out of storage (a phone's quota is shared with everything): stop the run, keep what is already stored
          quota = true;
          running = false;
          paused = false;
          queue = [];
          log.warn?.('[preload] out of storage — stopping (what is cached stays usable)');
          notify();
          return;
        }
        failed++;
        if (failedUrls.length < 20) failedUrls.push(f.url);
        log.warn?.(`[preload] ${f.url}: ${(err && err.message) || err}`);
        notify();
      } finally { active--; }
    }
  }

  function pump() {
    if (!running || paused) return;
    const gen = generation;
    const wanted = Math.max(1, speed) - active;
    for (let i = 0; i < wanted; i++) {
      worker(gen).then(() => {
        if (gen !== generation) return;
        if (running && !paused && active === 0 && queue.length === 0) { running = false; notify(); }
      });
    }
  }

  return {
    /** (Re)build the plan from a manifest. `local` = the optional local-client art manifest. */
    async refresh({ manifest = null, local = null, manifestVersion: v = '' } = {}) {
      generation++;
      running = false;
      paused = false;
      active = 0;
      failed = 0;
      failedUrls = [];
      quota = false;
      manifestVersion = v || (manifest && typeof manifest === 'object' && manifest.hash) || '';
      const collected = collect(manifest, { extra: local ? [local] : [] });
      files = collected.files;
      aggregateBytes = collected.bytes;
      bytesKnown = collected.bytes > 0;
      await store.ready?.(manifestVersion);
      await expireIfStale();
      await reseed();
      await pruneRemoved();
      await refreshEstimate();
      notify();
      return snapshot();
    },
    /** Start (or continue). `includeOptional` decides whether the optional categories are queued. */
    start({ includeOptional: inc } = {}) {
      if (inc !== undefined) includeOptional = !!inc;
      quota = false;
      buildQueue();
      if (running) { notify(); return; }
      // pre-flight: the browser's storage quota for this origin (IndexedDB). The remaining plan cannot fit in the free
      // space → stop with the 'quota' message instead of hammering the store (whose own error reads as「内存不足」).
      if (bytesKnown && quotaBytes != null) {
        let stored = 0;
        for (const b of sizeOf.values()) stored += b;
        const remaining = Math.max(0, aggregateBytes - stored);
        const free = Math.max(0, quotaBytes - (usageBytes || 0));
        if (remaining > free) {
          quota = true;
          running = false;
          paused = false;
          queue = [];
          log.warn?.(`[preload] plan ${(remaining / 1048576).toFixed(0)} MB > free storage ${(free / 1048576).toFixed(0)} MB — stopping`);
          notify();
          return;
        }
      }
      running = true;
      paused = false;
      pump();
      notify();
    },
    pause() { paused = true; notify(); },
    resume() {
      quota = false;
      if (queue.length === 0) buildQueue();
      paused = false;
      running = true;
      pump();
      notify();
    },
    /** Empty the store and start over (the counters follow). */
    async clear() {
      generation++;
      running = false;
      paused = false;
      active = 0;
      await store.clear?.();
      sizeOf = new Map();
      failed = 0;
      failedUrls = [];
      quota = false;
      queue = [];
      notify();
    },
    setConcurrency(n) {
      speed = Math.max(1, Math.min(64, Math.trunc(n) || DEFAULT_CONCURRENCY));
      if (running && !paused) pump();
      notify();
    },
    setIncludeOptional(on) { includeOptional = !!on; if (!running) buildQueue(); notify(); },
    state: snapshot,
    subscribe(fn) { if (typeof fn !== 'function') return () => {}; listeners.add(fn); return () => listeners.delete(fn); },
    /** The blob of a cached asset (the loaders in ./cache.js read through this), else null. */
    blobFor: (url) => (sizeOf.has(url) ? store.get(url) : Promise.resolve(null)),
    /** URLs the store holds (for tests / diagnostics). */
    cachedUrls: () => [...sizeOf.keys()],
    get count() { return files.length; },
    get manifestVersion() { return manifestVersion; },
  };
}

/** The browser singleton (`installPreload`, public/js/main.js), or null before boot. */
export let preloader = null;
export function setPreloader(p) { preloader = p; }
