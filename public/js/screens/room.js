// Room screen (同盟等待室): the reference v024 «rs» design — tall seat cards side by side (rseat: portrait, 创建者,
// 已就绪 / 准备中 / 失去信号, name plate with avatar, the host's 移出), the top bar (leave · clock/latency · tools;
// 干员调配 · 同盟密钥 with 复制 / 链接), the bottom bar (ready tally + status, the difficulty pill and the ⚙ 同盟设置
// popover, 开始模拟 / 准备就绪). Ported into this build: the 玩法扩展开关 (ROOM_EXTENSIONS — 复活队友 / 共享血条 /
// 重复策略 / DPS面板 / 取消部署上限 / 不禁用盟约) live in the ⚙ popover, 房间人数 in the same popover, and the
// 房间可见性 pill; sandbox / endless keep their own briefs. Seats show this build's own avatar system (avatarSrc /
// assets.avatars / me.avatar).
//
// Start rule (server/lobby.js): room.start needs every *other* human connected and ready; the
// host's start counts as the host's ready. So 开始模拟 is enabled exactly then and sends room.start
// alone (no separate room.ready round trip that could leave the host "ready" after a failed start).
// Solo rooms show a single seat.
// Spectator seats (community report #26, a remake feature): a co-op room with spectators shows the 观战席 strip under
// the seats — names, offline marks, the host's ✕ (room.removeSpectator) — and a spectator's own view swaps the ready
// button for 观战中 and offers 入座 (room.join of the room) while a player seat is free.
// Texts go through t() (docs/I18N.md).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, MAX_SEATS, ROOM_PLAYER_OPTIONS, DEFAULT_ROOM_PLAYERS, ROOM_EXTENSIONS, ROOM_EXTENSIONS_DEFAULT, MAX_SPECTATORS, poolCopyMulFor, extensionsAreDefault } from '../../../shared/constants.js';
import {
  html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyTag, DifficultyIcon, Tooltip, Modal, Spinner, confirmDialog, doctorNo,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { copyText } from '../ui/clipboard.js';
import { GuideButton } from '../ui/guide.js';
import { OnlinePill } from '../ui/online.js';
import { LoadoutButton } from './loadout.js';
import { HubBackdrop, HubRadar, useHubBackdrop, backdropTheme } from '../ui/hubBackdrop.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, emptyMatch, isSpectating } from '../store.js';
import { data, useData } from '../data.js';
import { avatarSrc } from '../assets.js';
import { difficultyInfo, ProtoCard } from './lobby.js';
import { ProtocolScene } from '../ui/protocolScene.js';
import { t, tc, N_ } from '../../../shared/i18n.js';

/**
 * Seats padded to the room's capacity (co-op 4, solo 1), each null or a seat record.
 * @param {any} room room.state payload
 * @returns {(null | {seat:number, playerId:any, name:string, isBot:boolean, ready:boolean, connected:boolean})[]}
 */
export function normalizeSeats(room) {
  // 房间人数 (room.setOptions maxPlayers): a co-op room shows only its own capacity's seats (default 4, up to MAX_SEATS)
  const cap = room?.mode === 'solo' ? 1 : (Number.isInteger(room?.maxPlayers) ? Math.max(1, Math.min(MAX_SEATS, room.maxPlayers)) : MAX_SEATS);
  const src = Array.isArray(room?.seats) ? room.seats : [];
  const out = [];
  for (let i = 0; i < cap; i++) {
    const s = src[i];
    out.push(s && typeof s === 'object' ? { ...s, seat: Number.isInteger(s.seat) ? s.seat : i } : null);
  }
  return out;
}

/**
 * 座位布局 (this build): inline CSS vars for the seats grid. The cards fill the free screen width (the columns are
 * `minmax(0, 1fr)` tracks, room.css) — 4 人及以下 one row with 人数 columns（人少时卡片更大，不留空列）；6 人以上固定
 * 两行、列数 = ceil(人数 / 2)（6→3、8→4、10→5、12→6）。头像尺寸随列数变大（列越少越大）。
 * @param {number} n seat count (the room's own capacity)
 * @returns {string}
 */
export function seatGridStyle(n) {
  const count = Math.max(1, Math.min(MAX_SEATS, Number(n) || 1));
  const cols = count <= 4 ? count : Math.ceil(count / 2);
  const av = { 1: '6.4rem', 2: '5.6rem', 3: '4.8rem', 4: '4.2rem', 5: '3.6rem', 6: '3.1rem' }[cols] || '3.1rem';
  return `--seat-cols:${cols};--seat-rows:${count <= 4 ? 1 : 2};--seat-av:${av}`;
}

/**
 * Derived room facts for the local player.
 * @param {any} room
 * @param {any} myId
 */
export function roomFacts(room, myId) {
  const seats = normalizeSeats(room);
  const occupied = seats.filter(Boolean);
  const humans = occupied.filter((s) => !s.isBot);
  const mine = occupied.find((s) => s.playerId === myId) || null;
  const isHost = room?.hostId != null && room.hostId === myId;
  const others = humans.filter((s) => s.playerId !== myId);
  // The host never readies: starting the match is the host's ready (server rule), so the count
  // treats the host as ready — "已就绪 0/1" next to "准许进入模拟" would contradict itself.
  const isReady = (s) => !!s.ready || s.playerId === room?.hostId;
  const readyHumans = humans.filter(isReady).length;
  const othersReady = others.every((s) => s.ready && s.connected !== false);
  return {
    seats, occupied, humans, mine, isHost, readyHumans, isReady,
    emptySeats: seats.filter((s) => !s).length,
    canStart: isHost && othersReady && !!mine,
    othersReady,
    // spectator seats (never players: not in `humans`, never counted for ready / start)
    spectators: Array.isArray(room?.spectators) ? room.spectators.filter((s) => s && typeof s === 'object') : [],
    spectating: isSpectating(room, myId),
    // 大队伍规则 (this build, shared/constants.js): the roster size drives three customizations — the Final Assault
    // leader pool, whether bonds are banned, and the pool's copies. Mirrored here (the server decides authoritatively at
    // match start, server/match/Match.js) so the room can show them before the host starts.
    bigTeam: {
      size: occupied.length,
      noBan: room?.extensions?.noBan === true || room?.endless === true,
      poolMul: poolCopyMulFor(occupied.length),
      bossMul: room?.mode === 'solo' ? 0.25 : Math.round((Math.min(MAX_SEATS, occupied.length) / 4) * 100) / 100,
    },
  };
}

/**
 * 大队伍规则提示 (this build): past the official 4 seats the coming match deviates — the Final Assault leader pool
 * scales with the roster, and the shared pool's copies scale from 4 seats up to ×2 (shared/constants.js
 * `poolCopyMulFor`). 「不禁用盟约」 is its own 玩法扩展开关 now (`noBan`, default off), not a size rule. Mirrors
 * server/match/Match.js.
 */
function BigTeamBar({ facts }) {
  const bt = facts?.bigTeam;
  if (!bt || bt.size <= 4) return null;
  const items = [
    `最终领袖生命 ×${bt.bossMul}`,
    bt.noBan ? '本局不禁用盟约' : null,
    bt.poolMul > 1 ? `牌库副本 ×${Math.round(bt.poolMul * 100) / 100}` : null,
  ].filter(Boolean);
  return html`<div class="bigteam brackets" data-testid="bigteam">
    <span class="bigteam__label"><${Icon} name="users" />大队伍<b class="num">${bt.size}</b>人 · 本局特殊规则</span>
    <span class="bigteam__tags">${items.map((x) => html`<span key=${x} class="bigteam__tag">${x}</span>`)}</span>
  </div>`;
}

/** Invite link for a room code (current page URL with ?room=CODE). */
export function inviteLink(code) {
  const loc = globalThis.location;
  const base = loc ? `${loc.origin}${loc.pathname}` : '';
  return `${base}?room=${encodeURIComponent(code)}`;
}

/**
 * Copy text to the clipboard (async API with a textarea fallback for insecure contexts). Moved to ui/clipboard.js so
 * 干员调配 can use it without importing this screen (which imports loadout.js): re-exported here for existing callers.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export { copyText };

/** mm:ss of a duration in seconds. */
const clock = (s) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.floor(Math.max(0, s)) % 60).padStart(2, '0')}`;

function SeatCard({ seat, index, room, facts, myId, busy, onAddBot, onRemoveBot, onKick }) {
  const coop = room.mode !== 'solo';
  if (!seat) {
    const canAdd = coop && facts.isHost && !facts.spectating;
    return html`<article class="rseat rseat--empty" style=${`--i:${index}`}>
      <span class="rseat__clip" aria-hidden="true"></span>
      <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
      <div class="rseat__art">
        ${canAdd
          ? html`<button type="button" class="rseat__invite" disabled=${busy === 'add'} onClick=${onAddBot} title=${t('添加 AI 队友')}>
              <span class="rseat__plus" aria-hidden="true"></span><b>${t('AI 队友')}</b><small>${t('点击添加 AI 队友')}</small>
            </button>`
          : html`<span class="rseat__wait"><small>${t('等待博士加入')}</small></span>`}
        <span class="rseat__noinfo" aria-hidden="true">NOINFO</span>
      </div>
      <div class="rseat__plate rseat__plate--empty">
        <span class="rseat__who"><b class="rseat__name">${coop ? t('空位') : t('独立模拟')}</b></span>
      </div>
    </article>`;
  }
  const isMe = seat.playerId === myId;
  const isHostSeat = seat.playerId === room.hostId;
  const offline = seat.connected === false && !seat.isBot;
  // The host never needs to toggle ready: starting the match readies them (server rule).
  const state = offline ? 'offline' : seat.ready || seat.isBot ? 'ready' : isHostSeat ? 'host' : 'waiting';
  const ready = state === 'ready' || state === 'host';
  return html`<article class=${`rseat${ready ? ' is-ready' : ''}${isMe ? ' is-me' : ''}${isHostSeat ? ' is-host' : ''}${offline ? ' is-offline' : ''}${seat.isBot ? ' is-bot' : ''}`}
      style=${`--i:${index}`}>
    <span class="rseat__clip" aria-hidden="true"></span>
    <header class="rseat__strip"><i></i><span class="num">P${index + 1}</span></header>
    <div class="rseat__art">
      <${AvatarFrame} size="xl" name=${seat.name} src=${avatarSrc(data.get('assets'), data.get('avatars'), seat.avatar)} seat=${index} bot=${seat.isBot} self=${isMe} ready=${ready} offline=${offline} />
      ${isHostSeat ? html`<span class="rseat__host">${t('创建者')}</span>` : null}
      ${offline ? html`<span class="rseat__lost"><${Icon} name="wifiOff" />${t('失去信号')}</span>` : null}
      <span class="rseat__state">
        ${state === 'ready' ? html`<span class="rseat__box"><${Icon} name="check" /></span>${t('已就绪')}`
          : state === 'offline' ? html`<span class="rseat__box"></span>${t('失去信号')}`
          : state === 'host' ? html`<span class="rseat__box"><${Icon} name="crown" /></span>${t('待命中')}`
          : html`<span class="rseat__box"></span>${t('准备中')}`}
      </span>
    </div>
    ${seat.isBot && facts.isHost ? html`<button type="button" class="rseat__kick" disabled=${busy === `rm${index}`} onClick=${() => onRemoveBot(index)} title=${t('移除该 AI 队友')} aria-label=${t('移除 AI 队友')}><${Icon} name="robot" /><${Icon} name="close" /></button>` : null}
    ${!seat.isBot && !isMe && facts.isHost ? html`<button type="button" class="rseat__kick" disabled=${busy === `kick${index}`} onClick=${() => onKick(index, seat.name, seat.playerId)} title=${t('将该博士移出同盟')} aria-label=${t('移出该博士')}><${Icon} name="user" /><${Icon} name="close" /></button>` : null}
    <div class="rseat__plate">
      ${isMe ? html`<span class="rseat__me" title=${t('你')}><${Icon} name="user" /></span>` : null}
      <span class="rseat__who"><b class="rseat__name">${seat.name || t('博士')}</b>${isMe ? html`<span class="seat__you">${t('你')}</span>` : null}</span>
      <small class="rseat__doc">${seat.isBot ? 'AUTONOMOUS UNIT' : `DOCTOR #${doctorNo(seat.playerId)}`}</small>
    </div>
  </article>`;
}

/** 观战席: the room's spectators (host: ✕ frees a seat), and 入座 for a spectator while a player seat is free. */
function SpectatorBar({ facts, myId, busy, onRemove, onSit }) {
  if (!facts.spectators.length) return null;
  return html`<section class="specbar" aria-label=${t('观战席')}>
    <span class="specbar__label"><${Icon} name="eye" />${t('观战席')}<b class="num">${facts.spectators.length}</b><span class="num t-dim">/${MAX_SPECTATORS}</span></span>
    ${facts.spectators.map((s) => html`<span key=${s.playerId} class=${`specbar__who${s.playerId === myId ? ' is-me' : ''}${s.connected === false ? ' is-offline' : ''}`}>
      ${s.connected === false ? html`<${Icon} name="wifiOff" />` : null}${s.name || t('博士')}${s.playerId === myId ? html`<span class="seat__you">${t('你')}</span>` : null}
      ${facts.isHost ? html`<${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rs${s.playerId}`}
        onClick=${() => onRemove(s.playerId)} aria-label=${t('移出观战者 {name}', { name: s.name || '' })} title=${t('移出该观战者')} />` : null}
    </span>`)}
    ${facts.spectating && facts.emptySeats > 0 ? html`<${Button} size="sm" icon="user" loading=${busy === 'sit'} onClick=${onSit}>${t('入座')}<//>` : null}
  </section>`;
}

/**
 * 房间可见性开关 (房间大厅 的一环，server/lobby.js setPrivate): whether this room is listed in the 房间大厅 browse list.
 *
 * 隐藏 ≠ 不可加入：a hidden room stays joinable with its 同盟密钥 — that is the point. The host toggles it; other
 * members see the current state (read-only). Hidden while the match runs (the server refuses room.setPrivate) and solo.
 * Rendered as a row inside the ⚙ 同盟设置 popover (RoomOptionsButton).
 * @param {{ room: any, isHost: boolean, busy: string | null, onToggle: Function }} props
 */
function VisibilityToggle({ room, isHost, busy, onToggle }) {
  if (!room || room.mode !== 'coop' || room.inMatch) return null;
  const isPublic = room.isPublic !== false;
  const label = isPublic ? '公开中' : '已隐藏';
  const tip = isPublic
    ? '其他博士能在「房间大厅」列表里看到本同盟。点击改为隐藏（隐藏后仍可用同盟密钥邀请朋友加入）。'
    : '本同盟不出现在「房间大厅」列表中，凭同盟密钥仍可加入。点击重新公开。';
  if (!isHost) {
    return html`<div class=${`ropts__row visrow visrow--ro${isPublic ? ' is-public' : ' is-private'}`} title=${tip}>
      <span class="ropts__label">${t('房间可见性')}</span>
      <span class=${`vispill--ro${isPublic ? ' is-public' : ' is-private'}`}><${Icon} name=${isPublic ? 'eye' : 'close'} />${label}</span>
    </div>`;
  }
  return html`<div class="ropts__row visrow">
    <span class="ropts__label" title=${tip}>${t('房间可见性')}</span>
    <${Tooltip} text=${tip}>
      <button type="button" class=${`vispill${isPublic ? ' is-public' : ' is-private'}`}
        disabled=${!!busy} aria-pressed=${isPublic ? 'true' : 'false'} onClick=${onToggle}>
        <${Icon} name=${isPublic ? 'eye' : 'close'} />
        <span>${busy === 'vis' ? '切换中…' : label}</span>
      </button>
    <//>
  </div>`;
}

/** 同盟密钥 box in the top bar (coop): the code, 复制密钥 and 复制链接。 */
function InviteBox({ code, name, difficulty }) {
  const copy = async (what) => {
    // the copied link carries an invitation line (#103): 「{name}邀请你加入卫戍协议：盟约【{difficulty}】」
    const invite = t('{name}邀请你加入卫戍协议：盟约【{difficulty}】', { name: name ?? '', difficulty: DIFFICULTY_NAMES[difficulty] ? t(DIFFICULTY_NAMES[difficulty]) : '' });
    const ok = await copyText(what === 'code' ? code : `${inviteLink(code)} ${invite}`);
    if (ok) toast(what === 'code' ? t('已复制同盟密钥 {code}', { code }) : t('已复制邀请链接'), 'success');
    else toast(t('复制失败，请手动复制'), 'warn');
  };
  return html`<div class="rs-key">
    <span class="rs-key__k">${t('同盟密钥')}</span>
    <b class="rs-key__code num selectable" aria-label=${t('同盟密钥 {code}', { code })}>${code}</b>
    <button type="button" class="rs-key__copy" onClick=${() => copy('code')}>${t('复制')}</button>
    <button type="button" class="rs-key__link" onClick=${() => copy('link')} title=${t('复制邀请链接')} aria-label=${t('复制邀请链接')}><${Icon} name="link" /></button>
  </div>`;
}

/** 模拟难度 pill: host opens 选择模拟协议 (v024 rs-proto overlay), other members see the tag read-only. */
function DifficultyPill({ room, isHost, busy, onOpen }) {
  if (!isHost) {
    return html`<${DifficultyTag} difficulty=${room.difficulty} size="lg" />`;
  }
  return html`<button type="button" class="rs-pill__diff" disabled=${!!busy}
      onClick=${onOpen} aria-haspopup="dialog" title=${t('更改模拟难度')}>
    <${DifficultyIcon} difficulty=${room.difficulty} />${t(DIFFICULTY_NAMES[room.difficulty])}
  </button>`;
}

/**
 * 选择模拟协议 over the room (host, reference v024): the difficulty picture at the left (faded), the difficulty cards
 * down the right with the 已选定 stamp and 确认 at the bottom; the pick is applied on 确认 via onPick.
 */
function RoomProtocol({ room, busy, onClose, onPick }) {
  const [pick, setPick] = useState(room.difficulty);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return html`<div class="rs-proto" style=${`--d-color:${DIFFICULTY_COLORS[pick]}`} role="dialog" aria-label=${t('选择模拟协议')}
      onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="rs-proto__scene" aria-hidden="true"><${ProtocolScene} key=${pick} difficulty=${pick} /></div>
    <section class="rs-proto__side">
      <h2 class="rs-proto__title">${t('选择模拟协议')}</h2>
      <div class="proto-list rs-proto__list" role="radiogroup" aria-label=${t('模拟难度')}>
        ${DIFFICULTIES.map((d) => html`<${ProtoCard} key=${d} roomMode=${room.mode} difficulty=${d} selected=${pick === d} onSelect=${setPick} />`)}
      </div>
      <button type="button" class="proto-start rs-proto__ok" disabled=${!!busy} onClick=${() => (pick === room.difficulty ? onClose() : onPick(pick))}>
        <span class="proto-start__mark" aria-hidden="true"><span class="proto-start__rook"><i>[</i><${Icon} name="rook" /><i>]</i></span><small>STRONGHOLD<br />PROTOCOL</small></span>
        <span class="proto-start__label">${busy === 'diff' ? html`<${Spinner} size="sm" />` : null}${t('确认')}</span>
        <span class="proto-start__deco" aria-hidden="true"></span>
      </button>
    </section>
  </div>`;
}

/** 玩法扩展 labels (shared/constants.js ROOM_EXTENSIONS). */
const EXT_LABEL = { revive: '复活队友', sharedLp: '共享血条', dupBand: '重复策略', bossPanel: 'DPS面板', deployCapOff: '取消部署上限', noBan: '不禁用盟约' };

/**
 * 房间人数 (server/lobby.js setOptions maxPlayers): the room's own capacity (ROOM_PLAYER_OPTIONS, default 4) as a compact
 * chip row. The host picks; other members see the current number. Hidden in solo / endless / in-match.
 */
function PlayerCountPicker({ room, isHost, busy, onSet }) {
  // 无尽模式 is fixed at 4 players — the picker never shows (server also refuses room.setOptions maxPlayers)
  if (!room || room.inMatch || room.mode === 'solo' || room.endless === true) return null;
  const maxPlayers = Number.isInteger(room.maxPlayers) ? room.maxPlayers : DEFAULT_ROOM_PLAYERS;
  // seats already taken (highest occupied index + 1): the host may not shrink the room below them
  const occupied = (room.seats || []).reduce((n, s, i) => (s ? i + 1 : n), 0);
  if (!isHost) return html`<span class="pcount__num num">${maxPlayers}</span>`;
  return html`<div class="pcount__chips" role="radiogroup" aria-label=${t('房间人数')}>
    ${ROOM_PLAYER_OPTIONS.map((n) => html`<button key=${n} type="button" role="radio" aria-checked=${maxPlayers === n ? 'true' : 'false'}
      class=${`pcount__chip${maxPlayers === n ? ' is-active' : ''}`} disabled=${!!busy || n < occupied}
      onClick=${() => maxPlayers !== n && onSet({ maxPlayers: n })}>${n}</button>`)}
  </div>`;
}

/**
 * ⚙ 同盟设置 (the rs-pill gear, v024's popover position): this build's own switches — 房间人数 (PlayerCountPicker),
 * the 玩法扩展开关 (ROOM_EXTENSIONS), 房间可见性. The host toggles them; other members see them read-only.
 * @param {{ room: any, facts: any, isHost: boolean, busy: string | null, onSet: (patch: object) => void, onPrivate: Function }} props
 */
function RoomOptionsButton({ room, isHost, busy, onSet, onPrivate }) {
  const [open, setOpen] = useState(false);
  // outside press / Esc closes the floating panel
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.rs-optswrap')) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const ext = { ...ROOM_EXTENSIONS_DEFAULT, ...(room.extensions || {}) };
  // 非默认 (开了 sharedLp/dupBand/deployCapOff, 或关了 revive/bossPanel) → 本局不进排行榜 (server/lobby.js onMatchEnd)
  const nonDefault = !extensionsAreDefault(ext);
  return html`<div class="rs-optswrap">
    <button type="button" class=${`rs-pill__gear${open ? ' is-on' : ''}`} onClick=${() => setOpen((v) => !v)}
      title=${t('同盟设置')} aria-label=${t('同盟设置')} aria-expanded=${open ? 'true' : 'false'}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 2h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9L2 13.7v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" fill-rule="evenodd" /></svg>
    </button>
    ${open ? html`<div class="rs-opts" role="dialog" aria-label=${t('同盟设置')}>
      <h4>${t('同盟设置')}${isHost ? null : html`<small>${t('由创建者设置')}</small>`}</h4>
      <div class="ropts__row">
        <span class="ropts__label">${t('房间人数')}</span>
        <${PlayerCountPicker} room=${room} isHost=${isHost} busy=${busy} onSet=${onSet} />
      </div>
      <div class="ropts__sep" aria-hidden="true"></div>
      ${ROOM_EXTENSIONS.map((k) => {
        const on = ext[k] !== false;
        return html`<div class="ropts__row" key=${k}>
          <span class="ropts__label">${t(EXT_LABEL[k] || k)}</span>
          ${isHost ? html`<label class="ropts__check">
              <input type="checkbox" checked=${on} disabled=${!!busy} onChange=${(e) => onSet({ extensions: { [k]: e.target.checked } })} />
              <span>${on ? t('已开启') : t('已关闭')}</span>
            </label>`
            : html`<span class=${`ropts__state${on ? ' is-on' : ' is-off'}`}>${on ? t('已开启') : t('未开启')}</span>`}
        </div>`;
      })}
      ${nonDefault ? html`<p class="ropts__tip"><${Icon} name="warn" />${t('用了非默认设置：本局结果不计入排行榜')}</p>` : null}
      <p class="ropts__tip">${t('复活的规则：任一队友被淘汰时，存活队友可消耗 10 点目标生命将其救回；获救者保留干员 / 装备 / 状态，恢复至 1 点生命，每人每局至多被救一次。')}</p>
      <p class="ropts__tip">${t('共享血条的规则：全队共用一条目标生命（各人之和），任意扣血都从总和里扣；总和降到 0 时全队失败。')}</p>
      <p class="ropts__tip">${t('重复策略的规则：开局选择策略时不再限制「队友已选」，多名博士可以选到同一个策略。')}</p>
      <p class="ropts__tip">${t('DPS面板：右上角显示我棋盘上每名干员本回合造成的伤害与每秒伤害（DPS），可点击收缩，全阶段可见；开启后同时显示「领袖伤害面板」——最终攻势 / 隐秘核心时另列全队对当前领袖的伤害占比。')}</p>
      <div class="ropts__sep" aria-hidden="true"></div>
      <${VisibilityToggle} room=${room} isHost=${isHost} busy=${busy} onToggle=${onPrivate} />
    </div>` : null}
  </div>`;
}

/**
 * 无尽狂潮 规则速览 (房间屏弹窗, author 2026-10-13 重排): the flat 12-bullet list re-cut into four scannable cards
 * (阵容 / 成长 / 首领 / 藏品) + a 成绩 strip. Numbers come straight from shared/constants.js ENDLESS, so keep them in step
 * when the knobs move. N_ marks the msgids (translated at render so a runtime 语言 switch applies).
 */
export const ENDLESS_RULES = [
  { icon: 'users', micro: 'ROSTER · OPENING', name: N_('阵容 · 开局'), items: [
    N_('固定 4 人同盟 · 难度锁定终极 · 不启用 AI 队友'),
    N_('全队共享 20 点总血量：漏怪消耗共享血量；血量耗尽先进联防，联防仍失败即转入「打桩环节」'),
    N_('打桩环节为 30 秒限时战：对场地中央打不死的源石虫累计伤害'),
  ] },
  { icon: 'signal', micro: 'GROWTH CURVE', name: N_('成长曲线'), items: [
    N_('怪物血量每回合 ×1.2152（+21.5%），从第 1 回合起一路涨'),
    N_('怪物攻击力每回合 ×1.10（+10%），上限跟着「干员血量倍率」走（×0.8）：干员越肉攻击涨越高，但恒低于血量增长，不会秒杀'),
    N_('干员血量 / 攻击保持原值；盟约层数无上限'),
    N_('局内战斗时限 ×2；每回合资金 +2，且跨回合保留'),
  ] },
  { icon: 'crown', micro: 'LEADERS · WAVES', name: N_('首领 · 波次'), items: [
    N_('回合无限，一直打到队伍血量耗尽'),
    N_('第 10 回合起每 10 回合一场真正的首领战（R10 / 20 / 30 …），打完继续下一回合'),
    N_('首领取池：≤100 层出常规首领，≥110 层出隐藏首领；首领血池 ≈ 常规小怪的 5 倍'),
    N_('第 20 回合起每波额外混入「悬赏敌人」，每 10 回合多一只'),
  ] },
  { icon: 'key', micro: 'RELICS · ECONOMY', name: N_('藏品 · 经济'), items: [
    N_('装备改为「藏品」：获得即全队生效，并与盟约联动'),
    N_('第 1 回合从专属盟约里 3 选 1（彩色）；每 5 回合 3 选 1 藏品；每 10 回合 3 选 1 决策 + 经济商店'),
    N_('第 7 / 9 / 11 / 13 回合各发一份「人事部档案」，部署上限 +1（封顶 12）'),
    N_('本局「不禁用盟约」'),
  ] },
];

/** Room screen component. */
export function RoomScreen() {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  useData('assets', 'avatars'); // 头像 (this build): seat avatars resolve from the asset manifest once it loads
  const [busy, setBusy] = useState(null);
  const [endlessTip, setEndlessTip] = useState(false); // 无尽狂潮玩法提示 (auto-opens on create / enter)
  const [protoOpen, setProtoOpen] = useState(false); // 选择模拟协议 over the room (host changes 模拟难度)
  const bg = useHubBackdrop(); // 大厅背景 (reference v024): the room reuses the lobby's procedural backdrop
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  const since = useRef(Date.now()); // 同盟已等待 (this session's entry), ticked once a second
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((x) => x + 1), 1000);
    return () => { clearInterval(id); alive.current = false; };
  }, []);
  // 无尽狂潮: pop the 玩法提示 the moment the player creates or enters the room (closeable; reopen with the topbar button)
  useEffect(() => { if (room && room.endless === true) setEndlessTip(true); }, [room?.code, room?.endless]);

  if (!room) return null;
  const online = conn.status === 'online';
  const coop = room.mode !== 'solo';
  // 沙盒 (娱乐玩法, author 2026-10-11): no 模拟难度 here — fixed 终极 internally, shown as 沙盒; the briefing just says 接下来自由探索吧
  const sandbox = room.sandbox === true;
  // 无尽模式 (娱乐玩法, this build): fixed 4-player co-op — no 模拟难度 / 房间人数 / 玩法扩展 picker; shown as 无尽模式
  const endless = room.endless === true;
  const facts = roomFacts(room, me.playerId);
  const myReady = !!facts.mine?.ready;
  const info = difficultyInfo(room.mode, room.difficulty);
  const elapsed = (Date.now() - since.current) / 1000;
  const pingOk = online && Number.isFinite(conn.ping);
  const modeLabel = endless ? t('无尽狂潮') : sandbox ? t('沙盒') : coop ? t('同盟模拟') : t('独立模拟');
  const modeEn = endless ? 'ENDLESS WAR' : sandbox ? 'SANDBOX' : coop ? 'ALLIANCE LOBBY' : 'SOLO SIMULATION';

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast(t('连接中断，请稍候重试'), 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const toggleReady = () => run('ready', () => net.request('room.ready', { ready: !myReady }));
  const start = () => run('start', () => net.request('room.start', {}));
  const addBot = () => run('add', () => net.request('room.addBot', {}));
  const removeBot = (seat) => run(`rm${seat}`, () => net.request('room.removeBot', { seat }));
  // the host removes a human before the match (community report #17): asked first; the player may join again. The
  // confirmed player's id goes along: if they left and someone else took the seat meanwhile, the server refuses it.
  const kick = async (seat, name, playerId) => {
    if (inFlight.current) return;
    const ok = await confirmDialog({ title: t('移出同盟'), text: t('确定将「{name}」移出同盟吗？对方可以凭同盟密钥重新加入。', { name: name || t('博士') }), okText: t('移出'), danger: true });
    if (ok) run(`kick${seat}`, () => net.request('room.kick', { seat, playerId }));
  };
  const setDifficulty = (difficulty) => run('diff', async () => {
    await net.request('room.setDifficulty', { difficulty });
    if (alive.current) setProtoOpen(false);
  });
  // 玩法扩展 / 房间人数 (room.setOptions, host-only): the room's own player capacity and the optional rules
  const setOptions = (patch) => run('opts', () => net.request('room.setOptions', patch));
  // 房间可见性 (房间大厅 的一环，room.setPrivate): the host lists or hides this lobby in the 房间大厅 browse list.
  // A hidden room keeps working by 同盟密钥 — this only turns discovery off. The server refuses once the match started.
  const togglePrivate = () => run('vis', async () => {
    const hide = room.isPublic !== false;
    await net.request('room.setPrivate', { private: hide });
    toast(hide ? '已从房间大厅列表中隐藏，同盟密钥仍可加入' : '已在房间大厅中公开', 'success');
  });
  // spectator seats: the host frees one; a spectator takes a free player seat with room.join of this room
  const removeSpectator = (playerId) => run(`rs${playerId}`, () => net.request('room.removeSpectator', { playerId }));
  const sit = () => run('sit', () => net.request('room.join', { code: room.code }));
  const leave = async () => {
    if (inFlight.current) return;
    const othersHere = facts.humans.some((s) => s.playerId !== me.playerId);
    if (facts.isHost && othersHere) {
      const ok = await confirmDialog({ title: t('离开同盟'), text: t('你是同盟的创建者，离开后创建者身份将移交或同盟解散。确定离开吗？'), okText: t('离开'), danger: true });
      if (!ok) return;
    }
    inFlight.current = true;
    setBusy('leave');
    try {
      await net.request('room.leave', {});
    } catch (err) {
      if (err?.code !== 'NOT_IN_ROOM') toastError(err);
    } finally {
      // Leaving locally is always safe: the server either confirmed or no longer has us in the room.
      store.set({ room: null, match: emptyMatch() });
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const statusLine = !online
    ? html`<span class="t-orange"><${Icon} name="wifiOff" />${t('连接中断，正在重连…')}</span>`
    : facts.spectating
      ? html`<span class="t-lo"><${Icon} name="eye" />${t('观战中 · 不占博士席位，模拟开始后可切换观看各位博士')}</span>`
    : !coop
      ? html`<span class="t-mint">${t('*模拟协议已就绪，准许进入模拟')}</span>`
    : facts.isHost
      ? facts.canStart
        ? html`<span class="t-mint">${t('*同盟人数达标，准许进入模拟')}</span>`
        : html`<span class="t-lo">${t('等待所有博士准备就绪')}</span>`
      : myReady
        ? html`<span class="t-mint">${t('已就绪 · 等待创建者开始模拟')}</span>`
        : html`<span class="t-lo">${t('准备就绪后，创建者即可开始模拟')}</span>`;

  return html`<div class=${`screen room-screen rs room-hub${coop ? '' : ' rs--solo'}${facts.seats.length > DEFAULT_ROOM_PLAYERS ? ' rs--big' : ''}`}
      data-hub-theme=${backdropTheme(bg)}
      style=${`--d-color:${DIFFICULTY_COLORS[room.difficulty]};--n:${facts.seats.length}${coop ? `;${seatGridStyle(facts.seats.length)}` : ''}`}>
    <${HubBackdrop} bg=${bg} />
    <${HubRadar} bg=${bg} />
    <header class="rs-top">
      <div class="rs-top__left">
        <${Tooltip} text=${t('离开同盟')} placement="bottom">
          <button type="button" class="rs-exit" disabled=${busy === 'leave'} onClick=${leave} aria-label=${t('离开同盟')}><${Icon} name="exit" /></button>
        <//>
        <div class="rs-clock">
          <b><${MicroLabel} tone="mint">${modeEn}<//>${t('同盟已等待')} <span class="num">${clock(elapsed)}</span></b>
          <span>${modeLabel} · ${t('当前延迟')} <${PingPill} ms=${pingOk ? conn.ping : null} online=${online} /></span>
        </div>
        <div class="rs-tools">
          <${GuideButton} class="room-guide" variant="secondary" size="sm" square=${true} />
          ${endless ? html`<${Button} variant="secondary" size="sm" square=${true} icon="info" onClick=${() => setEndlessTip(true)} title=${t('玩法提示')} aria-label=${t('玩法提示')} />` : null}
        </div>
      </div>
      <div class="rs-top__right">
        <${OnlinePill} class="room-online" />
        <${LoadoutButton} from="room" size="md" class="hub-plate hub-plate--loadout rs-loadout" label=${t('干员调配')} />
        ${coop ? html`<${InviteBox} code=${room.code} name=${me.name} difficulty=${room.difficulty} />` : html`<div class="rs-key rs-key--solo"><${MicroLabel}>SINGLE OPERATOR<//><span>${t('仅限 1 名博士')}</span></div>`}
      </div>
    </header>

    <main class="rs-seats">
      ${facts.seats.map((s, i) => html`<${SeatCard} key=${s ? `p${s.playerId}` : `e${i}`} seat=${s} index=${i} room=${room} facts=${facts}
        myId=${me.playerId} busy=${busy} onAddBot=${addBot} onRemoveBot=${removeBot} onKick=${kick} />`)}
      ${coop ? null : html`<aside class="solo-brief rs-brief brackets">
        <${MicroLabel} tone="mint">BRIEFING<//>
        ${sandbox
          ? html`<h2>${t('沙盒')}</h2>
            <p>${t('接下来自由探索吧')}</p>
            <ul><li>${t('进局先选地图与战场类型，之后用控制台自由编排')}</li></ul>`
          : html`<h2>${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''}<span class="num t-dim"> ${info.code}</span></h2>
            <p>${info.desc}</p>
            <ul>
              ${info.effects.map((e) => html`<li key=${e}>${e}</li>`)}
              <li>${t('共')} <b class="num">${info.rounds}</b> ${tc('rounds', '回合')}${info.hidden ? t('，满足条件时进入隐秘核心') : ''}</li>
              <li>${t('独立模拟中休整期与机变阶段不限时')}</li>
            </ul>`}
      </aside>`}
    </main>
    <${SpectatorBar} facts=${facts} myId=${me.playerId} busy=${busy} onRemove=${removeSpectator} onSit=${sit} />
    <${BigTeamBar} facts=${facts} />

    <footer class="rs-foot">
      <div class="rs-foot__left">
        <div class="rs-matchmaking-slot">
          ${room.matching && !room.inMatch ? html`<div class="room-matchmaking"
            title=${t('本同盟按房间人数匹配在线博士，人满即自动开始；也可由房主随时手动开始')}>
            <span class="room-matchmaking__dot" aria-hidden="true" />
            <span>${t('匹配中')}</span>
            <b class="num">${facts.humans.length}</b><span class="num t-dim">/${Number.isInteger(room.maxPlayers) ? room.maxPlayers : DEFAULT_ROOM_PLAYERS}</span>
          </div>` : null}
        </div>
      </div>
      <div class="rs-foot__center">
        <p class="rs-hint">
          ${coop ? html`<span class="rs-ready num" title=${t('已就绪')}>
            ${facts.humans.map((s) => html`<${Icon} key=${s.playerId} name="user" class=${facts.isReady(s) ? 'is-on' : ''} />`)}
            <b>${facts.readyHumans}</b>/${facts.humans.length}
          </span>` : null}${statusLine}
        </p>
        <div class="rs-pill">
          ${sandbox || endless ? null : html`<${DifficultyPill} room=${room} isHost=${facts.isHost} busy=${busy} onOpen=${() => setProtoOpen(true)} />`}
          ${coop && !room.inMatch && !endless ? html`<${RoomOptionsButton} room=${room} isHost=${facts.isHost} busy=${busy} onSet=${setOptions} onPrivate=${togglePrivate} />` : null}
        </div>
      </div>
      <div class="rs-foot__right">
        ${facts.isHost
          ? html`<button type="button" class=${`rs-go${facts.canStart ? ' is-ready' : ''}`} disabled=${!facts.canStart || !online || busy === 'start'} onClick=${start}
              title=${facts.canStart ? undefined : t('仍有博士未准备就绪')}>
              <span class="rs-go__box" aria-hidden="true"><${Icon} name="play" /></span>
              <span class="rs-go__label">${t('开始模拟')}</span>
            </button>`
          : facts.spectating
            ? html`<button type="button" class="rs-go" disabled=${true}><span class="rs-go__label"><${Icon} name="eye" />${t('观战中')}</span></button>`
          : html`<button type="button" class=${`rs-go${myReady ? ' is-ready' : ''}`} disabled=${!online || !facts.mine || busy === 'ready'} onClick=${toggleReady}
              title=${myReady ? t('再次点击取消就绪') : undefined}>
              <span class="rs-go__box" aria-hidden="true">${myReady ? html`<${Icon} name="check" />` : null}</span>
              <span class="rs-go__label">${myReady ? t('已就绪') : t('准备就绪')}</span>
            </button>`}
      </div>
    </footer>

    ${protoOpen && !sandbox && !endless && facts.isHost ? html`<${RoomProtocol} room=${room} busy=${busy} onClose=${() => setProtoOpen(false)} onPick=${setDifficulty} />` : null}

    <${Modal} open=${endlessTip} title=${t('无尽狂潮 · 玩法提示')} micro="ENDLESS TIDE" tone="mint"
      onClose=${() => setEndlessTip(false)} width="min(660px, 94vw)">
      <div class="endless-tip">
        <div class="endless-tip__grid">
          ${ENDLESS_RULES.map((sec) => html`<section class="endless-tip__sec" key=${sec.micro}>
            <header class="endless-tip__sechead">
              <span class="endless-tip__ic"><${Icon} name=${sec.icon} /></span>
              <span class="endless-tip__secname">${t(sec.name)}</span>
              <${MicroLabel}>${sec.micro}<//>
            </header>
            <ul class="endless-tip__list">
              ${sec.items.map((it, k) => html`<li key=${k}>${t(it)}</li>`)}
            </ul>
          </section>`)}
        </div>
        <div class="endless-tip__score">
          <span class="endless-tip__scoreic"><${Icon} name="crown" /></span>
          <span class="endless-tip__scorek">${t('成绩')}</span>
          <span class="endless-tip__scoretxt">${t('进打桩时的回合数 + 打桩累计伤害，记入大厅的两个无尽排行榜')}</span>
        </div>
        <div class="endless-tip__btns">
          <${Button} variant="primary" size="lg" icon="check" onClick=${() => setEndlessTip(false)}>${t('知道了')}<//>
        </div>
      </div>
    <//>
  </div>`;
}
