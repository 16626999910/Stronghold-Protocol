// 更新公告 (patch notes): a 🔔 bell in the lobby (left of 玩法说明) opening a patch-notes viewer styled like the
// official 更新公告 panel — a list of dated entries on the LEFT, the selected entry's body on the RIGHT. Unread
// entries make the bell glow and the panel OPENS BY ITSELF when the lobby is entered (author 2026-10-11).
//
// It is icon-only in the lobby (no text label). Content lives in public/announcements.json (fetched once, cached):
//   { items: [{ id, version, date, title, tags: string[], pinned, body: [{ h } | { li } | { p }] }] }
// A `body` block is a heading ({h}), a numbered list item ({li}, consecutive ones group into one <ol>) or a paragraph
// ({p}); `**bold**` inside any text is rendered bold. Read state is localStorage 'sp.announce.read' (a list of ids).
// Global & imperative like the 玩法说明 viewer: openAnnouncements(); <AnnounceHost/> is mounted once by main.js.

import { useEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Icon, MicroLabel, Spinner } from './components.js';
import { createStore, useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
const READ_KEY = 'sp.announce.read';
const SRC = '/announcements.json';

/** { open, id: selected item id|null, items: parsed list|null, unread: string[] }. */
export const annStore = createStore({ open: false, id: null, items: null, unread: [] });

const readSet = () => {
  try { return new Set(JSON.parse(globalThis.localStorage?.getItem(READ_KEY) || '[]')); } catch { return new Set(); }
};
const saveRead = (set) => { try { globalThis.localStorage?.setItem(READ_KEY, JSON.stringify([...set])); } catch { /* ignore */ } };

/** Ids of the items not yet read (a fresh visitor has every id unread). */
export function annUnread(items) {
  const read = readSet();
  return (Array.isArray(items) ? items : []).map((x) => x && x.id).filter((id) => id && !read.has(id));
}

let loading = null;
/** Fetch + parse public/announcements.json once (cached in the store). Resolves to the item list. */
export function loadAnnouncements() {
  const cur = annStore.get();
  if (cur.items) return Promise.resolve(cur.items);
  if (loading) return loading;
  loading = fetch(SRC, { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      const items = Array.isArray(j) ? j : (Array.isArray(j?.items) ? j.items : []);
      const list = items.filter((x) => x && x.id);
      annStore.set({ items: list, unread: annUnread(list) });
      return list;
    })
    .catch(() => { annStore.set({ items: [], unread: [] }); return []; });
  return loading;
}

/** Mark one entry read (updates the store's unread list). */
export function markAnnounceRead(id) {
  if (!id) return;
  const read = readSet();
  if (read.has(id)) return;
  read.add(id);
  saveRead(read);
  annStore.set({ unread: annUnread(annStore.get().items || []) });
}

/** Open the viewer (optionally at an entry). Defaults to the first UNREAD entry, else the first. Kicks off the load. */
export function openAnnouncements(id = null) {
  annStore.set((s) => ({ open: true, id: id ?? s.id }));
  loadAnnouncements().then((items) => {
    if (!items.length) return;
    const s = annStore.get();
    if (s.id == null || !items.some((x) => x.id === s.id)) {
      const pick = annUnread(items)[0] || items[0].id;
      annStore.set({ id: pick });
      markAnnounceRead(pick);
    }
  });
}
export const closeAnnouncements = () => annStore.set({ open: false });

/**
 * The lobby's auto-open: load the entries and, if anything is UNREAD, open the viewer by itself (author 2026-10-11).
 * The caller runs it once per lobby entry, so a reader is not interrupted twice for the same entries.
 */
export function announceAutoOpen() {
  return loadAnnouncements().then((items) => {
    if (annUnread(items).length && !annStore.get().open) openAnnouncements();
  });
}

/** The lobby's 🔔 trigger — icon only, a red dot while something is unread. */
export function AnnounceButton({ class: cls, size = 'sm', variant = 'secondary' }) {
  const unread = useStore((s) => s.unread, Object.is, annStore);
  return html`<span class=${cx('ann-bell', cls)}>
    <button type="button" class=${cx('btn', `btn--${variant}`, `btn--${size}`, 'btn--square', 'ann-bell__btn', unread.length && 'has-unread')}
      onClick=${() => openAnnouncements()} title=${t('更新公告')} aria-label=${t('更新公告')}><${Icon} name="bell" /></button>
    ${unread.length ? html`<span class="ann-bell__dot" aria-hidden="true"></span>` : null}
  </span>`;
}

/** `**bold**` inside a text run → vnodes. */
function rich(text) {
  return String(text ?? '').split(/(\*\*[^*]+\*\*)/g).filter((s) => s !== '').map((s, i) => (
    s.startsWith('**') && s.endsWith('**') ? html`<b key=${i}>${s.slice(2, -2)}</b>` : s
  ));
}

/** A `body` array → heading / numbered-list / paragraph vnodes (consecutive {li} group into one <ol>). */
function AnnBody({ body }) {
  const blocks = Array.isArray(body) ? body : [];
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || typeof b !== 'object') continue;
    if (b.h) { out.push(html`<h4 key=${i} class="patch__h">${rich(b.h)}</h4>`); continue; }
    if (b.p) { out.push(html`<p key=${i} class="patch__p">${rich(b.p)}</p>`); continue; }
    if (b.li) {
      const lis = [];
      while (i < blocks.length && blocks[i] && blocks[i].li) { lis.push(blocks[i].li); i++; }
      i--;
      out.push(html`<ol key=${i} class="patch__ol">${lis.map((x, k) => html`<li key=${k}>${rich(x)}</li>`)}</ol>`);
    }
  }
  return html`<div class="patch__content">${out}</div>`;
}

/** The viewer (mounted once near the root by main.js). */
export function AnnounceHost() {
  const { open, id, items, unread } = useStore((s) => s, Object.is, annStore);
  const boxRef = useRef(null);
  const list = Array.isArray(items) ? items : [];
  const cur = list.find((x) => x.id === id) || list[0] || null;

  useEffect(() => { if (open) loadAnnouncements(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') closeAnnouncements();
      // swallow game shortcuts while the panel is up
      if (e.key && (e.key.length === 1 || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    const tm = setTimeout(() => boxRef.current?.focus?.(), 30);
    return () => { window.removeEventListener('keydown', onKey, true); clearTimeout(tm); };
  }, [open]);

  if (!open) return null;
  const pick = (x) => { annStore.set({ id: x.id }); markAnnounceRead(x.id); };
  const tagCls = (x) => (x === '最新' ? 'is-latest' : x === '置顶' ? 'is-pin' : x === '游玩' ? 'is-play' : 'is-upd');
  return html`<div class="patch" role="presentation" onMouseDown=${(e) => { if (e.target === e.currentTarget) closeAnnouncements(); }}>
    <div class="patch__box brackets" role="dialog" aria-modal="true" aria-label=${t('更新公告')} tabindex="-1" ref=${boxRef}>
      <header class="patch__head">
        <${MicroLabel} tone="mint">PATCH NOTES // STRONGHOLD PROTOCOL</${MicroLabel}>
        <h2 class="patch__title">${t('更新公告')}</h2>
        <button type="button" class="patch__close" aria-label=${t('关闭')} title=${t('关闭')} onClick=${() => closeAnnouncements()}><${Icon} name="chevronRight" /></button>
      </header>
      ${!items ? html`<div class="patch__loading"><${Spinner} label="LOADING" /></div>` : null}
      ${items && !list.length ? html`<p class="patch__empty">${t('暂无公告')}</p>` : null}
      ${list.length ? html`<div class="patch__body">
        <nav class="patch__list" aria-label=${t('更新公告')}>
          ${list.map((x) => html`<button key=${x.id} type="button" class=${cx('patch__item', cur && x.id === cur.id && 'is-on')} onClick=${() => pick(x)}>
            <span class="patch__date"><b>${String(x.date || '').slice(8, 10) || '—'}</b><i>${monthLabel(x.date)}</i></span>
            <span class="patch__itxt">
              <span class="patch__ititle">${x.title || x.version || x.id}</span>
              ${Array.isArray(x.tags) && x.tags.length ? html`<span class="patch__tags">${x.tags.map((tg) => html`<em key=${tg} class=${cx('patch__tag', tagCls(tg))}>${tg}</em>`)}</span>` : null}
            </span>
            ${unread.includes(x.id) ? html`<span class="patch__dot" aria-hidden="true"></span>` : null}
          </button>`)}
        </nav>
        ${cur ? html`<article class="patch__doc">
          <h3 class="patch__dtitle">${cur.title || cur.version || cur.id}</h3>
          <div class="patch__meta">
            <span class="patch__mdate">${cur.date || ''}</span>
            ${cur.version ? html`<em class="patch__mver">${cur.version}</em>` : null}
            ${Array.isArray(cur.tags) ? cur.tags.map((tg) => html`<em key=${tg} class=${cx('patch__mtag', tagCls(tg))}>${tg}</em>`) : null}
          </div>
          <${AnnBody} body=${cur.body} />
        </article>` : null}
      </div>` : null}
    </div>
  </div>`;
}

/** '2026-10-11' → '10月' (the list's month label; '' without a date). */
function monthLabel(date) {
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(String(date || ''));
  return m ? `${Number(m[1])}月` : '';
}
