// 大厅聊天 (this build): a lobby-wide chat board, styled after the official 双服大厅 — a collapsible window pinned to
// the BOTTOM-LEFT that shows avatar / name / status / text-or-emote rows, with a 表情包 picker and a 发布组队公告 button
// (a 组队公告 carries the sender's 同盟密钥; anyone may click it to join that alliance).
//
// Push-driven and GLOBAL (mounted once by main.js, like AnnounceHost): one module store holds the messages so the
// backlog + unread count survive panel open/close and the route changing between 大厅 and 房间. The server
// (server/lobbyChat.js) keeps a memory-only ring — 聊天记录仅保存在本次运行.
//
//   main.js wireNet: net.on('lobby.chatMsg', lobbyChatPush) · net.on('lobby.chat', m => lobbyChatSetList(m.messages))

import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import { html, Icon, Button, TextField, MicroLabel, AvatarFrame } from './components.js';
import { EmoteArt } from './emotes.js';
import { toast, toastError } from './toasts.js';
import { feedbackAge } from './feedback.js';
import { net } from '../net.js';
import { createStore, useStore, shallowEqual, selectRoute } from '../store.js';
import { EMOTE_THEMES, LOBBY_CHAT_MAX_LEN } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
/** How many messages the client keeps (≥ the server ring, so the two stay in sync). */
export const LOBBY_CHAT_KEEP = 200;
/** Per-session cooldowns mirrored client-side (grey the controls; the server enforces the real ones). */
const MSG_CD_MS = 1200;
const PARTY_CD_MS = 6000;

/** { open, messages: item[], unread: number }. */
export const chatStore = createStore({ open: false, messages: [], unread: 0 });

/** Keep a message list bounded and de-duped by id (ascending). */
function tidy(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object' || !Number.isInteger(m.id) || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  out.sort((a, b) => a.id - b.id);
  return out.length > LOBBY_CHAT_KEEP ? out.slice(out.length - LOBBY_CHAT_KEEP) : out;
}

/** One `lobby.chatMsg` push → append (dedupe by id); bumps the unread count while the panel is closed. */
export function lobbyChatPush(msg) {
  if (!msg || typeof msg !== 'object' || !Number.isInteger(msg.id)) return;
  chatStore.set((s) => {
    if (s.messages.some((m) => m.id === msg.id)) return {};
    const messages = tidy([...s.messages, msg]);
    return { messages, unread: s.open ? 0 : s.unread + 1 };
  });
}

/** The `lobby.chat { messages }` backlog → merge with anything pushed meanwhile. */
export function lobbyChatSetList(messages) {
  const incoming = Array.isArray(messages) ? messages : [];
  chatStore.set((s) => {
    const before = s.messages.length;
    const merged = tidy([...incoming, ...s.messages]);
    const added = Math.max(0, merged.length - before);
    return { messages: merged, unread: s.open ? 0 : s.unread + added };
  });
}

/** Open the panel: ask for the backlog (the unread count comes with it), clear the badge. */
export function openLobbyChat() {
  chatStore.set({ open: true, unread: 0 });
  net.send('lobby.chatList');
}
export const closeLobbyChat = () => chatStore.set({ open: false });

// ---- components -------------------------------------------------------------------------------------

/** The collapsed entry: a bottom-left pill with an unread badge. */
export function LobbyChatButton() {
  const { unread, open } = useStore((s) => ({ unread: s.unread, open: s.open }), shallowEqual, chatStore);
  if (open) return null;
  return html`<button type="button" class=${`lc-pill${unread ? ' is-unread' : ''}`} onClick=${openLobbyChat} title=${t('大厅聊天')} aria-label=${t('大厅聊天')}>
    <${Icon} name="chat" class="lc-pill__ico" />
    <span class="lc-pill__label">${t('大厅聊天')}</span>
    ${unread ? html`<span class="lc-pill__dot num">${unread > 99 ? '99+' : unread}</span>` : null}
  </button>`;
}

/** One message row: avatar + name · 状态 · time, then the kind-specific body. */
function LobbyChatRow({ m }) {
  const status = m.status === 'room' ? t('房间') : t('大厅');
  const body = m.kind === 'emote' && m.emote
    ? html`<div class="lc-msg__emote"><${EmoteArt} id=${m.emote} /></div>`
    : m.kind === 'party'
      ? html`<div class="lc-party">
          <span class="lc-party__txt">${t('发布组队公告')}</span>
          <span class="lc-party__code num">${m.code || ''}</span>
          <${Button} size="sm" variant="primary" icon="users" onClick=${() => joinAlliance(m.code)}>${t('加入该同盟')}<//>
        </div>`
      : html`<span class="lc-msg__text">${m.text || ''}</span>`;
  return html`<div class="lc-msg">
    <${AvatarFrame} name=${m.name} size="sm" seat=${0} class="lc-msg__av" />
    <div class="lc-msg__body">
      <div class="lc-msg__head">
        <b class="lc-msg__name">${m.name || ''}</b>
        <em class=${cx('lc-msg__status', m.status === 'room' && 'is-room')}>${status}</em>
        <time class="lc-msg__time">${feedbackAge(m.at)}</time>
      </div>
      ${body}
    </div>
  </div>`;
}

/** The 表情包 popover: one 6-emote theme page at a time, a pager for the rest. */
function LobbyEmotePicker({ onPick, onClose }) {
  const [page, setPage] = useState(0);
  const theme = EMOTE_THEMES[((page % EMOTE_THEMES.length) + EMOTE_THEMES.length) % EMOTE_THEMES.length];
  return html`<div class="lc-emotes" role="dialog" aria-label=${t('表情包')}>
    <div class="lc-emotes__head">
      <button type="button" class="lc-emotes__nav" aria-label=${t('上一页')} onClick=${() => setPage((p) => p - 1)}><${Icon} name="chevronLeft" /></button>
      <span class="lc-emotes__name">${t(theme.name)}</span>
      <button type="button" class="lc-emotes__nav" aria-label=${t('下一页')} onClick=${() => setPage((p) => p + 1)}><${Icon} name="chevronRight" /></button>
    </div>
    <div class="lc-emotes__grid">
      ${theme.emotes.map((e) => html`<button key=${e.id} type="button" class="lc-emotes__cell" title=${t(e.label)} aria-label=${t(e.label)}
        onClick=${() => { onPick(e.id); onClose(); }}><${EmoteArt} id=${e.id} /></button>`)}
    </div>
  </div>`;
}

/** Join the alliance a 组队公告 advertises (the code is the room's 同盟密钥). */
function joinAlliance(code) {
  if (!code) return;
  net.request('room.join', { code })
    .then(() => closeLobbyChat())
    .catch((err) => toastError(err));
}

/** The expanded window: bottom-left, collapsible. */
export function LobbyChatPanel() {
  const messages = useStore((s) => s.messages, Object.is, chatStore);
  const room = useStore((s) => s.room, Object.is);
  const [text, setText] = useState('');
  const [picker, setPicker] = useState(false);
  const [cooling, setCooling] = useState(false);
  const coolRef = useRef(0);
  const listRef = useRef(null);

  // pin to the newest message whenever one arrives
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const canParty = !!(room && room.mode === 'coop' && !room.inMatch);
  const busy = cooling || Date.now() < coolRef.current;

  const send = (fields, cd) => {
    const now = Date.now();
    if (now < coolRef.current) return;
    coolRef.current = now + cd;
    setCooling(true);
    setTimeout(() => setCooling(false), cd);
    net.request('lobby.chatSend', fields).catch((err) => toastError(err));
  };
  const sendText = () => {
    const v = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!v || Date.now() < coolRef.current) return;
    setText('');
    send({ kind: 'text', text: [...v].slice(0, LOBBY_CHAT_MAX_LEN).join('') }, MSG_CD_MS);
  };

  return html`<div class="lc" data-testid="lobby-chat">
    <header class="lc__head">
      <${Icon} name="chat" class="lc__ico" />
      <span class="lc__title">${t('大厅聊天')}<${MicroLabel}>LOBBY CHAT<//></span>
      <button type="button" class="lc__collapse" aria-label=${t('收起')} title=${t('收起')} onClick=${closeLobbyChat}><${Icon} name="chevronDown" /></button>
    </header>
    <div class="lc__list" ref=${listRef}>
      ${messages.length
        ? messages.map((m) => html`<${LobbyChatRow} key=${m.id} m=${m} />`)
        : html`<p class="lc__empty">${t('暂无聊天消息')}</p>`}
    </div>
    ${picker ? html`<${LobbyEmotePicker} onPick=${(id) => send({ kind: 'emote', emote: id }, MSG_CD_MS)} onClose=${() => setPicker(false)} />` : null}
    <div class="lc__tools">
      <${Button} size="sm" variant=${picker ? 'secondary' : 'ghost'} icon="emote" onClick=${() => setPicker((v) => !v)}>${t('表情包')}<//>
      <span class="lc__party-wrap" title=${canParty ? undefined : t('需先创建或加入同盟')}>
        <${Button} size="sm" variant="ghost" icon="users" disabled=${busy || !canParty}
          onClick=${() => send({ kind: 'party' }, PARTY_CD_MS)}>${t('发布组队公告')}<//>
      </span>
    </div>
    <div class="lc__input">
      <${TextField} value=${text} onInput=${setText} onEnter=${sendText} placeholder=${t('说点什么…')}
        maxLength=${LOBBY_CHAT_MAX_LEN} size="sm" class="lc__field" />
      <${Button} size="sm" variant="primary" icon="edit" disabled=${busy || !String(text).trim()} onClick=${sendText}>${t('发送')}<//>
    </div>
    <p class="lc__foot">${t('聊天记录仅保存在本次运行')}</p>
  </div>`;
}

/** The host: mounted once by main.js. Hidden on the title / game screens; the pill or the window otherwise. */
export function LobbyChatHost() {
  const route = useStore(selectRoute);
  const open = useStore((s) => s.open, Object.is, chatStore);
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current && (route === 'lobby' || route === 'room')) { loaded.current = true; net.send('lobby.chatList'); }
  }, [route]);
  if (route === 'game' || route === 'title') return null;
  return open ? html`<${LobbyChatPanel} />` : html`<${LobbyChatButton} />`;
}
