// 房间大厅 (this build's addition, formerly 多人匹配): a browse panel over the server's open co-op rooms.
//
// The base game trades a 4-letter 同盟密钥 by hand (screens/lobby.js「加入同盟」). This panel instead asks the
// server what it currently has — `lobby.list`, answered by the `lobby.rooms` push (server/lobby.js `list`) — and
// joins with one click, plus 快速匹配: drop into the fullest open room, or open one when the server is quiet
// (`lobby.quickMatch`).
//
// A room whose match already runs cannot be joined but can be watched (room.spectate takes a spectator seat), and
// the host may hide their lobby-phase room from the list (`room.setPrivate`) without losing key-based joins.
//
// The list lives in the store (`mm`, fed by main.js) rather than in this component, so it survives closing and
// re-opening the panel and is refreshed on a timer while the panel is open.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, MicroLabel, Modal, Spinner, DifficultyTag } from './components.js';
import { toast, toastError } from './toasts.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual } from '../store.js';
import { useOnline } from './online.js';
import { t } from '../../../shared/i18n.js';

/** How often an open panel re-asks the server: it pushes the list on request only. */
export const MM_REFRESH_MS = 4000;

/** One room line. */
function RoomRow({ room, isMine, busy, onJoin, onSpectate }) {
  const players = Number.isFinite(room?.players) ? room.players : 0;
  const maxSeats = Number.isFinite(room?.maxSeats) ? room.maxSeats : 4;
  const full = players >= maxSeats;
  const joinable = !room.inMatch && !full;
  // 房间大厅: the running match's current round (0 = still in the lobby) — see server/lobby.js toSummary
  const round = Number.isFinite(room?.round) ? room.round : 0;
  const state = room.inMatch ? '进行中' : full ? '已满' : '招募中';
  return html`<li class=${`mm-row${room.inMatch ? ' is-running' : ''}${isMine ? ' is-mine' : ''}`}>
    <span class="mm-row__code num">${room.code}</span>
    <span class="mm-row__main">
      <span class="mm-row__host">${room.hostName || '未知博士'}${isMine ? html`<span class="mm-row__self">我的同盟</span>` : null}</span>
      <span class="mm-row__meta">
        <${DifficultyTag} difficulty=${room.difficulty} size="sm" label=${room.endless ? t('无尽狂潮') : undefined} />
        ${round > 0 ? html`<span class="mm-row__tag mm-row__tag--round" title="当前进行的回合">第 <span class="num">${round}</span> 回合</span>` : null}
        <span class="mm-row__seats" title="已入座博士 / 席位总数">
          <${Icon} name="users" />
          <span class="num">${players}</span><span class="t-dim num">/${maxSeats}</span>
        </span>
        ${room.spectators ? html`<span class="mm-row__spec" title="观战人数">
          <${Icon} name="eye" /><span class="num">${room.spectators}</span>
        </span>` : null}
        <span class=${`mm-row__tag${joinable ? ' mm-row__tag--open' : ''}`}>${state}</span>
      </span>
    </span>
    <span class="mm-row__act">
      <${Button} variant="primary" size="sm" icon="users" disabled=${!joinable}
        loading=${busy === `join:${room.code}`} onClick=${() => onJoin(room.code)}>加入<//>
      <${Button} variant="secondary" size="sm" icon="eye" disabled=${isMine}
        loading=${busy === `watch:${room.code}`} onClick=${() => onSpectate(room.code)}>观战<//>
    </span>
  </li>`;
}

/**
 * The 房间大厅 overlay.
 * @param {{ open: boolean, onClose?: () => void }} props
 */
export function MatchmakingPanel({ open, onClose }) {
  const mm = useStore((s) => s.mm, shallowEqual);
  const me = useStore((s) => s.me, shallowEqual);
  const room = useStore((s) => s.room, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const [busy, setBusy] = useState(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const online = conn.status === 'online';

  // Poll while open (and while online). `net.send` rather than `net.request`: a list refresh never needs an
  // answer, and a rid-less frame that the server rate-limits is dropped silently instead of raising an error toast
  // — the next tick recovers anyway.
  useEffect(() => {
    if (!open || !online) return undefined;
    net.send('lobby.list');
    const id = setInterval(() => net.send('lobby.list'), MM_REFRESH_MS);
    return () => clearInterval(id);
  }, [open, online]);

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast('尚未连接到服务器，请稍候', 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const join = (code) => run(`join:${code}`, async () => {
    await net.request('room.join', { code });
    toast(`已加入同盟 ${code}`, 'success');
    onClose?.();
  });

  const spectate = (code) => run(`watch:${code}`, async () => {
    await net.request('room.spectate', { code });
    toast(`正在观战同盟 ${code}`, 'success');
    onClose?.();
  });

  const quick = () => run('quick', async () => {
    const before = store.get().room;
    await net.request('lobby.quickMatch', {});
    // Already sitting in a lobby-phase co-op room: the server publishes it instead of moving us out of it, and
    // that server-side fact is not visible in the reply — so the wording follows what we knew beforehand.
    if (before && before.mode === 'coop' && !before.inMatch) {
      toast(before.isPublic === false
        ? '已把你的同盟公开到房间大厅，等待其他博士加入'
        : '你的同盟已在房间大厅中，等待其他博士加入', 'success');
    } else {
      toast('已为你匹配到同盟', 'success');
    }
    onClose?.();
  });

  const toggleVisible = () => run('vis', async () => {
    const hide = room?.isPublic !== false;
    await net.request('room.setPrivate', { private: hide });
    toast(hide ? '已从房间大厅列表中隐藏，同盟密钥仍可加入' : '已在房间大厅中公开', 'success');
  });

  const rooms = Array.isArray(mm.rooms) ? mm.rooms : [];
  // 在线人数 (this build): the live lobby.stats counters (pushed to everyone on a timer) beat the stats snapshot that
  // only arrives with a lobby.rooms reply — prefer them, and fall back while the first push is still in flight.
  const live = useOnline();
  const stats = live
    ? { humans: live.online, rooms: live.rooms, matches: live.matches }
    : mm.stats;
  const isHost = !!room && me.playerId != null && room.hostId === me.playerId;
  const isPublic = room?.isPublic !== false;

  return html`<${Modal} open=${open} title="房间大厅" micro="ROOM HALL"
      tone="mint" onClose=${onClose} width="min(720px, 94vw)">
    <div class="mm">
      <div class="mm-stats">
        <span class="mm-stat"><span class="mm-stat__v num">${stats ? stats.humans : '–'}</span><span class="mm-stat__k">在线博士</span></span>
        <span class="mm-stat"><span class="mm-stat__v num">${stats ? stats.rooms : rooms.length}</span><span class="mm-stat__k">同盟房间</span></span>
        <span class="mm-stat"><span class="mm-stat__v num">${stats ? stats.matches : 0}</span><span class="mm-stat__k">进行中对局</span></span>
        <span class="mm-stats__end">
          ${isHost ? html`<${Button} variant=${isPublic ? 'secondary' : 'primary'} size="sm"
            icon=${isPublic ? 'eye' : 'close'} loading=${busy === 'vis'} onClick=${toggleVisible}
            title=${isPublic ? '隐藏后其他博士不会在列表中看到本同盟，密钥仍可加入' : '公开后本同盟会出现在其他博士的房间大厅列表中'}>
            ${isPublic ? '公开中 · 点击隐藏' : '已隐藏 · 点击公开'}
          <//>` : null}
          <${Button} variant="ghost" size="sm" icon="refresh" disabled=${!online}
            onClick=${() => net.send('lobby.list')} title="立即刷新">刷新<//>
        </span>
      </div>

      ${!online
        ? html`<div class="mm-empty"><${Spinner} size="sm" label="CONNECTING" /></div>`
        : rooms.length
          ? html`<ul class="mm-list">
              ${rooms.map((r) => html`<${RoomRow} key=${r.code} room=${r}
                isMine=${!!room && room.code === r.code} busy=${busy}
                onJoin=${join} onSpectate=${spectate} />`)}
            </ul>`
          : html`<div class="mm-empty">
              <${Icon} name="search" />
              <p>当前没有公开的同盟房间</p>
              <p class="mm-hint">点下面的「快速匹配」会直接为你开一个，也可以回大厅创建后邀请同伴。</p>
            </div>`}

      <p class="mm-foot">
        <${MicroLabel}>AUTO-REFRESH ${MM_REFRESH_MS / 1000}S<//>
        <span class="t-dim">列表每 ${MM_REFRESH_MS / 1000} 秒自动刷新；观战不占博士席位，「进行中」的同盟只能观战。</span>
      </p>
    </div>
  <//>`;
}

/**
 * The 房间大厅 entry button + its overlay, as one unit so a screen only mounts this.
 */
export function MatchmakingButton({ variant = 'primary', size = 'lg', class: cls }) {
  const [open, setOpen] = useState(false);
  return html`<span class=${cls}>
    <${Button} variant=${variant} size=${size} icon="signal" onClick=${() => setOpen(true)}>房间大厅<//>
    <${MatchmakingPanel} open=${open} onClose=${() => setOpen(false)} />
  </span>`;
}
