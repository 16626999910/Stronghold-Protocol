// 预载资源 (this build): the UI over the preloader (public/js/preload/service.js) —
//   * `PreloadWidget` — the compact panel pinned to the BOTTOM-RIGHT of the title / lobby screen (progress, 继续/暂停,
//     清空, 关闭面板; the title row opens the manager);
//   * `PreloadModal`  — 预载资源管理: the required / optional cards with per-category progress, the 下载并发 picker and
//     the 同时预载 optional toggle;
//   * `installPreload()` — boot wiring (called by public/js/main.js): builds the store + service, installs the cache
//     read side the asset loaders consult (preload/cache.js) and starts the run in the background.
//
// Follows the GuideHost / LoadoutHost pattern: a module store screens subscribe to, plus a host component mounted once.
//
// Preloading never blocks anything: the lobby is fully usable while the download runs, and a reload continues where the
// last session stopped (the store holds what already arrived).

import { useState, useEffect, useMemo } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, Modal, confirmDialog } from './components.js';
import { createStore, useStore, loadPref, savePref } from '../store.js';
import { data } from '../data.js';
import { assets } from '../assets.js';
import { createStore as createIdbStore } from '../preload/store.js';
import { createPreloader, setPreloader, CONCURRENCY_OPTIONS, DEFAULT_CONCURRENCY } from '../preload/service.js';
import { assetMirrors } from '../assetMirrors.js';

import { setAssetCache } from '../preload/cache.js';
import { CATEGORIES } from '../preload/manifest.js';
import { detectFeatures } from './device.js';
import { t, N_ } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** Category labels as msgids (the Chinese text is the i18n key). */
const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, N_(c.key)]));
const REQUIRED = CATEGORIES.filter((c) => c.required).map((c) => c.id);

/** '52.6 MB' — the panel's own size format (1024-based, one decimal from MB up). */
export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

/** Percentage 0–100 of `done/total` (0 when the plan is empty). */
export function pctOf(done, total) {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/**
 * The size line's numbers: `{ bytes, total }` where `total` is the manifest's own estimate only while it still covers
 * what was actually downloaded. `data/assets.json`'s `stats.bytes` is a stale undercount for this build (it says
 * 463.8 MB while the shipped files are 693 MB), so it is never shown as a smaller total than the real figure —
 * better a bare "已存 693.2 MB" than "693.2 MB / 463.8 MB".
 * @param {{ bytes?: number, aggregateBytes?: number }|null} s a preloader snapshot
 */
export function bytePair(s) {
  const bytes = Math.max(0, Number(s?.bytes) || 0);
  const agg = Math.max(0, Number(s?.aggregateBytes) || 0);
  return { bytes, total: agg > bytes ? agg : bytes };
}

/** '693.2 MB' or '52.6 MB / 693.2 MB' (see bytePair). */
export function byteText(s) {
  const { bytes, total } = bytePair(s);
  return total > bytes ? `${fmtBytes(bytes)} / ${fmtBytes(total)}` : fmtBytes(bytes);
}

/**
 * UI state: the widget/manager visibility, the last preloader snapshot, and the boot-time device facts the panel's
 * hints key off (`touch`: a phone; `autoBlocked`: the connection is metered / saving data, so nothing auto-started).
 */
export const preloadStore = createStore({ open: false, hidden: false, state: null, installed: false, touch: false, autoBlocked: false });

export const openPreload = () => preloadStore.set({ open: true, hidden: false });
export const closePreload = () => preloadStore.set({ open: false });
const hideWidget = () => preloadStore.set({ hidden: true, open: false });

/**
 * 下载源 (素材镜像): which source served the downloads so far — the most recent one plus a per-source count. 'origin'
 * is the game's own server; everything else is a mirror host. Empty until something has been downloaded.
 */
export function sourceSummary() {
  const { counts, primary } = assetMirrors.stats();
  const label = (k) => (k === 'origin' ? t('主站') : k);
  if (!counts.length) return primary ? `${primary}（${t('最快')}）` : '—'; // before the first file: which mirror is pinned
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${label(k)} ${n}`).join(' · ');
}

/** The status word of a snapshot (the widget's right-hand chip). */
export function statusLabel(s) {
  if (!s || !s.total) return t('未开始');
  if (s.error === 'quota') return t('存储空间不足');
  if (s.status === 'paused') return t('已暂停');
  if (s.status === 'running') return t('下载中');
  if (s.status === 'done') return t('已完成');
  return t('未开始');
}

/** The primary action's label: nothing stored yet → 开始预载, otherwise 继续下载 / 已完成. */
export function primaryLabel(s) {
  if (!s || s.status === 'done') return t('已完成');
  return s.done > 0 ? t('继续下载') : t('开始预载');
}

// ---- device / network defaults (phone-friendly) ------------------------------------------------------

/**
 * Whether a page may start downloading on its own. A phone on a metered or slow link must not begin a 693 MB
 * download by itself: `saveData` (省流模式) wins, and so do 2G/3G and a cellular connection.
 * @param {{ saveData?: boolean, effectiveType?: string, type?: string }|null} conn `navigator.connection`
 */
export function autoPreloadAllowed(conn = null) {
  if (!conn || typeof conn !== 'object') return true;
  if (conn.saveData === true) return false;
  const t = String(conn.effectiveType || '');
  if (t === 'slow-2g' || t === '2g' || t === '3g') return false;
  if (String(conn.type || '') === 'cellular') return false;
  return true;
}

/**
 * Downloads to run at once. A phone's browser only keeps ~6 connections to one host, so 16 parallel requests there
 * queue up, drain the battery and slow everything else down — 4 is plenty.
 * @param {{ coarse?: boolean, fine?: boolean }|null} features detectFeatures()
 */
export function preloadConcurrency(features = null) {
  return features && features.coarse && !features.fine ? 4 : DEFAULT_CONCURRENCY;
}

/** A phone / tablet (a coarse pointer and no fine one) — the touch targets and defaults below key off this. */
const isTouchOnly = (features) => !!(features && features.coarse && !features.fine);

// ---- install (boot) ---------------------------------------------------------------------------------

/** Preferences: auto-start, whether the optional assets are included, and the chosen concurrency. */
const PREF = 'preload.auto';
const PREF_OPTIONAL = 'preload.optional';
const PREF_CONCURRENCY = 'preload.concurrency';

let installed = null;

/**
 * Boot the preloader: build the IndexedDB store + service, install the read side for the asset loaders, then plan from
 * the asset manifest (waiting for it when it is not loaded yet) and, unless the player turned 自动预载 off, start.
 * Idempotent — a second call returns the same service.
 */
export async function installPreload() {
  if (installed) return installed;
  const features = detectFeatures();
  const touch = isTouchOnly(features);
  const conn = (typeof navigator !== 'undefined' && navigator.connection) || null;
  const autoOk = autoPreloadAllowed(conn);
  const store = createIdbStore({ name: 'sp-preload' });
  const service = createPreloader({
    store,
    // 素材镜像 (this build): every download tries the origin first, then the mirrors in /data/asset-mirrors.json
    fetch: (url, init) => assetMirrors.fetch(url, init),
    // a phone defaults to fewer connections and to the REQUIRED assets only (Spine 等 393 MB 留给 Wi-Fi 或手动)
    concurrency: loadPref(PREF_CONCURRENCY, preloadConcurrency(features)),
  });
  service.setIncludeOptional(loadPref(PREF_OPTIONAL, !touch));
  installed = service;
  setPreloader(service);
  setAssetCache(service);
  preloadStore.set({ installed: true });
  service.subscribe((state) => preloadStore.set({ state, installed: true }));

  const plan = async () => {
    let manifest = data.get('assets') || assets.manifest || null;
    if (!manifest) {
      // cold load: the asset store fetches /data/assets.json itself (the data store may still be loading it)
      try { await assets.ready(); } catch { /* the change listener below retries */ }
      manifest = data.get('assets') || assets.manifest || null;
    }
    if (!manifest) return false;
    await service.refresh({
      manifest,
      local: data.get('local') || null,
      manifestVersion: (manifest && manifest.hash) || '',
    });
    preloadStore.set({ state: service.state() });
    return true;
  };
  if (!(await plan())) {
    // the manifest is not in yet (a cold load): plan as soon as it arrives; the lobby is usable meanwhile
    const off = assets.onChange(() => { plan().then((ok) => { if (ok) off?.(); }); });
    data.load('assets').catch(() => {});
  }
  // a phone does not start by itself (the player presses 继续下载), and a metered / slow link never does
  preloadStore.set({ autoBlocked: !autoOk, touch });
  if (loadPref(PREF, !touch) && autoOk) service.start();
  return service;
}

/** The current service (null before installPreload ran). */
export const preloadService = () => installed;

// ---- the widget -------------------------------------------------------------------------------------

/**
 * Bottom-right preload panel (title / lobby screens). Collapsed it is a one-line strip; expanded it shows the progress
 * and the actions. Returns null until a plan exists (nothing to say on a page the manifest never reached).
 */
export function PreloadWidget() {
  const { hidden, state, autoBlocked } = useStore(
    (s) => ({ hidden: s.hidden, state: s.state, autoBlocked: s.autoBlocked }),
    (a, b) => a.hidden === b.hidden && a.state === b.state && a.autoBlocked === b.autoBlocked,
    preloadStore,
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(() => loadPref(PREF, true));
  const s = state;
  if (hidden || !s || !s.total) return null;

  const pct = pctOf(s.done, s.total);
  const requiredPct = pctOf(s.required.done, s.required.total);
  const running = s.status === 'running';
  const paused = s.status === 'paused';
  const starts = running ? t('正在后台下载，关闭此面板不会停止。')
    : paused ? t('已暂停，可继续下载或清空缓存。')
      : autoBlocked ? t('检测到省流或移动网络，已暂停自动预载。')
        : t('提前把对局素材存到本机，进入战斗不再等待下载。');
  const quotaFree = s.quotaBytes != null ? Math.max(0, s.quotaBytes - (s.usageBytes || 0)) : null;
  const hint = s.error === 'quota'
    ? t('浏览器的本地存储（磁盘）空间不足，预载已停止——这不是电脑内存。已下载的部分仍可使用；清理浏览器存储、或换用空间更大的磁盘后再继续。')
    : starts;

  return html`<div class=${cx('preload', open && 'is-open', running && 'is-running')} data-testid="preload-widget">
    <button type="button" class="preload__bar" onClick=${() => setOpen((v) => !v)} aria-expanded=${open ? 'true' : 'false'}
      title=${t('提前把对局素材存到本机，进入战斗不再等待下载')}>
      <${Icon} name="download" class="preload__ico" />
      <span class="preload__name">${t('预载资源')}<${MicroLabel}>PRELOAD<//></span>
      <span class=${cx('preload__pct', 'num', running && 'is-live')}>${pct}%</span>
      <span class=${cx('preload__chip', `is-${s.error === 'quota' ? 'error' : s.status}`)}>${statusLabel(s)}</span>
      <${Icon} name=${open ? 'chevronDown' : 'chevronUp'} class="preload__caret" />
    </button>
    ${open ? html`<div class="preload__panel">
      <p class=${cx('preload__hint', s.error === 'quota' && 'is-warn')}>${hint}</p>
      <p class="preload__note">${t('长时间不游玩，预载资源会自动删除。')}</p>
      <div class="preload__lines">
        <span class="preload__line"><i>${t('必需')}</i><b class="num">${s.required.done}/${s.required.total}</b></span>
        <span class="preload__line"><i>${t('全部')}</i><b class="num">${s.done}/${s.total}</b></span>
        ${quotaFree != null ? html`<span class="preload__line"><i>${t('本机可用')}</i><b class="num">${fmtBytes(quotaFree)}</b></span>` : null}
        <span class="preload__line preload__line--bytes"><i>${t('体积')}</i><b class="num">${byteText(s)}</b></span>
        <span class="preload__line preload__line--bytes"><i>${t('下载源')}</i><b class="preload__src">${sourceSummary()}</b></span>
      </div>
      <div class="preload__track" role="progressbar" aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100">
        <i style=${`width:${pct}%`}></i>
        <u style=${`width:${requiredPct}%`}></u>
      </div>
      <div class="preload__acts">
        ${running
          ? html`<${Button} size="sm" variant="secondary" icon="pause" onClick=${() => s && installed?.pause()}>${t('暂停下载')}<//>`
          : html`<${Button} size="sm" variant="primary" icon="download" disabled=${s.status === 'done'}
              onClick=${() => { installed?.resume(); }}>${primaryLabel(s)}<//>`}
        <${Button} size="sm" variant="ghost" onClick=${() => openPreload()}>${t('资源管理')}<//>
        <${Button} size="sm" variant="ghost" disabled=${busy} onClick=${async () => {
          const ok = await confirmDialog({
            title: t('清空缓存'),
            text: t('清空已预载的本地资源？下次进入相关画面需要重新下载。'),
            okText: t('清空'),
            danger: true,
          });
          if (!ok) return;
          setBusy(true);
          await installed?.clear();
          setBusy(false);
        }}>${t('清空缓存')}<//>
      </div>
      <div class="preload__foot">
        <label class="preload__auto">
          <input type="checkbox" checked=${auto} onChange=${(e) => {
            const on = e.target.checked;
            setAuto(on);
            savePref(PREF, on);
            if (on && !autoBlocked) installed?.start(); // turning it on starts the run right away
          }} />
          <span>${t('以后自动预载')}</span>
        </label>
        <button type="button" class="preload__close" onClick=${hideWidget}>${t('关闭面板')}</button>
      </div>
    </div>` : null}
  </div>`;
}

// ---- the manager dialog -----------------------------------------------------------------------------

/** One progress line of a category (`背景音乐  5/19 个文件  26.9 MB`). */
function CatRow({ id, cat }) {
  const pct = pctOf(cat.done, cat.total);
  return html`<li class="precat" data-testid=${`precat-${id}`}>
    <span class="precat__name">${t(CATEGORY_LABEL[id] || id)}</span>
    <span class="precat__n num">${cat.done}/${cat.total}</span>
    <span class="precat__bar"><i style=${`width:${pct}%`}></i></span>
    <span class="precat__bytes num">${cat.bytes ? fmtBytes(cat.bytes) : '—'}${cat.total && !cat.done ? '' : ''}</span>
  </li>`;
}

/** 预载资源管理. Mounted once (PreloadHost). */
export function PreloadModal() {
  const open = useStore((s) => s.open, Object.is, preloadStore);
  const state = useStore((s) => s.state, Object.is, preloadStore);
  const touch = useStore((s) => s.touch, Object.is, preloadStore);
  const [auto, setAuto] = useState(() => loadPref(PREF, true));
  const s = state;
  const cats = useMemo(() => (s ? s.categories : {}), [s]);
  if (!open) return null;
  const svc = installed;
  const running = !!s && s.status === 'running';
  const rowOf = (ids) => ids.filter((id) => cats[id] && cats[id].total > 0);

  return html`<${Modal} open=${open} onClose=${closePreload} width="min(11.6rem, 94vw)"
      title=${t('预载资源管理')} micro="RESOURCE MANAGER" class="preload-modal"
      actions=${html`
        ${running
          ? html`<${Button} variant="secondary" icon="pause" onClick=${() => svc?.pause()}>${t('暂停下载')}<//>`
          : html`<${Button} variant="primary" icon="download" disabled=${!s || s.status === 'done'} onClick=${() => svc?.resume()}>${primaryLabel(s)}<//>`}
        <${Button} variant="ghost" onClick=${closePreload}>${t('关闭')}<//>`}>
    <p class="preload-modal__hint">${t('先预载必需资源；可选资源可勾选预载。关闭此窗口后，下载会在后台继续。')}</p>
    <p class="preload-modal__hint preload-modal__hint--inline">${t('下载源')}：${sourceSummary()}</p>
    ${touch ? html`<p class="preload-modal__hint preload-modal__hint--mob">${t('手机浏览器长期不用时可能清理本站缓存；添加到主屏幕更稳妥。')}</p>` : null}
    <div class="preload-modal__grid">
      <section class="precard precard--req">
        <header><h3>${t('必需资源')}</h3><span class="precard__tag">REQUIRED</span></header>
        <div class="precard__total">
          <span class="num">${s ? `${s.required.done}/${s.required.total}` : '—'} ${t('个文件')}</span>
          <span class="num">${s ? `${t('已存')} ${byteText(s)}` : ''}</span>
        </div>
        <ul class="precat-list">${rowOf(REQUIRED).map((id) => html`<${CatRow} key=${id} id=${id} cat=${cats[id]} />`)}</ul>
      </section>
      <section class="precard precard--opt">
        <header>
          <h3>${t('可选资源')}</h3>
          <label class="precard__toggle" title=${t('同时预载可选资源')}>
            <input type="checkbox" checked=${!!(s && s.includeOptional)} disabled=${!svc}
              onChange=${(e) => { savePref(PREF_OPTIONAL, e.target.checked); svc?.setIncludeOptional(e.target.checked); }} />
            <span>${t('同时预载')}</span>
          </label>
        </header>
        <div class="precard__total">
          <span class="num">${s ? `${s.optional.done}/${s.optional.total}` : '—'} ${t('个文件')}</span>
        </div>
        <ul class="precat-list">${rowOf(CATEGORIES.filter((c) => !c.required).map((c) => c.id)).map((id) => html`<${CatRow} key=${id} id=${id} cat=${cats[id]} />`)}</ul>
      </section>
    </div>
    <div class="preload-modal__opts">
      <label class="preload-modal__conc">
        <span>${t('下载并发')}</span>
        <select class="set-input" value=${String(s?.concurrency ?? DEFAULT_CONCURRENCY)}
          onChange=${(e) => { savePref(PREF_CONCURRENCY, Number(e.target.value)); svc?.setConcurrency(Number(e.target.value)); }}>
          ${CONCURRENCY_OPTIONS.map((n) => html`<option key=${n} value=${String(n)}>${n}</option>`)}
        </select>
      </label>
      <span class="preload-modal__hint preload-modal__hint--inline">${t('同时下载几个文件；越高越快，也越占带宽。')}</span>
    </div>
    <div class="preload-modal__status">
      <label class="preload__auto">
        <input type="checkbox" checked=${auto} onChange=${(e) => { setAuto(e.target.checked); savePref(PREF, e.target.checked); }} />
        <span>${t('以后自动预载')}</span>
      </label>
      <span class=${cx('preload__chip', `is-${s && s.error === 'quota' ? 'error' : s ? s.status : 'idle'}`)}>${statusLabel(s)}</span>
      ${s && s.error === 'quota' ? html`<span class="preload-modal__failed">${t('浏览器的本地存储（磁盘）空间不足，预载已停止——这不是电脑内存。')}</span>` : null}
      ${s && s.failed ? html`<span class="preload-modal__failed">${t('{n} 个文件下载失败，将在下次继续重试', { n: s.failed })}</span>` : null}
    </div>
  </${Modal}>`;
}

/** The host: mounts the manager dialog once (main.js `App`). */
export function PreloadHost() {
  return html`<${PreloadModal} />`;
}
