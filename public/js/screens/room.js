// Room screen (同盟等待室): 4 seat cards (avatar frame, name, ready state, AI badge, host crown),
// host controls (difficulty picker, add/remove AI in co-op, start), invite code with copy code /
// copy link, ready toggle and leave.
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
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, MAX_SEATS, ROOM_PLAYER_OPTIONS, DEFAULT_ROOM_PLAYERS, ROOM_EXTENSIONS, ROOM_EXTENSIONS_DEFAULT, MAX_SPECTATORS, BIG_TEAM_NO_BAN, poolCopyMulFor, extensionsAreDefault } from '../../../shared/constants.js';
import {
  html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyTag, DifficultyIcon, Tooltip, Modal, confirmDialog, doctorNo,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { copyText } from '../ui/clipboard.js';
import { GuideButton } from '../ui/guide.js';
import { OnlinePill } from '../ui/online.js';
import { LoadoutButton } from './loadout.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, emptyMatch, isSpectating } from '../store.js';
import { difficultyInfo } from './lobby.js';
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
      noBan: occupied.length >= BIG_TEAM_NO_BAN || room?.endless === true,
      poolMul: poolCopyMulFor(occupied.length),
      bossMul: room?.mode === 'solo' ? 0.25 : Math.round((Math.min(MAX_SEATS, occupied.length) / 4) * 100) / 100,
    },
  };
}

/**
 * 大队伍规则提示 (this build): past the official 4 seats the coming match deviates in three ways — the Final Assault
 * leader pool scales with the roster, bonds stop being disabled past BIG_TEAM_NO_BAN, and the shared pool's copies scale
 * with the roster from 4 seats up to ×2 (shared/constants.js `poolCopyMulFor`). Mirrors server/match/Match.js.
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

function SeatCard({ seat, index, room, facts, myId, busy, onAddBot, onRemoveBot, onKick }) {
  const coop = room.mode !== 'solo';
  if (!seat) {
    const canAdd = coop && facts.isHost;
    return html`<article class="seat seat--empty" style=${`--seat-i:${index}`}>
      <header class="seat__head"><span class="seat__no num">P${index + 1}</span><${MicroLabel}>SEAT ${String(index + 1).padStart(2, '0')}<//></header>
      <div class="seat__art seat__art--empty">
        <div class="seat__radar" aria-hidden="true"></div>
        <span class="seat__wait">${t('等待博士加入')}</span>
        <${MicroLabel}>AWAITING DOCTOR<//>
      </div>
      <footer class="seat__foot">
        ${canAdd
          ? html`<${Button} variant="secondary" size="sm" icon="robot" block=${true} loading=${busy === `add`} onClick=${onAddBot}>${t('添加 AI 队友')}<//>`
          : html`<span class="seat__state t-dim">${t('空位')}</span>`}
      </footer>
    </article>`;
  }
  const isMe = seat.playerId === myId;
  const isHostSeat = seat.playerId === room.hostId;
  const offline = seat.connected === false && !seat.isBot;
  // The host never needs to toggle ready: starting the match readies them (server rule).
  const state = offline ? 'offline' : seat.ready || seat.isBot ? 'ready' : isHostSeat ? 'host' : 'waiting';
  return html`<article class=${`seat brackets${isMe ? ' is-me' : ''}${isHostSeat ? ' is-host' : ''}${seat.isBot ? ' is-bot' : ''} is-${state}`}
      style=${`--seat-i:${index}`}>
    <header class="seat__head">
      <span class="seat__no num">P${index + 1}</span>
      <${MicroLabel}>SEAT ${String(index + 1).padStart(2, '0')}<//>
      ${isHostSeat ? html`<span class="seat__host"><${Icon} name="crown" />${t('创建者')}</span>` : null}
    </header>
    <div class="seat__art">
      <div class="seat__stripes" aria-hidden="true"></div>
      <${AvatarFrame} size="xl" name=${seat.name} seat=${index} bot=${seat.isBot} self=${isMe} ready=${state === 'ready'} offline=${offline} />
      ${seat.isBot ? html`<span class="seat__bot-label"><${Icon} name="robot" />${t('AI 队友')}</span>` : null}
    </div>
    <div class="seat__who">
      <span class="seat__name">${seat.name || t('博士')}</span>
      ${isMe ? html`<span class="seat__you">${t('你')}</span>` : null}
    </div>
    <${MicroLabel}>${seat.isBot ? 'AUTONOMOUS UNIT' : `DOCTOR #${doctorNo(seat.playerId)}`}<//>
    <footer class="seat__foot">
      <span class=${`seat__state seat__state--${state}`}>
        ${state === 'ready' ? html`<${Icon} name="check" />${t('已就绪')}`
          : state === 'offline' ? html`<${Icon} name="wifiOff" />${t('连接中断')}`
          : state === 'host' ? html`<${Icon} name="crown" />${t('待命中')}`
          : html`<${Icon} name="hourglass" />${t('准备中')}`}
      </span>
      ${seat.isBot && facts.isHost ? html`<${Tooltip} text=${t('移除该 AI 队友')}>
        <${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rm${index}`} onClick=${() => onRemoveBot(index)} aria-label=${t('移除 AI 队友')} />
      <//>` : null}
      ${!seat.isBot && !isMe && facts.isHost ? html`<${Tooltip} text=${t('将该博士移出同盟')}>
        <${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `kick${index}`} onClick=${() => onKick(index, seat.name, seat.playerId)} aria-label=${t('移出该博士')} />
      <//>` : null}
    </footer>
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
    return html`<div class=${`vispill vispill--ro${isPublic ? ' is-public' : ' is-private'}`} title=${tip}>
      <${Icon} name=${isPublic ? 'eye' : 'close'} />
      <span>${label}</span>
    </div>`;
  }
  return html`<${Tooltip} text=${tip}>
    <button type="button" class=${`vispill${isPublic ? ' is-public' : ' is-private'}`}
      disabled=${!!busy} aria-pressed=${isPublic ? 'true' : 'false'} onClick=${onToggle}>
      <${Icon} name=${isPublic ? 'eye' : 'close'} />
      <span>${busy === 'vis' ? '切换中…' : label}</span>
    </button>
  <//>`;
}

function InviteBox({ code, name, difficulty }) {
  const copy = async (what) => {
    // the copied link carries an invitation line (#103): 「{name}邀请你加入卫戍协议：盟约【{difficulty}】」
    const invite = t('{name}邀请你加入卫戍协议：盟约【{difficulty}】', { name: name ?? '', difficulty: DIFFICULTY_NAMES[difficulty] ? t(DIFFICULTY_NAMES[difficulty]) : '' });
    const ok = await copyText(what === 'code' ? code : `${inviteLink(code)} ${invite}`);
    if (ok) toast(what === 'code' ? t('已复制同盟密钥 {code}', { code }) : t('已复制邀请链接'), 'success');
    else toast(t('复制失败，请手动复制'), 'warn');
  };
  return html`<div class="invite brackets">
    <div class="invite__label"><${Icon} name="key" /><span>${t('同盟密钥')}</span><${MicroLabel}>ALLIANCE KEY<//></div>
    <div class="invite__code num selectable" aria-label=${t('同盟密钥 {code}', { code })}>${[...String(code)].map((ch, i) => html`<span key=${i}>${ch}</span>`)}</div>
    <div class="invite__btns">
      <${Button} size="sm" icon="copy" onClick=${() => copy('code')}>${t('复制密钥')}<//>
      <${Button} size="sm" icon="link" onClick=${() => copy('link')}>${t('复制链接')}<//>
    </div>
  </div>`;
}

function DifficultyPicker({ room, isHost, busy, onPick }) {
  if (!isHost) {
    return html`<div class="dpick dpick--ro">
      <${DifficultyTag} difficulty=${room.difficulty} size="lg" code=${difficultyInfo(room.mode, room.difficulty).code} />
      <span class="t-dim">${t('由创建者选择')}</span>
    </div>`;
  }
  return html`<div class="dpick" role="radiogroup" aria-label=${t('模拟难度')}>
    ${DIFFICULTIES.map((d) => html`<button key=${d} type="button" role="radio" aria-checked=${room.difficulty === d ? 'true' : 'false'}
        class=${`dpick__opt${room.difficulty === d ? ' is-active' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[d]}`}
        disabled=${!!busy} onClick=${() => room.difficulty !== d && onPick(d)}>
      <${DifficultyIcon} difficulty=${d} />${t(DIFFICULTY_NAMES[d].replace('模拟', ''))}
    </button>`)}
  </div>`;
}

/** 玩法扩展 labels (shared/constants.js ROOM_EXTENSIONS). */
const EXT_LABEL = { revive: '复活队友', sharedLp: '共享血条', dupBand: '重复策略', bossPanel: 'DPS面板', deployCapOff: '取消部署上限' };

/**
 * 玩法扩展 (this build, server/lobby.js setOptions): a compact trigger in the room bar that opens a floating popover with
 * the optional rules (ROOM_EXTENSIONS — currently the teammate revive); the host toggles them, other members see them
 * read-only. 房间人数 lives in its own picker in the room bar (PlayerCountPicker), not here.
 * @param {{ room: any, isHost: boolean, busy: string | null, onSet: (patch: object) => void }} props
 */
function RoomOptionsButton({ room, isHost, busy, onSet }) {
  const [open, setOpen] = useState(false);
  // outside press / Esc closes the floating panel
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.ropts-pop')) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [open]);
  const ext = { ...ROOM_EXTENSIONS_DEFAULT, ...(room.extensions || {}) };
  // 非默认 (开了 sharedLp/dupBand/deployCapOff, 或关了 revive/bossPanel) → 本局不进排行榜 (server/lobby.js onMatchEnd)
  const nonDefault = !extensionsAreDefault(ext);
  return html`<div class="ropts-pop">
    <${Button} variant="secondary" size="lg" icon="bolt" active=${open} aria-expanded=${open ? 'true' : 'false'}
      onClick=${() => setOpen((v) => !v)}>${t('玩法扩展')}<//>
    ${open ? html`<div class="ropts" role="dialog" aria-label=${t('玩法扩展')}>
      <div class="ropts__head"><${Icon} name="bolt" /><span>${t('玩法扩展')}</span><${MicroLabel}>GAME OPTIONS<//></div>
      ${nonDefault ? html`<p class="ropts__tip"><${Icon} name="warn" />${t('用了非默认设置：本局结果不计入排行榜')}</p>` : null}
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
      <p class="ropts__tip">${t('复活的规则：任一队友被淘汰时，存活队友可消耗 10 点目标生命将其救回；获救者保留干员 / 装备 / 状态，恢复至 1 点生命，每人每局至多被救一次。')}</p>
      <p class="ropts__tip">${t('共享血条的规则：全队共用一条目标生命（各人之和），任意扣血都从总和里扣；总和降到 0 时全队失败。')}</p>
      <p class="ropts__tip">${t('重复策略的规则：开局选择策略时不再限制「队友已选」，多名博士可以选到同一个策略。')}</p>
      <p class="ropts__tip">${t('DPS面板：右上角显示我棋盘上每名干员本回合造成的伤害与每秒伤害（DPS），可点击收缩，全阶段可见；开启后同时显示「领袖伤害面板」——最终攻势 / 隐秘核心时另列全队对当前领袖的伤害占比。')}</p>
    </div>` : null}
  </div>`;
}

/**
 * 房间人数 (server/lobby.js setOptions maxPlayers): the room's own capacity (ROOM_PLAYER_OPTIONS, default 4) as a compact
 * chip row in the room bar, left of 干员调配. The host picks; other members see the current number. Hidden in solo.
 */
function PlayerCountPicker({ room, isHost, busy, onSet }) {
  // 无尽模式 is fixed at 4 players — the picker never shows (server also refuses room.setOptions maxPlayers)
  if (!room || room.inMatch || room.mode === 'solo' || room.endless === true) return null;
  const maxPlayers = Number.isInteger(room.maxPlayers) ? room.maxPlayers : DEFAULT_ROOM_PLAYERS;
  // seats already taken (highest occupied index + 1): the host may not shrink the room below them
  const occupied = (room.seats || []).reduce((n, s, i) => (s ? i + 1 : n), 0);
  return html`<div class="pcount">
    <span class="pcount__label">${t('房间人数')}</span>
    ${isHost
      ? html`<div class="pcount__chips" role="radiogroup" aria-label=${t('房间人数')}>
          ${ROOM_PLAYER_OPTIONS.map((n) => html`<button key=${n} type="button" role="radio" aria-checked=${maxPlayers === n ? 'true' : 'false'}
            class=${`pcount__chip${maxPlayers === n ? ' is-active' : ''}`} disabled=${!!busy || n < occupied}
            onClick=${() => maxPlayers !== n && onSet({ maxPlayers: n })}>${n}</button>`)}
        </div>`
      : html`<span class="pcount__num num">${maxPlayers}</span>`}
  </div>`;
}

/**
 * 无尽狂潮 规则速览 (房间屏弹窗, author 2026-10-13 重排): the flat 12-bullet list re-cut into four scannable cards
 * (阵容 / 成长 / 首领 / 藏品) + a 成绩 strip. Numbers come straight from shared/constants.js ENDLESS, so keep them in step
 * when the knobs move (ENEMY hp ×GROWTH_STEP/round from GROWTH_FROM; ATK ×ENEMY_ATK_GROWTH_STEP capped at ENEMY_ATK_HP_TRACK×teamHp;
 * DEF ×ENEMY_DEF_GROWTH_STEP capped at ENEMY_DEF_MUL_CAP;
 * BOSS_ROUND_FROM/STEP, BOSS_POOL_LIMIT/SWITCH, BOSS_TRASH_X; BOUNTY_FROM/STEP; RELIC_EVERY/DECISION_EVERY/SHOP_EVERY;
 * ARCHIVE_ROUNDS, DEPLOY_CAP, DUMMY_SECONDS). N_ marks the msgids (translated at render so a runtime 语言 switch applies).
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
  const [busy, setBusy] = useState(null);
  const [endlessTip, setEndlessTip] = useState(false); // 无尽狂潮玩法提示 (auto-opens on create / enter)
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);
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
  const setDifficulty = (difficulty) => run('diff', () => net.request('room.setDifficulty', { difficulty }));
  // 玩法扩展 (room.setOptions, host-only): the room's own player capacity and the optional rules (the 复活 toggle)
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

  return html`<div class="screen room-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${Tooltip} text=${t('离开同盟')} placement="bottom">
          <${Button} variant="danger" size="lg" square=${true} icon="exit" loading=${busy === 'leave'} onClick=${leave} aria-label=${t('离开同盟')} />
        <//>
        <div class="room-ping">
          <${PingPill} ms=${conn.ping} online=${online} />
          <${MicroLabel}>${t('当前延迟')}<//>
        </div>
        <${GuideButton} class="room-guide" variant="secondary" label=${t('玩法说明')} />
        ${endless ? html`<${Button} variant="secondary" size="lg" icon="info" onClick=${() => setEndlessTip(true)}>${t('玩法提示')}<//>` : null}
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">${endless ? 'ENDLESS WAR' : coop ? 'ALLIANCE LOBBY' : sandbox ? 'SANDBOX' : 'SOLO SIMULATION'}<//>
        <h1 class="topbar__title">${endless ? t('无尽狂潮') : coop ? t('同盟模拟') : sandbox ? t('沙盒') : t('独立模拟')}<span class="topbar__sep"></span><${DifficultyTag} difficulty=${room.difficulty} size="lg" label=${endless ? t('无尽模式') : sandbox ? t('沙盒') : undefined} /></h1>
      </div>
      <div class="topbar__right">
        <${OnlinePill} class="room-online" />
        ${coop ? html`<${VisibilityToggle} room=${room} isHost=${facts.isHost} busy=${busy} onToggle=${togglePrivate} />` : null}
        ${coop ? html`<${InviteBox} code=${room.code} name=${me.name} difficulty=${room.difficulty} />` : html`<div class="solo-note"><${MicroLabel}>SINGLE OPERATOR<//><span>${t('仅限 1 名博士')}</span></div>`}
      </div>
    </header>

    <main class=${`seats${coop ? '' : ' seats--solo'}`} style=${coop ? seatGridStyle(facts.seats.length) : undefined}>
      ${facts.seats.map((s, i) => html`<${SeatCard} key=${s ? `p${s.playerId}` : `e${i}`} seat=${s} index=${i} room=${room} facts=${facts}
        myId=${me.playerId} busy=${busy} onAddBot=${addBot} onRemoveBot=${removeBot} onKick=${kick} />`)}
      ${coop ? null : html`<aside class="solo-brief brackets">
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

    <footer class="room-bar">
      <div class="room-bar__left">
        ${sandbox || endless ? null : html`<span class="room-bar__label">${t('模拟难度')}<${MicroLabel}>DIFFICULTY<//></span>
        <${DifficultyPicker} room=${room} isHost=${facts.isHost} busy=${busy} onPick=${setDifficulty} />`}
        ${coop && !room.inMatch && !endless ? html`<${RoomOptionsButton} room=${room} isHost=${facts.isHost} busy=${busy} onSet=${setOptions} />` : null}
      </div>
      <div class="room-bar__center">
        <div class="ready-count" hidden=${!coop}>
          <span class="t-lo">${t('已就绪')}</span>
          <b class="num">${facts.readyHumans}</b><span class="num t-dim">/${facts.humans.length}</span>
          <span class="ready-count__icons" aria-hidden="true">
            ${facts.humans.map((s) => html`<${Icon} key=${s.playerId} name="user" class=${facts.isReady(s) ? 'is-on' : ''} />`)}
          </span>
        </div>
        ${room.matching && !room.inMatch ? html`<div class="room-matchmaking"
            title=${t('本同盟按房间人数匹配在线博士，人满即自动开始；也可由房主随时手动开始')}>
            <span class="room-matchmaking__dot" aria-hidden="true" />
            <span>${t('匹配中')}</span>
            <b class="num">${facts.humans.length}</b><span class="num t-dim">/${Number.isInteger(room.maxPlayers) ? room.maxPlayers : DEFAULT_ROOM_PLAYERS}</span>
          </div>` : null}
        <div class="room-bar__status">${statusLine}</div>
      </div>
      <div class="room-bar__right">
        <${PlayerCountPicker} room=${room} isHost=${facts.isHost} busy=${busy} onSet=${setOptions} />
        <${LoadoutButton} from="room" size="lg" class="room-loadout" label=${t('干员调配')} />
        ${facts.isHost
          ? html`<${Tooltip} text=${facts.canStart ? null : t('仍有博士未准备就绪')}>
              <${Button} variant="primary" size="xl" icon="play" loading=${busy === 'start'} disabled=${!facts.canStart || !online} onClick=${start}>${t('开始模拟')}<//>
            <//>`
          : facts.spectating
            ? html`<${Button} variant="secondary" size="xl" icon="eye" disabled=${true}>${t('观战中')}<//>`
          : html`<${Button} variant=${myReady ? 'primary' : 'secondary'} size="xl" icon=${myReady ? 'check' : 'hourglass'} active=${myReady}
              loading=${busy === 'ready'} disabled=${!online || !facts.mine} onClick=${toggleReady}>${myReady ? t('已就绪') : t('准备就绪')}<//>`}
      </div>
    </footer>

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
