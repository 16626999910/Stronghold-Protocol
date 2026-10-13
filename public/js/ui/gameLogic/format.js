// ui/gameLogic/format.js — HUD numbers, status glyphs, range boxes, unit flags. Re-exported from ../gameLogic.js.

import { UF } from '../../../../shared/constants.js';
import { clamp, isObj, tileKey } from './shared.js';
import { N_, langInfo } from '../../../../shared/i18n.js';


// ---- players, statuses, fields ------------------------------------------------------------------------

/** Status → glyph + text (research 06 §11.1). */
export const STATUS_META = Object.freeze({
  acting: { glyph: 'dots', text: N_('行动中'), tone: 'lo' },
  ready: { glyph: 'check', text: N_('已就绪'), tone: 'mint' },
  deciding: { glyph: 'hourglass', text: N_('决策中'), tone: 'gold' },
  combat: { glyph: 'sword', text: N_('作战中'), tone: 'orange' },
  done: { glyph: 'check', text: N_('作战结束'), tone: 'mint' },
  helping: { glyph: 'shield', text: N_('联防中'), tone: 'orange' },
  left: { glyph: 'exit', text: N_('已离开'), tone: 'red' },
  dead: { glyph: 'close', text: N_('已淘汰'), tone: 'red' },
});

// ---- 无尽模式: text cleanup ---------------------------------------------------------------------------------

/**
 * 无尽模式: drop the 「最多叠加 N 层/次」「每场战斗至多 N 层/次」「最多 N 层」 stack-cap wording from a talent / skill /
 * 特质 description (the cap is lifted there — sim/battle/status.js noStackLimit, garrisons/battle.js noPerBattleCap;
 * author 2026-10-12 「后面加的圣葬人那批文字描述补上」 extended it to the newer batch's phrasings, e.g. 圣约送葬人
 * 「（最多4层）」, whose cap has no 叠加). Also drops the 盟约(阵营) bonus caps 「至多+300%」/「至多+{0:0%}」 (拉特兰 / 卡西米尔 /
 * 萨尔贡, lifted by sim/content/bonds/core.js noBondCap) — the `+` keeps target caps like「至多2名」out. Only the cap
 * clause is removed (inline or inside a parenthetical), so other text in the same brackets survives; a bracket left empty
 * goes with it. Non-matching text is returned unchanged.
 * @param {string} text
 * @returns {string}
 */
export function stripStackCap(text) {
  if (typeof text !== 'string' || !text) return text;
  // 最多[可以][可][叠加] N 层/次 · 至多 N 层/次 · 每场战斗|作战至多 N 层/次
  const cap = '(?:最多(?:可以)?(?:可)?(?:叠加)?|至多|每场(?:战斗|作战)至多)';
  let out = text
    // the cap clause itself (an optional leading comma goes with it); a lone parenthetical cap leaves （） behind
    .replace(new RegExp(`[，,]?\\s*${cap}\\s*\\d+\\s*[层次]`, 'g'), '')
    // 盟约(阵营)加成的「至多+…」(拉特兰/卡西米尔/萨尔贡, e.g. 至多+300% / 至多+{0:0%}): the '+' keeps target caps like
    // 「至多2名」out of it; markup (<@ba.vup>) between 至多 / + / the number is skipped
    .replace(new RegExp('[，,]?\\s*至多\\s*(?:<[^>]*>\\s*)*\\+\\s*(?:<[^>]*>\\s*)*[\\d{][^，,。；;）)]*', 'g'), '')
    // tidy what is left: an emptied bracket, a dangling comma right after 「（」 / before 「）」, a comma before 。；
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/[（(]\s*[，,]\s*/g, '（')
    .replace(/[，,]\s*[）)]/g, '）')
    .replace(/[，,]\s*([。；;])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out;
}

// ---- snapshots / battle HUD ---------------------------------------------------------------------------------

/**
 * HUD numbers from a b.snap: { killed, total, dp, boss } (boss: { hp, max } when present).
 * @param {any} snap
 */
export function snapHud(snap) {
  if (!isObj(snap)) return null;
  const n = (v) => (Number.isFinite(v) ? v : null);
  let boss = null;
  if (isObj(snap.boss) && Number.isFinite(snap.boss.hp)) boss = { hp: snap.boss.hp, max: n(snap.boss.max) ?? n(snap.boss.maxHp) };
  return { killed: n(snap.killed), total: n(snap.total), dp: n(snap.dp), boss };
}

/** Boss HP fraction 0..1 (null when unknown). */
export function bossFrac(bossHp) {
  if (!isObj(bossHp)) return null;
  const hp = Number(bossHp.hp);
  const max = Number(bossHp.max ?? bossHp.maxHp);
  if (!Number.isFinite(hp) || !Number.isFinite(max) || max <= 0) return null;
  return clamp(hp / max, 0, 1);
}

/**
 * The boss bar's percentage text for a fraction (bossFrac): whole percents from 10 %, one decimal below, and never
 * "0.0%" while the leader still has HP — a sliver reads "<0.1%" (user playtest #6 item 5: a bar at 0.0 % with the
 * leader still fighting read as a leader that could not die). null for an unknown fraction.
 * @param {number|null} frac
 */
export function bossPctText(frac) {
  if (frac == null || !Number.isFinite(frac)) return null;
  const pct = clamp(frac, 0, 1) * 100;
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct > 0 && pct < 0.05) return '<0.1%';
  return `${pct.toFixed(1)}%`;
}

/** Whether a snapshot unit tuple has a flag. */
export const hasFlag = (flags, bit) => (Number(flags) & bit) !== 0;
export { UF };

// ---- stats & range --------------------------------------------------------------------------------------------

/** Attack interval in seconds (bat × 100 / aspd). */
export function attackInterval(bat, aspd = 100) {
  const b = Number(bat);
  const a = Number(aspd) > 0 ? Number(aspd) : 100;
  if (!Number.isFinite(b) || b <= 0) return null;
  return b * 100 / a;
}

/**
 * Compact number: 12345 → '12,345'; a language whose pack names 10⁴-step units (`_meta.numberUnits`, shared/i18nPacks.js —
 * Chinese 万 / 亿 / 兆 / 京 / 垓 …) picks the largest that fits: 1.5e6 → '150万', 2.5e8 → '2.5亿', 6.5e17 → '65京',
 * 6.9e34 → '690沟'; past the last unit it falls back to scientific (1e48 → '1.00e+48'). A language without them uses the
 * thousands ladder: 1.5e6 → '1.5M', 2.5e5 → '250K', 3e9 → '3B', 1.5e12 → '1.5T' (English), then scientific.
 */
export function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const units = langInfo()?.numberUnits;
  if (!Array.isArray(units) || !units.length) {
    if (a >= 1e15) return n.toExponential(2);
    if (a >= 1e12) return `${(n / 1e12).toFixed(a >= 1e13 ? 0 : 1)}T`;
    if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    if (a >= 1e5) return `${Math.round(n / 1e3)}K`;
    return Math.round(n).toLocaleString('en-US');
  }
  // 10⁴ ladder: units[i] names 10^(4·(i+1)) — walk down to the largest that fits; below 10万 the plain number shows
  let i = units.length - 1;
  while (i >= 0 && a < 10 ** (4 * (i + 1))) i--;
  if (i < 0 || (i === 0 && a < 1e5)) return Math.round(n).toLocaleString('en-US');
  const m = n / 10 ** (4 * (i + 1));
  if (Math.abs(m) >= 1e4) return n.toExponential(2); // past the largest unit → scientific, not "10000载"
  const dec = i === 0 ? (a >= 1e6 ? 0 : 1) : i === 1 ? (a >= 1e9 ? 0 : 1) : (Math.abs(m) >= 10 ? 0 : 1);
  return `${m.toFixed(dec)}${units[i]}`;
}

/**
 * Bounding box + cell set of a range grid (always including the own tile [0,0]); `mirror` flips columns.
 * @param {Array<[number, number]>} grid [[dRow, dCol], …]
 * @param {boolean} [mirror]
 * @returns {{ rows: number, cols: number, r0: number, c0: number, cells: Set<string>, self: [number, number] }}
 */
export function rangeGridBox(grid, mirror = false) {
  const cells = new Set();
  let minR = 0; let maxR = 0; let minC = 0; let maxC = 0;
  for (const g of Array.isArray(grid) ? grid : []) {
    if (!Array.isArray(g) || !Number.isFinite(g[0]) || !Number.isFinite(g[1])) continue;
    const r = g[0];
    const c = mirror ? -g[1] : g[1];
    cells.add(tileKey(r, c));
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  }
  return { rows: maxR - minR + 1, cols: maxC - minC + 1, r0: maxR, c0: minC, cells, self: [0, 0] };
}
