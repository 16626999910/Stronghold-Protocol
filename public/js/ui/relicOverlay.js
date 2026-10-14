// ui/relicOverlay.js — 无尽狂潮 肉鸽 (author 2026-10-12): 一个弹窗里 3 选 1 —— 竖向长方卡片、按品质配色。
// 三类: 专属盟约 (彩, 用核心盟约官方图标) / 藏品 (= 现有装备, 用装备图标) / 通用决策。
// 选中后发 g.exclusive / g.relic / g.decision; 顶部「藏品库」(RelicBar) 展示全队藏品, 悬停显示效果。

import { html, Modal, MicroLabel, Button, Icon } from './components.js';
import { Img } from './gameComponents.js';
import { itemIconUrl, bondIconUrl } from './assetUrls.js';
import { useState } from '../../vendor/hooks.module.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';
import { ENDLESS } from '../../../shared/constants.js';

const RARITY_TEXT = { white: '普通', blue: '稀有', gold: '传说', color: '炫彩' };
const RARITY_CLS = { white: 'is-white', blue: 'is-blue', gold: 'is-gold', color: 'is-color' };

/**
 * @param {{ offer: Array<any>|null, kind: 'relic'|'decision'|'exclusive', nameOf?: (id:string)=>any,
 *   onPick: (option:any, idx:number)=>void }} props
 */
export function RelicOverlay({ offer, kind, nameOf = () => null, onPick = () => {} }) {
  if (!Array.isArray(offer) || !offer.length) return null;
  const assets = data.get('assets');
  const title = kind === 'exclusive' ? t('选择专属盟约') : kind === 'decision' ? t('选择决策') : t('选择藏品');
  const micro = kind === 'exclusive' ? 'EXCLUSIVE CONTRACT // 专属盟约' : kind === 'decision' ? 'DECISION // 决策' : 'RELIC // 藏品';
  const iconOf = (o) => {
    if (kind === 'relic') return o.icon ? itemIconUrl(assets, { iconId: o.icon }) : itemIconUrl(assets, nameOf(o.id));
    if (kind === 'decision') return itemIconUrl(assets, { iconId: o.icon });
    if (kind === 'exclusive' && o.bond) return bondIconUrl(assets, o.bond);
    return null;
  };
  return html`<${Modal} open=${true} title=${title} onClose=${null} width="min(1360px, 94vw)">
    <${MicroLabel} tone="mint">${micro}</${MicroLabel}>
    <div class="relicov" data-testid=${`relic-ov-${kind}`}>
      ${offer.map((o, i) => {
        const url = iconOf(o);
        const rc = RARITY_CLS[o.rarity] || '';
        const bondName = o.bond ? (data.lookup('bonds', o.bond)?.name || '') : '';
        const bondCls = o.bond ? ` reliccard--bond bd-${o.bond}` : '';
        return html`<button type="button" key=${i} class=${`reliccard ${rc}${bondCls}`}
          title=${o.text} onClick=${() => onPick(o, i)}>
          <span class="reliccard__top">
            <span class="reliccard__art">${url ? html`<${Img} src=${url} alt=${o.name} />` : html`<span class="reliccard__glyph">◆</span>`}</span>
            <span class=${`reliccard__rarity ${rc}`}>${RARITY_TEXT[o.rarity] || ''}</span>
          </span>
          <span class="reliccard__name">${o.name}</span>
          ${bondName ? html`<span class="reliccard__bondtag">${bondName}盟约</span>` : null}
          ${o.combo ? html`<span class=${`reliccard__combo${o.combo.willComplete ? ' is-on' : ''}`} data-testid="card-combo">
            ${t('组合')}·${o.combo.name} <b>${o.combo.have}/${o.combo.need}</b>${o.combo.willComplete ? ` · ${t('凑齐')}` : ''}</span>` : null}
          <span class="reliccard__text">${o.text}</span>
        </button>`;
      })}
    </div>
  </${Modal}>`;
}

/**
 * 经济商店弹窗 (无尽狂潮, author 2026-10-12/13): 每 SHOP_EVERY 回合弹出, 用资金买「转职」/「装备」/「藏品」。
 * 买到的进「下方备战席」(藏品直接入藏品库)。**不限购买件数**; 「刷新」重新抽一批货 (首次 1 币, 每次翻倍)。
 * `offer` = m.private.econOffer { round, entries:[{kind,id,name,bond,bondName,price,sold}], refreshes }。
 */
export function EconShopOverlay({ offer, onBuy = () => {}, onRefresh = () => {}, onClose = () => {} }) {
  if (!offer || !Array.isArray(offer.entries) || !offer.entries.length) return null;
  const assets = data.get('assets');
  const refreshCost = Math.max(1, Math.round(ENDLESS.ECON_REFRESH_BASE * Math.pow(ENDLESS.ECON_REFRESH_MUL, offer.refreshes || 0)));
  return html`<${Modal} open=${true} title=${t('经济商店')} onClose=${null} closeOnBackdrop=${false} width="min(1360px, 94vw)"
    actions=${html`
      <${Button} variant="secondary" icon="refresh" onClick=${onRefresh}>${t('刷新')} · ¤ ${refreshCost}<//>
      <${Button} variant="primary" onClick=${onClose}>${t('退出商店')}<//>`}>
    <${MicroLabel} tone="mint">ECONOMY SHOP // 每 {10} 回合 · 资金购买</${MicroLabel}>
    <p class="econ__hint"><${Icon} name="info" />${t('不限购买件数；刷新可换一批货（首次 1 币，每次翻倍）')}</p>
    <div class="relicov relicov--econ" data-testid="econ-shop">
      ${offer.entries.map((e, i) => {
        const url = e.kind === 'transfer' && e.bond
          ? bondIconUrl(assets, e.bond)
          : e.icon ? itemIconUrl(assets, { iconId: e.icon })
          : itemIconUrl(assets, data.lookup('items', e.id));
        const sold = !!e.sold;
        return html`<button type="button" key=${`${e.kind}:${e.id}:${i}`} class=${`reliccard reliccard--econ${sold ? ' is-sold' : ''}`}
          disabled=${sold} title=${e.text || e.name} onClick=${() => { if (!sold) onBuy(i); }}>
          <span class="reliccard__top">
            <span class="reliccard__art">${url ? html`<${Img} src=${url} alt=${e.name} />` : html`<span class="reliccard__glyph">◆</span>`}</span>
            <span class="reliccard__rarity">${sold ? t('已购买') : `¤ ${e.price}`}</span>
          </span>
          <span class="reliccard__name">${e.name}</span>
          <span class="reliccard__bondtag">${e.kind === 'transfer' ? `${t('转职')} · ${e.bondName || ''} · 6阶` : e.kind === 'relic' ? `${t('藏品')} · ${RARITY_TEXT[e.rarity] || ''}` : `${t('装备')} · ${e.tier || ''}阶`}</span>
          <span class="reliccard__text">${e.text || ''}</span>
        </button>`;
      })}
    </div>
  </${Modal}>`;
}

/** 顶部「藏品库」: the team's relics + the team-wide atk/hp bonus they grant. Hidden when empty. Hover shows the effect.
 *  `combos` (m.private.relicCombos, 反馈④) renders a second row: every 套装/组合 with its 已凑齐进度 (have/need). */
export function RelicBar({ relics, stats = null, combos = null, nameOf = () => null }) {
  // 可收缩 (2026-10-14): 藏品太多时挡界面 —— 点标题旁的箭头折叠, 只留标题 + 数量
  const [open, setOpen] = useState(true);
  if (!Array.isArray(relics) || !relics.length) return null;
  const assets = data.get('assets');
  const pct = (v) => Math.round((Number(v) || 0) * 100);
  const bonus = stats && (stats.atk > 0 || stats.hp > 0)
    ? `全队 攻 +${pct(stats.atk)}% · 血 +${pct(stats.hp)}%` : null;
  return html`<div class=${`relicbar${open ? '' : ' is-collapsed'}`} data-testid="relic-bar">
    <button type="button" class="relicbar__toggle" aria-expanded=${open ? 'true' : 'false'}
      title=${open ? t('收起藏品库') : t('展开藏品库')} onClick=${() => setOpen((v) => !v)}>
      <${Icon} name="chevronDown" />
      <span class="relicbar__title">${t('藏品库')}<b class="relicbar__n num">${relics.length}</b></span>
    </button>
    ${open && bonus ? html`<span class="relicbar__stats" title=${t('藏品给全队的攻击/生命加成（战斗内生效）')}>${bonus}</span>` : null}
    ${open ? html`<div class="relicbar__list">
      ${relics.map((r) => {
        const url = r.icon ? itemIconUrl(assets, { iconId: r.icon })
          : r.bond ? bondIconUrl(assets, r.bond)
          : itemIconUrl(assets, nameOf(r.id));
        return html`<span class="relicbar__item" key=${r.id} title=${`${r.name}${r.count > 1 ? ` ×${r.count}` : ''}\n${r.text}`}>
          ${url ? html`<${Img} class="relicbar__icon" src=${url} alt=${r.name} />` : html`<span class="relicbar__glyph">◆</span>`}
          ${r.count > 1 ? html`<span class="relicbar__count">×${r.count}</span>` : null}
        </span>`;
      })}
    </div>` : null}
    ${open && Array.isArray(combos) && combos.length ? html`<div class="relicbar__combos" data-testid="relic-combos">
      ${combos.map((c) => html`<span class=${`relicbar__combo${c.active ? ' is-on' : ''}`} key=${c.key} title=${`${c.name}：${c.text}`}>
        ${c.name} <b>${c.have}/${c.need}</b>${c.active ? ` ${t('已凑齐')}` : ''}</span>`)}
    </div>` : null}
  </div>`;
}
