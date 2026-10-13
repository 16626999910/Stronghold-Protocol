// DPS 面板 (this build): a compact, COLLAPSIBLE card in the TOP-RIGHT HUD column (.gm__right, public/css/screens/game.css)
// listing the operators on the viewer's OWN board with the damage each dealt THIS round and its 每秒伤害 (DPS).
//
// It is a SEPARATE panel from 领袖伤害面板 (ui/bossDamage.js): that one shows the team's damage share to the CURRENT
// leader (boss phases only, from m.public.bossBy); this one shows the viewer's own operators (every in-battle phase,
// computed locally). Both are governed by the SAME 玩法扩展 toggle (`bossPanel`, default on): one switch turns the two
// panels on/off together.
//
// Data: purely local — the numbers come from the browser's own simulation of the field (battle/runner.js `damageOf`: each
// ally unit's `stats.dmg` of the battle on screen, keyed by the board uid, plus the battle's game clock). Nothing goes
// through the server, so it updates as fast as the local sim steps and resets by itself when a new round's battle starts
// (a fresh battle, damage 0). The board pieces come from m.private (priv.board); names / thumbnails resolve from data.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { UnitThumb, GIcon } from './gameComponents.js';
import { fmtNum, ownDiyRecord } from './gameLogic.js';
import { data } from '../data.js';
import { PHASE } from '../../../shared/constants.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * Whether the room's 玩法扩展 has the DPS / 领袖伤害 panels on — `bossPanel`, default ON (default on; a room only turns
 * it off deliberately). ONE switch governs both panels (ui/dpsPanel.js + ui/bossDamage.js).
 * @param {any} pub m.public
 */
export const dpsPanelOn = (pub) => pub?.extensions?.bossPanel !== false;

/**
 * The phases the DPS 面板 shows in: every phase of a running round (休整期 / 回合开始 / 作战 / 联防 / 结算 / 最终攻势 /
 * 隐秘核心) — it does NOT vanish while waiting (author). Hidden only before the board exists (信息确认 / 选盟约 / 悬赏).
 */
export const dpsPanelVisible = (pub) => {
  const p = pub?.phase;
  return p === PHASE.ROUND_START || p === PHASE.PREP || p === PHASE.COMBAT || p === PHASE.UNITE
    || p === PHASE.SETTLE || p === PHASE.FINAL_ASSAULT || p === PHASE.HIDDEN_CORE;
};

/**
 * The card's rows: the viewer's own operators, most damage first, each with this round's damage and 每秒伤害
 * (damage / elapsed). Pure so the ordering / shares / DPS can be pinned without a DOM.
 * @param {{ uid:any, name?:string, piece?:any, damage?:number }[]} ops the viewer's board operators (damage already
 *   joined in), or the raw pieces with `damage` on each
 * @param {number} elapsed the round's battle clock in game seconds
 * @returns {{ rows: object[], total:number, top:number, elapsed:number }}
 */
export function dpsRows(ops, elapsed = 0) {
  const el = Math.max(0, Number(elapsed) || 0);
  const list = (Array.isArray(ops) ? ops : [])
    .filter((o) => o && o.uid != null)
    .map((o) => ({ uid: o.uid, piece: o.piece ?? null, rec: o.rec ?? null, name: o.name || '', damage: Math.max(0, Math.round(Number(o.damage) || 0)) }));
  const rows = [...list].sort((a, b) => b.damage - a.damage);
  const total = rows.reduce((s, r) => s + r.damage, 0);
  const top = rows.length ? rows[0].damage : 0;
  return {
    total,
    top,
    elapsed: el,
    rows: rows.map((r) => ({ ...r, share: top > 0 ? r.damage / top : 0, dps: el > 0 ? r.damage / el : 0 })),
  };
}

/**
 * The record a board piece shows: for a filled 自选 slot (chess_char_*_diy*_*) the player's composed operator record
 * (m.private.diy via shared/diy.js diyRecordOf — the name/art the shop and bond strip show), else the plain chess
 * record. Without this a 自选 piece has no name/avatar (its slot record is a bare body-less shell).
 * @param {any} piece a m.private board piece @param {any} priv m.private
 */
function pieceRecord(piece, priv) {
  const chess = piece && data.lookup('chess', piece.id);
  const dd = { chess: data.get('chess'), backups: data.get('backups') };
  return ownDiyRecord(chess, priv, dd) || chess;
}

const sameMap = (a, b) => {
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
};

/**
 * The card. Collapsible (click the header); null before the board exists / while the 玩法扩展 is off, so the caller can
 * drop it in unconditionally. Polls the local runner for the own board's live damage (~2 Hz) — no server round trip.
 * @param {{ pub:any, ops?:object[], runner?:any, fieldId?:string|null }} props `ops` = the viewer's board operators
 *   (m.private `priv.board` pieces, `{ uid, piece }`); `runner` = battle/runner.js singleton (null in Node / server-run).
 */
export function DpsPanel({ pub, ops = [], priv = null, runner = null, fieldId = null }) {
  const [open, setOpen] = useState(true);
  const [live, setLive] = useState({ damage: {}, elapsed: 0 });
  useEffect(() => {
    if (!runner) { setLive((v) => (v.elapsed || Object.keys(v.damage).length ? { damage: {}, elapsed: 0 } : v)); return undefined; }
    let dead = false;
    const tick = () => {
      let r = null;
      try { r = runner.damageOf ? runner.damageOf(fieldId) : null; } catch { r = null; }
      if (dead) return;
      const next = r && r.damage ? r : { damage: {}, elapsed: 0 };
      setLive((prev) => (prev.elapsed === next.elapsed && sameMap(prev.damage, next.damage) ? prev : next));
    };
    tick();
    const h = setInterval(tick, 600);
    return () => { dead = true; clearInterval(h); };
  }, [runner, fieldId]);
  if (!dpsPanelVisible(pub) || !dpsPanelOn(pub)) return null;
  const withDmg = (Array.isArray(ops) ? ops : []).map((o) => {
    const rec = o.rec || pieceRecord(o.piece, priv);
    return { ...o, rec, name: o.name || rec?.name || (o.piece && o.piece.id) || '', damage: live.damage[o.uid] || 0 };
  });
  const { rows, total } = dpsRows(withDmg, live.elapsed);
  return html`<div class=${cx('dpspanel', !open && 'is-collapsed')} role="status" data-testid="dps-panel" aria-label=${t('DPS面板')}>
    <button type="button" class="dpspanel__head" aria-expanded=${open} aria-label=${open ? t('收起') : t('展开')}
      onClick=${() => setOpen(!open)}>
      <${GIcon} name="bolt" class="dpspanel__icon" />
      <span class="dpspanel__title">${t('DPS面板')}</span>
      <span class="dpspanel__total num" title=${t('本回合全队总伤害')}>${total > 0 ? fmtNum(total) : '—'}</span>
      <span class="dpspanel__chev" aria-hidden="true">${open ? '▾' : '▸'}</span>
    </button>
    ${open ? html`<div class="dpspanel__body">
      ${rows.length ? html`<ul class="dpspanel__list" data-testid="dps-rows">
        ${rows.map((r) => html`<li key=${r.uid} class="dpspanel__row">
          <${UnitThumb} kind="chess" id=${r.piece && r.piece.id} rec=${r.rec} golden=${!!(r.piece && r.piece.golden) || !!r.rec?.isGolden} size="xs" class="dpspanel__thumb" />
          <span class="dpspanel__who" title=${r.name}>${r.name}</span>
          <span class="dpspanel__track"><i style=${`width:${Math.round(r.share * 100)}%`}></i></span>
          <b class="dpspanel__num num" title=${t('本回合伤害')}>${fmtNum(r.damage)}</b>
          <span class="dpspanel__dps num" title=${t('每秒伤害')}>${r.dps > 0 ? `${fmtNum(Math.round(r.dps))}/s` : '—'}</span>
        </li>`)}
      </ul>` : html`<p class="dpspanel__empty">${t('等待造成伤害…')}</p>`}
    </div>` : null}
  </div>`;
}
