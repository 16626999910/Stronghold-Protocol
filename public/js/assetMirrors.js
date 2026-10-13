// 素材镜像 (this build): the client's own files live on the game server (`/assets/**`, `/fonts/**`). This module lets
// those downloads fall back to one or more mirrors — another host / CDN serving the SAME tree — so a slow or down
// origin does not stall preloading or asset loading.
//
// The mirror list is served by the origin at `/data/asset-mirrors.json` (`{ "mirrors": ["https://…", …] }`, bases with
// no trailing slash; each serves `<base>/assets/…` and `<base>/fonts/…`). The list is empty by default: without the
// file (or with an empty list) every request goes straight to the origin, exactly as before.
//
// Mirrors are tried FIRST, in the order listed; the game's own server is the last resort, used only when every mirror
// fails (non-2xx, a network error, a timeout). Mirrors must send `Access-Control-Allow-Origin` (jsDelivr and
// raw.githubusercontent.com both do). With an empty list every request goes straight to the origin, as before.
//
// 严格镜像模式：`/data/asset-mirrors.json` 里 `{ "mirrors": […], "directFallback": false }` 时，主站**永不**作为候选
// ——`/assets`、`/fonts` 的下载只走镜像，镜像全挂就失败（不回落），因此对局期间不会有素材流量打到游戏服务器。
// main.js 的 `installStrictAssetFetch` 还会把走 `globalThis.fetch` 的加载器（PIXI 的 Spine 等）也一并导向镜像。
// 注意：严格模式下一个镜像都不可用时游戏会加载失败，务必保证镜像稳定（见 data/asset-mirrors.json 的说明）。

export const MIRRORS_URL = '/data/asset-mirrors.json';

// 内容哈希 (0.2.6 移植): the served manifest names `/assets/~<hash>/…` (shared/assetPaths.js). The mirror repositories
// only carry the plain paths, so mirror candidates strip the hash segment; the origin keeps the hashed one (the game
// server serves it and the browser may cache it for a year).
import { unhashedUrl } from '../../shared/assetPaths.js';

/** Default stall timeout (ms): a mirror that sends nothing for this long is dropped for the next candidate. */
export const STALL_MS = 15_000;
/** How long a stalled / failing mirror is demoted for (ms) before it is tried again. */
export const MIRROR_PENALTY_MS = 60_000;
/** How long `load()` waits for the startup probe before it lets downloads start on the configured order. */
export const PROBE_GRACE_MS = 1_500;

/** The error a stalled / timed-out attempt rejects with (the caller moves to the next candidate). */
export class StallError extends Error {
  constructor(message) { super(message); this.name = 'StallError'; }
}

/**
 * Fetch one URL with a stall guard: reject with a `StallError` when the response headers take longer than `stallMs`,
 * or when the body sends nothing for `stallMs`. The in-flight request is aborted either way.
 */
async function fetchWithStall(doFetch, url, init, stallMs) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(new StallError(`no response in ${stallMs} ms`)), stallMs);
  const outer = init && init.signal;
  const signal = outer && typeof AbortSignal !== 'undefined' && AbortSignal.any ? AbortSignal.any([outer, ctrl.signal]) : ctrl.signal;
  let res;
  try {
    res = await doFetch(url, { ...(init || {}), signal });
  } catch (e) {
    clearTimeout(timer);
    throw ctrl.signal.aborted && ctrl.signal.reason instanceof StallError ? ctrl.signal.reason : e;
  }
  if (!res || !res.ok || !res.body || typeof ReadableStream === 'undefined') { clearTimeout(timer); return res; }
  const reader = res.body.getReader();
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(new StallError(`body idle for ${stallMs} ms`)), stallMs); };
  const stream = new ReadableStream({
    start(c) { arm(); },
    async pull(c) {
      try {
        const { value, done } = await reader.read();
        if (done) { clearTimeout(timer); c.close(); return; }
        arm();
        c.enqueue(value);
      } catch (err) { clearTimeout(timer); c.error(err); }
    },
    cancel(reason) { clearTimeout(timer); try { ctrl.abort(reason); } catch { /* already aborted */ } },
  });
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Short display name of a mirror base (for the 预载资源 panel's 下载源 line). */
export function mirrorShortName(base) {
  for (const [re, name] of [[/cdn\.jsdelivr\.net/i, 'jsDelivr'], [/raw\.githubusercontent\.com/i, 'GitHub raw'], [/github\.com/i, 'GitHub']]) {
    if (re.test(String(base))) return name;
  }
  try { return new URL(String(base)).host; } catch { return String(base); }
}

/** Normalize a mirror base list: trim, drop blanks / non-http(s), strip a trailing slash, dedupe. @param {unknown} list */
export function normalizeMirrors(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Whether a URL is a site-root-relative path the mirror hosts actually serve (`/assets/**`, `/fonts/**`). The `/media/`
 * audio route and every absolute URL stay on the origin.
 */
export function isAssetPath(path) {
  return typeof path === 'string' && (path.startsWith('/assets/') || path.startsWith('/fonts/')) && !path.includes('..');
}

/**
 * Ordered download candidates for a path: every mirror + path first (in order), then the origin path last. A path
 * that is not a site-root asset (an absolute URL, a /media route, …) is returned alone.
 *
 * `direct = false` is the 严格镜像模式 (`data/asset-mirrors.json` `directFallback: false`): the origin is NEVER a
 * candidate — asset traffic must not touch the game server (its uplink is tiny). Asset paths then list the mirrors
 * only (an empty list when there are none — the caller fails rather than falling back), and a non-asset path (an
 * absolute URL, /media, …) yields an empty list too, because there is no mirror that serves it.
 * @param {string} path site-root-relative, e.g. '/assets/audio/bgm/x.mp3'
 * @param {string[]} mirrors normalized bases, e.g. ['https://cdn.example.com']
 * @param {boolean} [direct] allow the origin as the last candidate (default true)
 * @returns {string[]}
 */
export function mirrorCandidates(path, mirrors, direct = true) {
  if (!isAssetPath(path)) return direct ? [path] : [];
  // mirrors carry the plain paths; only the origin gets the content-hashed URL (unhashedUrl is a no-op without one)
  const plain = unhashedUrl(path);
  const list = (Array.isArray(mirrors) ? mirrors : []).map((m) => m + plain);
  return direct ? [...list, path] : list;
}

/** Probe one mirror: time a small file from it. Returns `{ base, ok, ms }` (ms = Infinity on failure). */
export async function probeMirror(base, { fetch: doFetch = (...a) => globalThis.fetch(...a), path = '/fonts/fonts.css', timeoutMs = 6000, now = () => (globalThis.performance && globalThis.performance.now ? globalThis.performance.now() : Date.now()) } = {}) {
  const t0 = now();
  try {
    const res = await doFetch(base + path, { cache: 'no-store', signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
    if (!res || !res.ok) return { base, ok: false, ms: Infinity };
    await res.arrayBuffer();
    return { base, ok: true, ms: now() - t0 };
  } catch {
    return { base, ok: false, ms: Infinity };
  }
}

/**
 * A mirror source: loads the list once, PROBES every mirror (a small file from each), pins the fastest one first and
 * keeps the rest as ordered fallbacks, then serves assets from the mirrors (fastest first), the origin last.
 * @param {{ url?: string, fetch?: typeof fetch, log?: object, probe?: boolean, probePath?: string,
 *           probeTimeoutMs?: number, directFallback?: boolean, now?: () => number }} [opts]
 */
export function createMirrorSource({
  url = MIRRORS_URL, fetch: doFetch = (...a) => globalThis.fetch(...a), log = console,
  probe = true, probePath = '/fonts/fonts.css', probeTimeoutMs = 6000,
  stallMs = STALL_MS, penaltyMs = MIRROR_PENALTY_MS, directFallback = true, probeGraceMs = PROBE_GRACE_MS,
  now = () => (globalThis.performance && globalThis.performance.now ? globalThis.performance.now() : Date.now()),
} = {}) {
  /** @type {string[]} */
  let mirrors = [];
  /** allow the origin as the last candidate? flipped by /data/asset-mirrors.json `directFallback` (see load()) */
  let direct = directFallback !== false;
  let promise = null;
  let loaded = false;
  const listeners = new Set();
  /** which source actually served each file (for the 预载资源 panel's 下载源 line) */
  const counts = new Map(); // label → files served
  let last = null;          // label of the most recent successful source
  let primary = null;       // the fastest mirror base (after the probe), or null
  let primaryMs = null;
  let probeResults = null;
  /** a mirror that stalled / failed is demoted until this time (ms), so the next file tries another one first */
  const penaltyUntil = new Map(); // base → epoch ms

  const labelOf = (url) => {
    const m = mirrors.find((b) => url.startsWith(b));
    return m ? mirrorShortName(m) : 'origin';
  };
  /** The mirror base a candidate URL belongs to, or null for the origin. */
  const baseOf = (u) => mirrors.find((b) => u.startsWith(b)) || null;
  /** Mirrors ordered good-first: a demoted (recently stalled) one moves behind the rest, keeping fastest-first order. */
  const orderMirrors = () => {
    const t = Date.now();
    return [...mirrors].sort((a, b) => (((penaltyUntil.get(a) || 0) > t ? 1 : 0) - ((penaltyUntil.get(b) || 0) > t ? 1 : 0)));
  };

  const notify = () => { for (const fn of [...listeners]) { try { fn(mirrors); } catch { /* a listener must not break loading */ } } };

  const load = () => promise || (promise = (async () => {
    try {
      const res = await doFetch(url, { cache: 'no-cache' });
      if (res && res.ok) {
        const json = await res.json();
        mirrors = normalizeMirrors(json && json.mirrors);
        if (json && json.directFallback === false) direct = false;
      }
    } catch { /* no config served → origin only */ }
    // 严格镜像模式但一个镜像都没配 → 直接放行主站，否则游戏会 100% 加载失败（宁可回落也不让玩家白屏）
    if (direct === false && mirrors.length === 0) { direct = true; log?.warn?.('[mirrors] directFallback=false 但没有配置任何镜像，已自动回退为主站兜底'); }
    loaded = true;
    notify(); // usable right away, in the configured order
    if (mirrors.length) log?.info?.(`[mirrors] ${mirrors.length} 个素材镜像：${mirrors.join(' , ')}`);
    // Run every mirror once, then pin the fastest: it is tried first from now on, the rest stay as fallbacks.
    if (probe && mirrors.length > 1) {
      const probing = (async () => {
        try {
          const results = await Promise.all(mirrors.map((base) => probeMirror(base, { fetch: doFetch, path: probePath, timeoutMs: probeTimeoutMs, now })));
          const ok = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
          const bad = results.filter((r) => !r.ok);
          probeResults = [...ok, ...bad];
          primary = ok.length ? ok[0].base : null;
          primaryMs = ok.length ? Math.round(ok[0].ms) : null;
          if (ok.length) mirrors = [...ok.map((r) => r.base), ...bad.map((r) => r.base)];
          log?.info?.(`[mirrors] 最快镜像：${primary ? `${mirrorShortName(primary)}（${primaryMs} ms）` : (direct ? '无（全部失败，改用主站）' : '无（全部失败，严格镜像模式：不回主站）')}`);
          notify();
        } catch { /* probing must never block downloads */ }
      })();
      // 不去等一个慢/挂的镜像把启动拦住（镜像越多越明显）：最多等 PROBE_GRACE_MS，按配置顺序先下，探测结果之后自己生效
      const grace = new Promise((r) => { const t = setTimeout(r, probeGraceMs); if (t && typeof t.unref === 'function') t.unref(); });
      await Promise.race([probing, grace]);
    }
    return mirrors;
  })());

  return {
    url,
    load,
    get: () => mirrors,
    isLoaded: () => loaded,
    subscribe(fn) {
      listeners.add(fn);
      if (promise) { try { fn(mirrors); } catch { /* ignore */ } }
      return () => listeners.delete(fn);
    },
    /** Whether the origin is still allowed as the last candidate (false = 严格镜像模式). */
    directFallback: () => direct,
    /** @param {string} path @returns {string[]} */
    candidates: (path) => mirrorCandidates(path, orderMirrors(), direct),
    /**
     * Fetch a site-root asset, trying each mirror then (unless 严格镜像模式) the origin. A mirror that stalls (no
     * response, or no body bytes, for `stallMs`) is aborted and demoted, and the NEXT mirror is tried; the origin is
     * reached only when every mirror fails — and never at all with `directFallback:false`. Returns the first ok
     * Response; when every source answers but none is ok, the last Response; when every request throws, the last error.
     * @param {string} path @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    async fetch(path, init) {
      await load();
      const urls = mirrorCandidates(path, orderMirrors(), direct);
      if (!urls.length) throw new Error(`no mirror serves ${path} (直连主站已禁用：请检查 data/asset-mirrors.json)`);
      let lastRes = null;
      let lastErr = null;
      for (const u of urls) {
        const base = baseOf(u);
        try {
          const res = base ? await fetchWithStall(doFetch, u, init, stallMs) : await doFetch(u, init);
          if (res && res.ok) {
            const label = labelOf(u);
            counts.set(label, (counts.get(label) || 0) + 1);
            last = label;
            return res;
          }
          lastRes = res;
        } catch (err) {
          lastErr = err;
          // 长时间没反应 / 出错：先把该镜像降级一段时间，后续优先走别的镜像（镜像全挂了才回主站）
          if (base) penaltyUntil.set(base, Date.now() + penaltyMs);
        }
      }
      if (lastRes) return lastRes;
      throw lastErr || new Error(`asset failed on every source: ${path}`);
    },
    /**
     * Which source served the downloads so far: `{ last, counts: [[label, n], …], primary, primaryMs, probe }`
     * ('origin' = the game's own server; `primary` = the pinned fastest mirror, from the probe).
     */
    stats: () => ({
      last,
      counts: [...counts.entries()],
      primary: primary ? mirrorShortName(primary) : null,
      primaryMs,
      probe: probeResults ? probeResults.map((r) => ({ name: mirrorShortName(r.base), ok: r.ok, ms: r.ok ? Math.round(r.ms) : null })) : null,
    }),
    resetStats: () => { counts.clear(); last = null; },
  };
}

/** The browser singleton (loaded by installAssetMirrors in main.js). */
export const assetMirrors = createMirrorSource();
