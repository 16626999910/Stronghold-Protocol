// 对领袖伤害面板 (this build): during the Final Assault / Hidden Core a compact card in the TOP-RIGHT corner lists the
// living players' damage to the CURRENT leader, live — the leader is one pool shared by every boss field, so the team
// races one health bar (official tip "所有人将一起对敌方领袖造成伤害").
//
// The numbers come from m.public.bossBy (server/match/match/views.js: the boss pool's own per-player tally for the
// round's leader, ~1 Hz). Rows sort by damage; the viewer's own row is highlighted (你) and the share bar is relative to
// the leader of the race, so the card reads as a ranking. Only the LIVING are listed (an eliminated teammate's damage
// is not shown; the header total is the sum of the rows, so the percentages stay consistent).
//
// Position: the card is the first child of the top-right HUD column (.gm__right, public/css/screens/game.css), stacked
// ABOVE the 机变 effects column so the two can never overlap however many players are listed. It is only built during a
// boss phase.

import { html } from './components.js';
import { PlayerAvatar, GIcon } from './gameComponents.js';
import { fmtNum, isBossPhase } from './gameLogic.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** Whether a player is still in the match (m.public players[]: `alive`, and `status` for a departed seat). */
const isLiving = (p) => !!p && p.alive !== false && p.status !== 'dead' && p.status !== 'left';

/**
 * Whether the room's 玩法扩展 has the 领袖伤害面板 on — `bossPanel`, default ON (a room only turns it off deliberately;
 * the server also stops sending m.public.bossBy while it is off, so the card has nothing to draw either way).
 * @param {any} pub m.public
 */
export const bossPanelOn = (pub) => pub?.extensions?.bossPanel !== false;

/**
 * The rows of the card: every LIVING player with damage > 0 (or, before anyone has struck, every living player), most
 * damage first. Pure so tests can pin the ordering / shares without a DOM.
 * @param {any} pub m.public
 * @param {string|null} me the viewer's playerId
 * @returns {{ rows: {playerId:string,name:string,player:any,damage:number,share:number,pct:string,self:boolean}[], total:number, top:number }}
 */
export function bossDamageRows(pub, me = null) {
  const players = Array.isArray(pub?.players) ? pub.players.filter(isLiving) : [];
  const by = pub && pub.bossBy && typeof pub.bossBy === 'object' ? pub.bossBy : {};
  const list = players.map((p) => ({
    player: p, playerId: p.playerId, name: p.name || p.playerId,
    damage: Math.max(0, Math.round(Number(by[p.playerId]) || 0)),
  }));
  // before the first hit: the whole living team at 0 (the card is still the scoreboard); after it, only who has struck —
  // a long tail of 0s would push the card down the screen
  const rows = (list.some((r) => r.damage > 0) ? list.filter((r) => r.damage > 0) : list)
    .sort((a, b) => b.damage - a.damage || (a.player.seat | 0) - (b.player.seat | 0));
  const total = rows.reduce((s, r) => s + r.damage, 0);
  const top = rows.length ? rows[0].damage : 0;
  return {
    total,
    top,
    rows: rows.map((r) => ({
      ...r,
      self: r.playerId === me,
      share: top > 0 ? r.damage / top : 0,
      pct: total > 0 ? Math.round((r.damage / total) * 100) : 0,
    })),
  };
}

/**
 * The card. Rendered by the game screen only in a boss phase (FINAL_ASSAULT / HIDDEN_CORE); null otherwise so the
 * caller can drop it in unconditionally.
 * @param {{ pub:any, me:string|null }} props
 */
export function BossDamagePanel({ pub, me = null }) {
  if (!isBossPhase(pub?.phase) || !bossPanelOn(pub)) return null;
  const { rows, total } = bossDamageRows(pub, me);
  return html`<div class="bossdmg" role="status" data-testid="boss-damage-panel" aria-label=${t('对领袖伤害')}>
    <div class="bossdmg__head">
      <${GIcon} name="skull" class="bossdmg__icon" />
      <span class="bossdmg__title">${t('对领袖伤害')}</span>
      <span class="bossdmg__total num" title=${t('全队合计')}>${total > 0 ? fmtNum(total) : '—'}</span>
    </div>
    ${rows.length ? html`<ul class="bossdmg__list">
      ${rows.map((r) => html`<li key=${r.playerId} class=${cx('bossdmg__row', r.self && 'is-self')}>
        <${PlayerAvatar} player=${r.player} size="sm" self=${r.self} />
        <span class="bossdmg__who" title=${r.name}>${r.self ? t('你') : r.name}</span>
        <span class="bossdmg__track"><i style=${`width:${Math.round(r.share * 100)}%`}></i></span>
        <b class="bossdmg__num num">${fmtNum(r.damage)}</b>
        <span class="bossdmg__pct num">${r.pct}%</span>
      </li>`)}
    </ul>` : html`<p class="bossdmg__empty">${t('等待对领袖造成伤害…')}</p>`}
  </div>`;
}
