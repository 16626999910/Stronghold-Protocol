// 问题反馈 (this build): a floating 问题反馈 button above the lobby + its panel. Players post a message and comment on
// each other's — one level of replies, no editing or deleting.
//
// The board lives on the server (server/feedback.js, one JSON file so it survives a restart). `feedback.list` is
// answered by the push `feedback.items { items }` (the asker only), so the panel polls while it is open and re-asks
// right after it posts; there is no broadcast, which keeps a busy server quiet.
//
// Times are server times (welcome.serverNow → store clock): `feedbackAge` renders them relatively.

import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, Modal, Spinner, confirmDialog } from './components.js';
import { toast, toastError } from './toasts.js';
import { net } from '../net.js';
import { useStore, shallowEqual, serverNow } from '../store.js';
import { t } from '../../../shared/i18n.js';

/** How often an open panel re-asks the server for the board. */
export const FEEDBACK_REFRESH_MS = 6000;
/** How often the closed button checks for unread feedback (a light background ask; the panel polls faster while open). */
export const FEEDBACK_UNREAD_POLL_MS = 30000;
/** localStorage key of the server time the player last opened the 问题反馈 panel (messages newer than it are unread). */
export const FEEDBACK_SEEN_KEY = 'sp.feedback.seenAt';

/** The server time the player last opened the panel (0 when never — the first board then reads as unread). */
function readSeenAt() {
  try { return Number(globalThis.localStorage?.getItem(FEEDBACK_SEEN_KEY)) || 0; } catch { return 0; }
}
function writeSeenAt(at) {
  try { globalThis.localStorage?.setItem(FEEDBACK_SEEN_KEY, String(at)); } catch { /* private mode / no storage */ }
}
/** The newest `at` on the board (messages and their comments) — what an unread check compares against. */
export function newestFeedbackAt(items) {
  let newest = 0;
  for (const it of items || []) {
    newest = Math.max(newest, Number(it.at) || 0);
    for (const c of it.comments || []) newest = Math.max(newest, Number(c.at) || 0);
  }
  return newest;
}

/** A relative age from a server timestamp ("刚刚" / "3 分钟前" / "2 小时前" / "3 天前" / a date). */
export function feedbackAge(at, now = serverNow()) {
  const secs = Math.max(0, Math.floor((Number(now) - Number(at)) / 1000));
  if (!Number.isFinite(secs)) return '';
  if (secs < 45) return t('刚刚');
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t('{n} 分钟前', { n: Math.max(1, mins) });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('{n} 小时前', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 8) return t('{n} 天前', { n: days });
  return new Date(at).toLocaleDateString();
}

/** The board as the panel shows it: a copy with comments oldest-first, newest message first (what the server sends). */
export function normalizeFeedback(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && typeof it === 'object' && Number.isInteger(it.id) && typeof it.text === 'string')
    .map((it) => ({ ...it, comments: Array.isArray(it.comments) ? [...it.comments].sort((a, b) => a.at - b.at) : [] }))
    .sort((a, b) => b.at - a.at);
}

const MAX_TEXT = 500;
const MAX_COMMENT = 300;

/** One message with its comments and a reply box. */
function FeedbackItem({ item, busy, onComment, onRemove }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const mine = useStore((s) => s.me, shallowEqual);
  const isMine = mine.playerId != null && item.playerId === mine.playerId;
  const send = async () => {
    const text = draft.trim();
    if (!text) { toast(t('回复内容不能为空'), 'warn'); return; }
    const ok = await onComment(item.id, text);
    if (ok) { setDraft(''); setOpen(false); }
  };
  const del = async () => {
    const ok = await confirmDialog({
      title: t('删除反馈'), text: t('确定删除这条反馈吗？此操作无法撤销。'), okText: t('删除'), danger: true,
    });
    if (ok) onRemove(item.id);
  };
  const delComment = async (commentId) => {
    const ok = await confirmDialog({ title: t('删除回复'), text: t('确定删除这条回复吗？'), okText: t('删除'), danger: true });
    if (ok) onRemove(item.id, commentId);
  };
  return html`<li class="fb-item" data-testid=${`fb-item-${item.id}`}>
    <div class="fb-item__head">
      <span class="fb-item__name">${item.name || t('匿名博士')}</span>
      ${isMine ? html`<span class="fb-item__self">${t('我')}</span>` : null}
      <span class="fb-item__age num">${feedbackAge(item.at)}</span>
    </div>
    <p class="fb-item__text">${item.text}</p>
    <div class="fb-item__foot">
      <button type="button" class="fb-reply-btn" onClick=${() => setOpen((v) => !v)}>
        ${item.comments.length ? t('{n} 条回复', { n: item.comments.length }) : t('回复')}
      </button>
      ${isMine ? html`<button type="button" class="fb-del-btn" onClick=${del}>${t('删除')}</button>` : null}
    </div>
    ${item.comments.length ? html`<ul class="fb-comments">
      ${item.comments.map((c) => html`<li key=${c.id} class="fb-comment">
        <span class="fb-comment__name">${c.name || t('匿名博士')}</span>
        <span class="fb-comment__age num">${feedbackAge(c.at)}</span>
        ${mine.playerId != null && c.playerId === mine.playerId
          ? html`<button type="button" class="fb-comment__del" aria-label=${t('删除回复')} title=${t('删除回复')} onClick=${() => delComment(c.id)}><${Icon} name="close" /></button>`
          : null}
        <p class="fb-comment__text">${c.text}</p>
      </li>`)}
    </ul>` : null}
    ${open ? html`<div class="fb-reply">
      <textarea class="fb-input fb-input--sm" rows="2" maxlength=${MAX_COMMENT} value=${draft}
        placeholder=${t('写下你的回复…')} onInput=${(e) => setDraft(e.target.value)}></textarea>
      <div class="fb-reply__acts">
        <${Button} size="sm" variant="ghost" onClick=${() => { setOpen(false); setDraft(''); }}>${t('取消')}<//>
        <${Button} size="sm" variant="primary" icon="check" loading=${busy === `c${item.id}`} onClick=${send}>${t('发送')}<//>
      </div>
    </div>` : null}
  </li>`;
}

/** The 问题反馈 overlay. */
export function FeedbackPanel({ open, onClose }) {
  const conn = useStore((s) => s.connection, shallowEqual);
  const [items, setItems] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const online = conn.status === 'online';

  useEffect(() => {
    if (!open) return undefined;
    const off = net.on('feedback.items', (msg) => setItems(normalizeFeedback(msg.items)));
    return off;
  }, [open]);

  // Poll while open (a push refresh right after posting covers the poster's own change immediately).
  useEffect(() => {
    if (!open || !online) return undefined;
    net.send('feedback.list');
    const id = setInterval(() => net.send('feedback.list'), FEEDBACK_REFRESH_MS);
    return () => clearInterval(id);
  }, [open, online]);

  const run = async (kind, fn) => {
    setBusy(kind);
    try { return await fn(); } catch (err) { toastError(err); return false; } finally { if (alive.current) setBusy(null); }
  };

  const post = () => run('post', async () => {
    const text = draft.trim();
    if (!text) { toast(t('反馈内容不能为空'), 'warn'); return false; }
    await net.request('feedback.post', { text });
    if (alive.current) setDraft('');
    toast(t('反馈已提交，感谢你的建议'), 'success');
    return true;
  });

  const comment = (id, text) => run(`c${id}`, async () => {
    await net.request('feedback.comment', { id, text });
    return true;
  });

  // delete one's own message (commentId absent) or own comment
  const remove = (id, commentId) => run(`d${id}`, async () => {
    await net.request('feedback.remove', commentId == null ? { id } : { id, commentId });
    return true;
  });

  const list = items || [];
  return html`<${Modal} open=${open} title=${t('问题反馈')} micro="FEEDBACK" tone="mint" onClose=${onClose} width="min(640px, 94vw)">
    <div class="fb">
      <div class="fb-post">
        <textarea class="fb-input" rows="3" maxlength=${MAX_TEXT} value=${draft}
          placeholder=${t('写下你遇到的问题或建议…（{MAX} 字以内）', { MAX: MAX_TEXT })}
          onInput=${(e) => setDraft(e.target.value)}></textarea>
        <div class="fb-post__acts">
          <span class="fb-post__count num">${draft.length}/${MAX_TEXT}</span>
          <${Button} variant="primary" icon="check" loading=${busy === 'post'} disabled=${!online} onClick=${post}>${t('提交反馈')}<//>
        </div>
      </div>
      ${!online
        ? html`<div class="fb-empty"><${Spinner} size="sm" label="CONNECTING" /></div>`
        : items === null
          ? html`<div class="fb-empty"><${Spinner} size="sm" label="LOADING" /></div>`
          : list.length
            ? html`<ul class="fb-list">
                ${list.map((it) => html`<${FeedbackItem} key=${it.id} item=${it} busy=${busy} onComment=${comment} onRemove=${remove} />`)}
              </ul>`
            : html`<div class="fb-empty">
                <${Icon} name="edit" />
                <p>${t('还没有人反馈，来写第一条吧。')}</p>
              </div>`}
      <p class="fb-foot"><${MicroLabel}>AUTO-REFRESH ${FEEDBACK_REFRESH_MS / 1000}S<//>
        <span class="t-dim">${t('列表每 {n} 秒自动刷新；反馈会保存在服务器上。', { n: FEEDBACK_REFRESH_MS / 1000 })}</span></p>
    </div>
  <//>`;
}

/** The 问题反馈 button + its panel, as one unit so a screen only mounts this. */
export function FeedbackButton({ variant = 'secondary', size = 'sm', class: cls }) {
  const [open, setOpen] = useState(false);
  // unread: while the panel is CLOSED the button asks the server for the board (a light background poll) and lights up
  // with a blinking highlight when the newest message is newer than the last time the panel was opened.
  const [unread, setUnread] = useState(false);
  const conn = useStore((s) => s.connection, shallowEqual);
  const online = conn.status === 'online';
  useEffect(() => {
    if (open || !online) return undefined;
    let live = true;
    const off = net.on('feedback.items', (msg) => {
      if (live) setUnread(newestFeedbackAt(normalizeFeedback(msg.items)) > readSeenAt());
    });
    const ask = () => net.send('feedback.list');
    ask();
    const id = setInterval(ask, FEEDBACK_UNREAD_POLL_MS);
    return () => { live = false; if (typeof off === 'function') off(); clearInterval(id); };
  }, [open, online]);
  const openPanel = () => { writeSeenAt(serverNow()); setUnread(false); setOpen(true); };
  return html`<span class=${cls}>
    <${Button} variant=${variant} size=${size} icon="edit" class=${unread ? 'fb-btn is-unread' : 'fb-btn'} onClick=${openPanel}>
      ${t('问题反馈')}${unread ? html`<span class="fb-btn__unread" aria-label=${t('有新的反馈')} title=${t('有新的反馈')}></span>` : null}
    <//>
    <${FeedbackPanel} open=${open} onClose=${() => setOpen(false)} />
  </span>`;
}
