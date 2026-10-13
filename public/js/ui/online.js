// 在线人数 (this build's addition): the server's `lobby.stats` push, shown on the lobby and 组队 (room) screens.
//
// The server counts every CONNECTED session (server/lobby.js onlineStats — `stats().humans` only counts humans seated
// in a room, which is not "who is online") and pushes the frame on a 10 s timer, right after any message that changes
// who is where, and to a session the moment it says hello. So the number here is live without anyone polling.

import { html, Icon, Tooltip } from './components.js';
import { useStore, shallowEqual } from '../store.js';

/** The current counters, or null before the first push. */
export const useOnline = () => useStore((s) => s.online, shallowEqual);

/**
 * Compact「在线 N」pill with a breakdown tooltip.
 * @param {{ label?: boolean, class?: string, tone?: 'mint'|'ghost' }} props
 *   label: show the「在线」word next to the number (off for tight spots)
 */
export function OnlinePill({ label = true, class: cls, tone = 'mint' }) {
  const o = useOnline();
  const n = o ? o.online : null;
  const tip = o
    ? `服务器在线 ${o.online} 人（大厅 ${Math.max(0, o.online - o.inRoom)} · 房间 ${Math.max(0, o.inRoom - o.inMatch)} · 对局中 ${o.inMatch}）· 同盟房间 ${o.rooms} 个 · 进行中对局 ${o.matches}`
    : '正在获取在线人数…';
  return html`<${Tooltip} text=${tip} placement="bottom">
    <span class=${`onlinepill onlinepill--${tone}${cls ? ` ${cls}` : ''}`} data-testid="online">
      <span class="onlinepill__dot" aria-hidden="true"></span>
      <${Icon} name="users" class="onlinepill__icon" />
      <b class="onlinepill__n num">${n == null ? '–' : n}</b>
      ${label ? html`<span class="onlinepill__label">在线</span>` : null}
    </span>
  <//>`;
}
