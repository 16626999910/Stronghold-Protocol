// ui/tempNotice.js — 临时「2:00 更新」弹窗 (作者 2026-10-14)。一次性: 大厅 / 房间 / 对局都显示, 点一次 (「知道了」)
// 即永久关闭; 到后端重启那一刻 (服务器下发的 tempRestartAt) 自动隐藏。
// ⚠️ 与「临时重启」同属一块临时代码 —— 后端重启更新完成后**一起整块删除**:
//   本文件 + main.js 里的 import 与 <${TempNoticeHost} /> 挂载 (服务端删 restart.js 临时块 / boot.js 调用 / lobby.js tempRestartAt)。
import { useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button } from './components.js';
import { useStore, serverNow } from '../store.js';
import { t } from '../../../shared/i18n.js';

/** ⚠️ 临时: 后端临时重启代码已删、不再下发 `tempRestartAt` 时的兜底时刻（北京 2026-10-15 02:00 = UTC 18:00Z）。 */
export const TEMP_NOTICE = {
  id: 'tmp-2026-10-15-0200-update',
  until: Date.UTC(2026, 9, 14, 18, 0, 0),
  title: '临时更新提示',
  micro: 'MAINTENANCE · 02:00',
};

const seenKey = () => `sp.notice.seen.${TEMP_NOTICE.id}`;

/**
 * The notice is due while `now < until` and it has not been dismissed. `at` = the server's temp-restart epoch
 * (`m.public`/welcome `tempRestartAt`, server clock) — when present it wins over the fallback, so the popup and the
 * restart always share one instant. `now` defaults to the server-corrected clock.
 */
export function tempNoticeDue(now = serverNow(), at = null) {
  const until = Number.isFinite(at) ? at : TEMP_NOTICE.until;
  if (!(Number(now) < until)) return false;
  try { return globalThis.localStorage?.getItem(seenKey()) !== '1'; } catch { return false; }
}

/** Global host (mounted once by main.js): the temp notice shows over ANY screen (大厅 / 房间 / 对局). */
export function TempNoticeHost() {
  // 订阅服务端下发的重启时刻 (welcome): 到点 (serverNow >= tempRestartAt) 即不再显示
  const at = useStore((s) => (Number.isFinite(s.tempRestartAt) ? s.tempRestartAt : null));
  const [closed, setClosed] = useState(false);
  if (closed || !tempNoticeDue(serverNow(), at)) return null;
  const close = () => { try { globalThis.localStorage?.setItem(seenKey(), '1'); } catch { /* ignore */ } setClosed(true); };
  return html`<${Modal} open=${true} title=${TEMP_NOTICE.title} micro=${TEMP_NOTICE.micro} tone="mint" onClose=${close} width="min(560px, 94vw)">
    <div class="tempnotice">
      <p class="tempnotice__text">${t('服务器将在北京时间 02:00 进行后端更新重启，届时所有对局都会掉线，请尽量避开该时段开新局。更新内容见大厅「更新公告」。')}</p>
      <div class="tempnotice__acts"><${Button} variant="primary" onClick=${close}>${t('知道了')}<//></div>
    </div>
  <//>`;
}
