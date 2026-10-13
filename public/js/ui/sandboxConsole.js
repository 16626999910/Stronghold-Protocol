// 沙盒「控制台」(this build, author 2026-10-11) — replaces the shop bar in a sandbox match: buy ANY operator /
// equipment, pick the map, build a custom wave OR pick a boss, set the enemy-HP multiplier and each 羁绊's layer count,
// and 开战. The config lives on the match (m.public.sandbox); this panel mirrors it and sends g.sandboxSet / g.sandboxGive
// / g.sandboxStart. data/*.json is the client's only source (the server validates every id).
import { useEffect, useMemo, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon } from './components.js';
import { UnitThumb, BondGlyph } from './gameComponents.js';
import { ownDiyRecord } from './gameLogic/diy.js';
import { data, useData } from '../data.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
// shop-eligible equipment (mirrors server/sim/simdata.js isShopItem — server code can't be imported into the browser)
const isShopItem = (it) => !!it && !it.isGolden && !it.hideInShop && !it.shopExcluded && it.itemType === 'EQUIP' && Number.isInteger(it.tier);
const HP_MUL_MAX = 100;
const LIST_CAP = 240;
export const SANDBOX_CSS_HREF = '/css/sandbox.css';

/** Inject the console's stylesheet once when the host page does not (index.html links it in production). */
export function ensureSandboxCss(doc = globalThis.document) {
  if (!doc?.head || typeof doc.querySelector !== 'function') return false;
  if (doc.querySelector(`link[rel="stylesheet"][href$="${SANDBOX_CSS_HREF}"]`)) return false;
  const link = doc.createElement('link');
  link.rel = 'stylesheet'; link.href = SANDBOX_CSS_HREF;
  doc.head.appendChild(link);
  return true;
}

const listOf = (name) => { const v = data.list(name); return Array.isArray(v) ? v : Object.values(v || {}); };
const nameOf = (rec) => (rec && (rec.name || rec.id || rec.chessId)) || '?';
const idOf = (rec) => rec && (rec.id || rec.chessId || rec.key || rec.bossId || rec.bondId);
const byId = (a, b) => (a.bondOrder ?? 999) - (b.bondOrder ?? 999) || (idOf(a) < idOf(b) ? -1 : 1);

// stage grid glyph → colour (mirrors render/style.js GLYPH's materials, keyed by the row characters of data/stages.json)
const TILE_COLOR = {
  '#': '#0a0d0c', X: '#070908', r: '#3b4a44', R: '#3b4a44', f: '#2c3a37', b: '#5a6b62',
  a: '#4a5a52', A: '#4a5a52', S: '#c8402f', E: '#2f7fd0', I: '#7a5ad0', O: '#7a5ad0',
  m: '#4a3b2a', g: '#556066', d: '#1f3a4a', i: '#5a2a2a', h: '#8a938c', p: '#2c3a37',
};

/** A tiny stage preview: the stage's `rows` drawn as a grid of coloured cells (lets the player SEE the map when picking). */
function StageThumb({ stage, class: cls }) {
  const rows = Array.isArray(stage?.rows) ? stage.rows : null;
  if (!rows || !rows.length) return html`<span class=${cx('sbx-map sbx-map--empty', cls)} />`;
  const cols = Math.max(...rows.map((r) => r.length));
  return html`<span class=${cx('sbx-map', cls)} style=${`--cols:${cols}`} aria-hidden="true">
    ${rows.map((row, y) => Array.from({ length: cols }, (_, x) => {
      const ch = row[x] || ' ';
      return html`<i key=${`${x},${y}`} style=${`background:${TILE_COLOR[ch] || 'transparent'}`} />`;
    }))}
  </span>`;
}

// the cells call this (set by the console render): keeps the grids cheap
const giveRef = { current: () => {} };

/** A buy-cell: `{ id, rec }` (rec draws the art / name; id is what g.sandboxGive receives — for a DIY slot, the slot). */
const cell = (rec, id) => ({ id: id ?? idOf(rec), rec });

/** A grid of buy-cells (干员 / 装备) — clicking one grants it (g.sandboxGive). */
function GiveGrid({ cells, kind }) {
  if (!cells.length) return html`<p class="sbx__empty">${t('没有匹配的条目')}</p>`;
  return html`<div class="sbx__grid">
    ${cells.map((c) => html`<button key=${c.id} type="button" class="sbx__cell" title=${nameOf(c.rec)}
      onClick=${(e) => { e.currentTarget.blur(); giveRef.current(kind, c.id); }}>
      <${UnitThumb} kind=${kind} id=${c.id} rec=${c.rec} size="sm" showTier=${kind === 'chess'} />
      <span class="sbx__cell-name">${nameOf(c.rec)}</span>
    </button>`)}
  </div>`;
}

/** The 自选干员 cells: each DIY slot filled with the operator the player chose in 自选编队 (m.private.diy). */
function diyCells(priv) {
  const dat = { chess: data.get('chess'), backups: data.get('backups') };
  const out = [];
  for (const slot of listOf('chess')) {
    if (!slot.isDiy) continue;
    const rec = ownDiyRecord(slot, priv, dat);
    if (rec) out.push({ id: idOf(slot), rec }); // buy the slot; draw the picked operator
  }
  return out;
}

/** 干员 tab: every operator grouped by 羁绊 (collapsible) + a 自选干员 group (the player's 自选编队 picks). */
function buildOpGroups(priv) {
  const chess = listOf('chess').filter((c) => c.visible && !c.isGolden && !c.isHidden && !c.isDiy);
  const bonds = listOf('bonds').slice().sort(byId);
  const groups = [];
  const covered = new Set();
  for (const b of bonds) {
    const id = idOf(b);
    const members = chess.filter((c) => Array.isArray(c.bonds) && c.bonds.includes(id)).map((c) => cell(c));
    if (!members.length) continue;
    for (const m of members) covered.add(m.id);
    groups.push({ id, name: nameOf(b), icon: true, members });
  }
  const diy = diyCells(priv);
  if (diy.length) groups.push({ id: '__diy', name: t('自选干员'), members: diy });
  const rest = chess.filter((c) => !covered.has(idOf(c))).map((c) => cell(c));
  if (rest.length) groups.push({ id: '__other', name: t('其他'), members: rest });
  return groups;
}

function OpsTab({ priv, q }) {
  const groups = useMemo(() => buildOpGroups(priv), [priv]);
  const [open, setOpen] = useState(() => new Set());
  const needle = q.trim().toLowerCase();
  if (needle) {
    const seen = new Set();
    const hit = [];
    for (const g of groups) for (const m of g.members) if (nameOf(m.rec).toLowerCase().includes(needle) && !seen.has(m.id)) { seen.add(m.id); hit.push(m); }
    return html`<${GiveGrid} cells=${hit.slice(0, LIST_CAP)} kind="chess" />`;
  }
  return html`<div class="sbx__groups">
    ${groups.map((g) => html`<div key=${g.id} class="sbx__group">
      <button type="button" class=${cx('sbx__group-head', open.has(g.id) && 'is-open')}
        onClick=${() => setOpen((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })}>
        ${g.icon ? html`<${BondGlyph} bondId=${g.id} />` : html`<${Icon} name="rook" />`}
        <span class="sbx__group-name">${g.name}</span>
        <span class="sbx__group-count num">${g.members.length}</span>
        <${Icon} name="chevronDown" class="sbx__group-caret" />
      </button>
      ${open.has(g.id) ? html`<${GiveGrid} cells=${g.members} kind="chess" />` : null}
    </div>`)}
  </div>`;
}

/** 装备 tab: the shop-eligible equipment, a flat searchable grid. */
function GearTab({ q }) {
  const pool = useMemo(() => {
    const all = listOf('items').filter(isShopItem);
    const needle = q.trim().toLowerCase();
    return (needle ? all.filter((c) => nameOf(c).toLowerCase().includes(needle)) : all).slice(0, LIST_CAP).map((c) => cell(c));
  }, [q]);
  return html`<${GiveGrid} cells=${pool} kind="item" />`;
}

/** 地图 tab: the active stages (with a preview); clicking one picks it. */
function MapTab({ stageId, onSet }) {
  const stages = listOf('stages').filter((s) => s.active !== false);
  return html`<div class="sbx__rows">
    ${stages.map((s) => html`<button key=${s.id} type="button" class=${cx('sbx__row sbx__row--map', s.id === stageId && 'is-on')} onClick=${() => onSet({ stageId: s.id })}>
      <${StageThumb} stage=${s} />
      <span class="sbx__row-main">${nameOf(s)}</span><span class="sbx__row-sub num">${s.id}</span>
    </button>`)}
  </div>`;
}

/** 波次 tab: search enemies (with icons), add key+count to the wave list. */
function WaveTab({ enemies, onSet, q }) {
  const [picked, setPicked] = useState(null);
  const [count, setCount] = useState(10);
  const pool = useMemo(() => {
    const all = listOf('enemies');
    const needle = q.trim().toLowerCase();
    return (needle ? all.filter((e) => nameOf(e).toLowerCase().includes(needle) || (e.key || e.id || '').toLowerCase().includes(needle)) : all).slice(0, 60);
  }, [q]);
  const recOf = (key) => listOf('enemies').find((x) => (x.key || x.id) === key);
  const add = (key) => onSet({ enemies: [...enemies, { key, count }] });
  const remove = (i) => onSet({ enemies: enemies.filter((_, j) => j !== i) });
  const bump = (i, d) => onSet({ enemies: enemies.map((e, j) => (j === i ? { ...e, count: Math.max(0, Math.min(999, e.count + d)) } : e)) });
  return html`<div class="sbx__wave">
    <div class="sbx__wave-list">
      <div class="sbx__mlabel">${t('本场出怪')}</div>
      ${enemies.length ? enemies.map((e, i) => html`<div key=${`${e.key}#${i}`} class="sbx__enemy">
        <${UnitThumb} kind="enemy" id=${e.key} size="xs" />
        <span class="sbx__enemy-name">${nameOf(recOf(e.key) || { id: e.key })}</span>
        <span class="sbx__stepper"><button type="button" onClick=${() => bump(i, -10)}>−10</button><b class="num">${e.count}</b><button type="button" onClick=${() => bump(i, 10)}>+10</button></span>
        <button type="button" class="sbx__x" aria-label=${t('移除')} onClick=${() => remove(i)}><${Icon} name="close" /></button>
      </div>`) : html`<p class="sbx__empty">${t('还没有出怪，去下面挑敌人')}</p>`}
      ${enemies.length ? html`<button type="button" class="sbx__ghost" onClick=${() => onSet({ enemies: [] })}>${t('清空')}</button>` : null}
    </div>
    <div class="sbx__wave-pick">
      <div class="sbx__mlabel">${t('挑选敌人')} · <input class="sbx__count num" type="number" min="1" max="999" value=${count} onInput=${(e) => setCount(Math.max(1, Math.min(999, e.target.value | 0 || 1)))} /> ×</div>
      ${pool.map((e) => html`<button key=${e.id || e.key} type="button" class=${cx('sbx__row', picked === (e.id || e.key) && 'is-on')}
        onClick=${() => { setPicked(e.id || e.key); add(e.id || e.key); }}>
        <${UnitThumb} kind="enemy" id=${e.key || e.id} size="xs" />
        <span class="sbx__row-main">${nameOf(e)}</span><span class="sbx__row-sub num">${e.id || e.key}</span>
      </button>`)}
    </div>
  </div>`;
}

/** 首领 tab: pick a boss (final-assault leader or a hidden core) and run it. */
function BossTab({ bossId, onSet }) {
  const bosses = listOf('bosses');
  return html`<div class="sbx__rows">
    ${bosses.map((b) => html`<button key=${b.bossId} type="button" class=${cx('sbx__row', b.bossId === bossId && 'is-on')}
      onClick=${() => onSet({ mode: 'boss', bossId: b.bossId })}>
      <${UnitThumb} kind="enemy" id=${b.enemyKey} size="sm" />
      <span class="sbx__row-main">${nameOf(b)}${b.hidden ? html`<i class="sbx__tag">${t('隐秘核心')}</i>` : null}</span>
      <span class="sbx__row-sub num">${b.bossId}</span>
    </button>`)}
  </div>`;
}

/** 数值 tab: enemy-HP multiplier (1..100) and each 羁绊's layer count (set directly). */
function NumTab({ hpMul, priv, onSet }) {
  const bonds = useMemo(() => listOf('bonds').slice().sort(byId), []);
  const layersOf = (id) => { const e = (priv?.bonds || []).find((b) => b.bondId === id); return e ? (e.layers | 0) : 0; };
  return html`<div class="sbx__nums">
    <label class="sbx__num-row">
      <span>${t('怪物血量倍率')}</span>
      <input type="range" min="1" max=${HP_MUL_MAX} step="1" value=${hpMul} onInput=${(e) => onSet({ hpMul: e.target.value | 0 || 1 })} />
      <b class="num">×${hpMul}</b>
    </label>
    <div class="sbx__mlabel">${t('羁绊层数')} <span class="t-dim">${t('直接设置每个羁绊的层数')}</span></div>
    <div class="sbx__bonds">
      ${bonds.map((b) => html`<label key=${b.bondId} class="sbx__bond">
        <${BondGlyph} bondId=${b.bondId} />
        <span class="sbx__bond-name">${nameOf(b)}</span>
        <input type="number" min="0" max="999" value=${layersOf(b.bondId)}
          onInput=${(e) => onSet({ bonds: { [b.bondId]: Math.max(0, Math.min(999, e.target.value | 0)) } })} />
      </label>`)}
    </div>
  </div>`;
}

/**
 * The sandbox entry: on entering the sandbox the 开局 (地图 / 策略 / 回合数) is skipped, so this full-screen picker asks
 * only two things — WHICH map and WHICH battlefield (普通战场 / 首领战场) — then 「进入」 goes straight into the game
 * (where the 控制台 customises the content). Sends one g.sandboxSet { stageId, mode, bossId? } (a stageId flips the
 * match's sandbox `entered`), after which the console takes over.
 * @param {{ pub: object, onEnter: (cfg: object) => void }} props
 */
export function SandboxSetup({ pub, onEnter }) {
  useData('stages', 'bosses');
  useEffect(() => { ensureSandboxCss(); }, []);
  const sb = pub?.sandbox || {};
  const [mode, setMode] = useState(sb.mode === 'boss' ? 'boss' : 'wave');
  const [stageId, setStageId] = useState(sb.stageId || null);
  const [bossId, setBossId] = useState(sb.bossId || null);
  const stages = listOf('stages').filter((s) => s.active !== false);
  const bosses = listOf('bosses');
  const ready = !!stageId && (mode !== 'boss' || !!bossId);
  const enter = () => { if (ready) onEnter({ stageId, mode, bossId: mode === 'boss' ? bossId : null }); };
  return html`<div class="sbx-setup" role="dialog" aria-modal="true">
    <div class="sbx-setup__panel">
      <div class="sbx-setup__head"><${Icon} name="rook" /><span class="sbx-setup__title">${t('选择战场')}</span></div>
      <div class="sbx-setup__body">
        <div class="sbx-setup__col">
          <div class="sbx__mlabel">${t('地图')}</div>
          <div class="sbx__rows sbx-setup__scroll">
            ${stages.map((s) => html`<button key=${s.id} type="button" class=${cx('sbx__row sbx__row--map', s.id === stageId && 'is-on')} onClick=${() => setStageId(s.id)}>
              <${StageThumb} stage=${s} />
              <span class="sbx__row-main">${nameOf(s)}</span><span class="sbx__row-sub num">${s.id}</span>
            </button>`)}
          </div>
        </div>
        <div class="sbx-setup__col">
          <div class="sbx__mlabel">${t('战场类型')}</div>
          <div class="sbx__modes">
            <button type="button" class=${cx('sbx__mode', mode === 'wave' && 'is-on')} onClick=${() => setMode('wave')}>${t('普通战场')}</button>
            <button type="button" class=${cx('sbx__mode', mode === 'boss' && 'is-on')} onClick=${() => setMode('boss')}>${t('首领战场')}</button>
          </div>
          ${mode === 'boss' ? html`<div class="sbx__rows sbx-setup__scroll sbx-setup__bosses">
            ${bosses.map((b) => html`<button key=${b.bossId} type="button" class=${cx('sbx__row', b.bossId === bossId && 'is-on')} onClick=${() => setBossId(b.bossId)}>
              <${UnitThumb} kind="enemy" id=${b.enemyKey} size="sm" />
              <span class="sbx__row-main">${nameOf(b)}${b.hidden ? html`<i class="sbx__tag">${t('隐秘核心')}</i>` : null}</span>
              <span class="sbx__row-sub num">${b.bossId}</span>
            </button>`)}
          </div>` : html`<p class="sbx__empty">${t('进入后可自定义出怪与数值')}</p>`}
        </div>
      </div>
      <div class="sbx-setup__foot">
        <span class="t-dim">${t('进入沙盒后仍可在控制台更改内容')}</span>
        <${Button} variant="amber" size="lg" icon="chevrons" disabled=${!ready} onClick=${enter}>${t('进入')}<//>
      </div>
    </div>
  </div>`;
}

/**
 * The sandbox 控制台. `pub.sandbox` is the live config; `onSet/onGive/onStart` are the `g.sandbox*` actions.
 * @param {{ pub: object, priv?: object, onSet: Function, onGive: Function, onStart: Function, collapsed?: boolean,
 *   onCollapse?: Function, editable?: boolean }} props
 */
export function SandboxConsole({ pub, priv, onSet, onGive, onStart, onClear, collapsed = false, onCollapse, editable = true }) {
  useData('chess', 'items', 'stages', 'enemies', 'bosses', 'bonds', 'backups');
  useEffect(() => { ensureSandboxCss(); }, []);
  const sb = pub?.sandbox || {};
  const [tab, setTab] = useState('ops');
  const [q, setQ] = useState('');
  giveRef.current = onGive;
  const TABS = [
    ['ops', t('干员')], ['gear', t('装备')], ['map', t('地图')],
    ['wave', t('波次')], ['boss', t('首领')], ['num', t('数值')],
  ];
  if (collapsed) {
    return html`<div class="sbx is-min"><button type="button" class="sbx__head" onClick=${() => onCollapse?.(false)}>
      <${Icon} name="rook" /><span>${t('控制台')}</span><span class="t-dim">${t('展开')}</span></button></div>`;
  }
  const searchable = tab === 'ops' || tab === 'gear' || tab === 'wave';
  return html`<div class="sbx">
    <div class="sbx__head">
      <${Icon} name="rook" /><span class="sbx__title">${t('控制台')}</span>
      <div class="sbx__tabs">
        ${TABS.map(([id, label]) => html`<button key=${id} type="button" class=${cx('sbx__tab', tab === id && 'is-on')} onClick=${() => { setTab(id); setQ(''); }}>${label}</button>`)}
      </div>
      ${searchable ? html`<input class="sbx__search" type="search" value=${q} placeholder=${t('搜索…')} onInput=${(e) => setQ(e.target.value)} />` : html`<span class="sbx__hint">${
        sb.mode === 'boss' ? t('当前：首领战场') : t('当前：自定义波次')
      }</span>`}
      ${onClear ? html`<${Button} variant="secondary" size="sm" disabled=${!editable} title=${t('清空备战席')} onClick=${() => onClear('bench')}>${t('清空备战席')}<//>
        <${Button} variant="secondary" size="sm" disabled=${!editable} title=${t('清空场上')} onClick=${() => onClear('board')}>${t('清空场上')}<//>` : null}
      <${Button} variant="amber" size="sm" icon="chevrons" disabled=${!editable} onClick=${() => onStart?.()}>${t('开战')}<//>
      <button type="button" class="sbx__collapse" aria-label=${t('收起')} onClick=${() => onCollapse?.(true)}><${Icon} name="chevronDown" /></button>
    </div>
    <div class="sbx__body">
      ${tab === 'ops' ? html`<${OpsTab} priv=${priv} q=${q} />` : null}
      ${tab === 'gear' ? html`<${GearTab} q=${q} />` : null}
      ${tab === 'map' ? html`<${MapTab} stageId=${sb.stageId} onSet=${onSet} />` : null}
      ${tab === 'wave' ? html`<${WaveTab} enemies=${Array.isArray(sb.enemies) ? sb.enemies : []} onSet=${onSet} q=${q} />` : null}
      ${tab === 'boss' ? html`<${BossTab} bossId=${sb.bossId} onSet=${onSet} />` : null}
      ${tab === 'num' ? html`<${NumTab} hpMul=${sb.hpMul || 1} priv=${priv} onSet=${onSet} />` : null}
    </div>
  </div>`;
}
