// 大厅排行榜 (this build, owner 2026-10-10): a window shown DIRECTLY in the lobby (like the 独立模拟 cards, no top-bar
// button). Every 隐藏首领 gets a card — name + small icon — and under it the FASTEST clearing team at the TOP difficulty
// (ABYSS): the clear time, the room owner and that run's MVP (最高伤害). Clicking the team opens the run's settlement
// rows. The records live on the server (server/leaderboard.js, one JSON file so they survive a restart); the boss list
// itself comes from data/bosses.json (hidden entries), so a boss with no record still shows its card ("暂无通关记录").
//
// `leaderboard.list` is answered by the push `leaderboard.items { items }` (the asker only), like the feedback board —
// the board polls while it is mounted.

import { useState, useEffect } from '../../vendor/hooks.module.js';
import { html, MicroLabel, Modal, Spinner } from './components.js';
import { Img, GIcon, useGameData } from './gameComponents.js';
import { enemyIconUrl, bondIconUrl } from './assetUrls.js';
import { data, useData } from '../data.js';
import { net } from '../net.js';
import { useStore, shallowEqual, serverNow } from '../store.js';
import { t } from '../../../shared/i18n.js';
import { DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { fmtNum } from './gameLogic.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** One player's 盟约 list (id + layers + active) for the detail view; defensive. */
function normBonds(b) {
  return (Array.isArray(b) ? b : [])
    .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id)
    .map((x) => ({ id: String(x.id), layers: Math.max(0, Number(x.layers) || 0), active: !!x.active }));
}

/** How often the board re-asks the server for its records (they change only when a match ends). */
export const LEADERBOARD_REFRESH_MS = 20000;

/** A clear time as `m:ss` (under an hour) or `h:mm:ss`. */
export function formatClearTime(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A record's age, relative (server clock). */
function boardAge(at, now = serverNow()) {
  const secs = Math.max(0, Math.floor((Number(now) - Number(at)) / 1000));
  if (!Number.isFinite(secs)) return '';
  if (secs < 45) return t('刚刚');
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t('{n} 分钟前', { n: Math.max(1, mins) });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('{n} 小时前', { n: hours });
  return new Date(at).toLocaleDateString();
}

/** 总伤害 (the MVP metric) as a short number — 万 / 亿 / 兆 / 京 … (fmtNum; 超过最大单位转科学计数). */
function fmtDamage(v) {
  return fmtNum(Math.max(0, Number(v) || 0));
}

/** The rows as the board shows them (defensive: a broken row is dropped); keyed by bossId for the cards. */
export function normalizeLeaderboard(items) {
  const out = new Map();
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    if (!it || typeof it !== 'object' || typeof it.bossId !== 'string') continue;
    out.set(it.bossId, {
      bossId: it.bossId,
      bossName: String(it.bossName || it.bossId),
      difficulty: typeof it.difficulty === 'string' ? it.difficulty : null,
      durationMs: Math.max(0, Number(it.durationMs) || 0),
      at: Number(it.at) || 0,
      teamSize: Math.max(0, Number(it.teamSize) || 0),
      owner: String(it.owner || ''),
      mvp: it.mvp && typeof it.mvp === 'object' ? { name: String(it.mvp.name || ''), dmgDealt: Math.max(0, Number(it.mvp.dmgDealt) || 0) } : null,
    });
  }
  return out;
}

/** The settlement rows of one record (the detail view). */
export function normalizeBoardEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.bossId !== 'string') return null;
  const players = Array.isArray(entry.players) ? entry.players : [];
  return {
    bossId: entry.bossId,
    bossName: String(entry.bossName || entry.bossId),
    difficulty: typeof entry.difficulty === 'string' ? entry.difficulty : null,
    durationMs: Math.max(0, Number(entry.durationMs) || 0),
    at: Number(entry.at) || 0,
    teamSize: Math.max(0, Number(entry.teamSize) || players.length),
    owner: String(entry.owner || ''),
    players: players.filter((p) => p && typeof p === 'object').map((p) => ({
      name: String(p.name || ''), isBot: !!p.isBot, left: !!p.left, alive: !!p.alive, mvp: !!p.mvp,
      title: typeof p.title === 'string' ? p.title : null,
      bonds: normBonds(p.bonds),
      stats: p.stats && typeof p.stats === 'object' ? p.stats : {},
    })),
  };
}

/** One 无尽模式 board row, defensive (a broken row is dropped). */
export function normalizeEndlessBoard(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      teamKey: String(e.teamKey || ''),
      at: Number(e.at) || 0,
      owner: String(e.owner || ''),
      rounds: Math.max(0, Number(e.rounds) || 0),
      dmg: Math.max(0, Number(e.dmg) || 0),
      teamSize: Math.max(0, Number(e.teamSize) || 0),
      names: (Array.isArray(e.players) ? e.players : []).map((p) => String((p && p.name) || '')).filter(Boolean),
      // the settlement rows (the detail view): name + stats (leaderboard.js records them per run)
      players: (Array.isArray(e.players) ? e.players : []).filter((p) => p && typeof p === 'object').map((p) => ({
        name: String(p.name || ''), isBot: !!p.isBot, left: !!p.left, alive: !!p.alive,
        bandIds: Array.isArray(p.bandIds) ? p.bandIds.filter((x) => typeof x === 'string') : [],
        exclusiveBond: typeof p.exclusiveBond === 'string' ? p.exclusiveBond : null, // 核心(专属)盟约
        title: p.title && typeof p.title === 'object' ? (p.title.name || null) : (typeof p.title === 'string' ? p.title : null),
        bonds: normBonds(p.bonds),
        stats: p.stats && typeof p.stats === 'object' ? p.stats : {},
      })),
    }));
}

/** One 无尽 board table. Each row opens that run's settlement detail (like the boss board). */
function EndlessBoard({ rows, metric, onOpen }) {
  return html`<table class="lb-table lb-table--endless">
    <thead><tr>
      <th class="num">#</th><th>${t('队伍')}</th>
      <th class="num">${t('通过回合')}</th><th class="num">${t('打桩伤害')}</th><th>${t('时间')}</th>
    </tr></thead>
    <tbody>
      ${rows.length ? rows.map((e, i) => html`<tr key=${e.teamKey + i} class=${cx('lb-row', i === 0 && 'lb-row--top1', i === 1 && 'lb-row--top2', i === 2 && 'lb-row--top3')}
          role="button" tabindex="0" title=${t('查看该局结算')} onClick=${() => onOpen && onOpen(e)}>
        <td class="num">${i + 1}</td>
        <td>
          <span class="lb-endless__owner"><${GIcon} name="crown" />${e.owner || t('未知')}</span>
          <span class="t-dim"> · ${e.teamSize} ${t('人')}</span>
          <div class="lb-endless__team t-dim">${e.names.join('、')}</div>
        </td>
        <td class="num">${e.rounds}</td>
        <td class="num">${fmtDamage(e.dmg)}</td>
        <td class="t-dim">${e.at ? boardAge(e.at) : ''}</td>
      </tr>`) : html`<tr><td colSpan="5" class="t-dim">${t('暂无记录')}</td></tr>`}
    </tbody>
  </table>`;
}

/** The detail of one 无尽 run: its settlement rows (点击榜单那行打开). */
function EndlessDetail({ entry, onBack }) {
  const cols = [
    ['打桩伤害', 'bossDamage'], ['总伤害', 'dmgDealt'], ['击杀', 'kills'], ['漏怪', 'leaks'],
    ['经济', 'gold'], ['合成', 'merges'], ['装备', 'itemsEquipped'],
  ];
  const assets = data.get('assets');
  // 核心(专属)盟约: 每个队员的核心盟约图标 + 名称 (leaderboard.js 记录 exclusiveBond)
  const coreOf = (p) => {
    if (!p.exclusiveBond) return null;
    const name = data.lookup('bonds', p.exclusiveBond)?.name || p.exclusiveBond;
    const url = bondIconUrl(assets, p.exclusiveBond);
    return html`<span class="lb-core" title=${`${t('核心盟约')}：${name}`}>
      ${url ? html`<${Img} class="lb-core__ico" src=${url} alt=${name} />` : null}${name}</span>`;
  };
  return html`<div class="lb-detail">
    <button type="button" class="lb-back" onClick=${onBack}><${GIcon} name="chevronLeft" />${t('返回排行榜')}</button>
    <div class="lb-detail__head">
      <b>${t('无尽狂潮')}</b>
      <span class="lb-detail__time num">${t('通过回合')} ${entry.rounds}</span>
      <span class="num">${t('打桩伤害')} ${fmtDamage(entry.dmg)}</span>
      <span class="t-dim">${t('房主')} ${entry.owner || t('未知')} · ${entry.teamSize} ${t('人')}</span>
    </div>
    <${RunPlayers} players=${entry.players} cols=${cols} coreOf=${coreOf} />
  </div>`;
}

/** The hidden bosses (data/bosses.json `hidden`), original three first then the project's three (by sortId, then id). */
export function hiddenBossList(lookups) {
  const bosses = data.get('bosses') || {};
  return Object.entries(bosses)
    .filter(([, b]) => b && b.hidden)
    .map(([id, b]) => ({ id, name: String(b.name || id), enemyKey: b.enemyKey || null, sortId: Number(b.sortId) || 0 }))
    .sort((a, b) => (a.sortId - b.sortId) || a.id.localeCompare(b.id));
}

/** One boss card: its icon + name, and beneath it the fastest team (or "暂无记录"). */
function BossCard({ boss, rec, lookups, onOpen }) {
  const icon = boss.enemyKey ? enemyIconUrl(lookups.m, boss.enemyKey) : null;
  return html`<div class="lb-card">
    <div class="lb-card__head">
      <span class="lb-card__icon">${icon ? html`<${Img} src=${icon} alt="" fallback=${html`<${GIcon} name="sword" />`} />` : html`<${GIcon} name="sword" />`}</span>
      <span class="lb-card__name">${boss.name}</span>
      ${rec && rec.difficulty ? html`<span class="lb-chip">${DIFFICULTY_NAMES[rec.difficulty] || rec.difficulty}</span>` : null}
    </div>
    ${rec
      ? html`<button type="button" class="lb-card__team" onClick=${() => onOpen(boss.id)}>
          <span class="lb-card__time num">${formatClearTime(rec.durationMs)}</span>
          <span class="lb-card__who">
            <span class="lb-card__owner"><${GIcon} name="crown" />${rec.owner || t('未知')}</span>
            <span class="lb-card__mvp">${t('MVP')} ${rec.mvp ? rec.mvp.name : '—'}${rec.mvp ? html`<i class="num">${fmtDamage(rec.mvp.dmgDealt)}</i>` : null}</span>
          </span>
          <span class="lb-card__age">${rec.at ? boardAge(rec.at) : ''}</span>
          <${GIcon} name="chevronRight" class="lb-card__go" />
        </button>`
      : html`<div class="lb-card__none">${t('暂无通关记录')}</div>`}
  </div>`;
}

/** One player's 盟约 as chips (icon + name + 层数). The settlement records id + layers per bond. */
function BondChips({ bonds }) {
  if (!Array.isArray(bonds) || !bonds.length) return null;
  const assets = data.get('assets');
  return html`<div class="lb-bonds">
    ${bonds.map((b) => {
      const name = data.lookup('bonds', b.id)?.name || b.id;
      const url = bondIconUrl(assets, b.id);
      return html`<span key=${b.id} class=${cx('lb-bond', b.active && 'is-active')} title=${`${name}${b.layers ? ` · ${b.layers} ${t('层')}` : ''}`}>
        ${url ? html`<${Img} class="lb-bond__ico" src=${url} alt=${name} />` : null}
        <span class="lb-bond__name">${name}</span>
        ${b.layers ? html`<b class="lb-bond__n num">${b.layers}</b>` : null}
      </span>`;
    })}
  </div>`;
}

/** The player cards of one run's detail: name / MVP / title / 核心盟约, then 盟约层数 chips, then a stat grid. */
function RunPlayers({ players, cols, coreOf = null }) {
  return html`<div class="lb-runs">
    ${players.map((p, i) => html`<article key=${i} class=${cx('lb-run', p.mvp && 'is-mvp')}>
      <header class="lb-run__head">
        <b class="lb-run__name">${p.name}</b>
        ${p.mvp ? html`<span class="lb-mvp-tag">${t('MVP')}</span>` : null}
        ${p.title ? html`<span class="lb-title lb-title--inline">${p.title}</span>` : null}
        ${coreOf ? coreOf(p) : null}
      </header>
      <${BondChips} bonds=${p.bonds} />
      <div class="lb-run__stats">
        ${cols.map(([label, key]) => html`<span class="lb-stat"><i class="lb-stat__k">${label}</i><b class="lb-stat__v num">${fmtDamage(p.stats[key])}</b></span>`)}
      </div>
    </article>`)}
  </div>`;
}

/** The detail of one run: its settlement rows (结果页同款数字). */
function BoardDetail({ entry, onBack }) {
  const e = entry;
  const diff = e.difficulty ? (DIFFICULTY_NAMES[e.difficulty] || e.difficulty) : '';
  const cols = [
    ['总伤害', 'dmgDealt'], ['领袖伤害', 'bossDamage'], ['击杀', 'kills'], ['漏怪', 'leaks'],
    ['经济', 'gold'], ['合成', 'merges'], ['装备', 'itemsEquipped'], ['掉血', 'lpLost'],
  ];
  return html`<div class="lb-detail">
    <button type="button" class="lb-back" onClick=${onBack}><${GIcon} name="chevronLeft" />${t('返回排行榜')}</button>
    <div class="lb-detail__head">
      <b>${e.bossName}</b>
      ${diff ? html`<span class="lb-diff">${diff}</span>` : null}
      <span class="lb-detail__time num">${formatClearTime(e.durationMs)}</span>
      <span class="t-dim">${t('房主')} ${e.owner || t('未知')} · ${e.teamSize} ${t('人')}</span>
    </div>
    <${RunPlayers} players=${e.players} cols=${cols} />
  </div>`;
}

/**
 * The lobby's 排行榜 window: the boss cards (name + icon, each with its fastest team) and the detail modal. Mount it
 * directly in the lobby — no button.
 */
export function LobbyLeaderboard() {
  const gd = useGameData();
  useData('bosses', 'assets');
  const conn = useStore((s) => s.connection, shallowEqual);
  const online = conn.status === 'online';
  const [records, setRecords] = useState(() => new Map());
  const [endless, setEndless] = useState(() => ({ rounds: [], damage: [] }));
  const [openBoss, setOpenBoss] = useState(null);
  const [openEndless, setOpenEndless] = useState(null);
  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const offItems = net.on('leaderboard.items', (msg) => setRecords(normalizeLeaderboard(msg.items)));
    const offEntry = net.on('leaderboard.entry', (msg) => { setEntry(normalizeBoardEntry(msg.entry)); setLoading(false); });
    const offEndless = net.on('endlessLeaderboard.items', (msg) => setEndless({ rounds: normalizeEndlessBoard(msg.rounds), damage: normalizeEndlessBoard(msg.damage) }));
    return () => {
      if (typeof offItems === 'function') offItems();
      if (typeof offEntry === 'function') offEntry();
      if (typeof offEndless === 'function') offEndless();
    };
  }, []);

  useEffect(() => {
    if (!online) return undefined;
    const ask = () => { net.send('leaderboard.list'); net.send('endlessLeaderboard.list'); };
    ask();
    const id = setInterval(ask, LEADERBOARD_REFRESH_MS);
    return () => clearInterval(id);
  }, [online]);

  const ask = (bossId) => { setOpenBoss(bossId); setEntry(null); setLoading(true); net.send('leaderboard.get', { bossId }); };
  const close = () => { setOpenBoss(null); setEntry(null); setLoading(false); };
  const bosses = hiddenBossList(gd);
  return html`<div class="lb-board">
    <div class="lb-main">
      <div class="lb-col lb-col--boss">
        <h4 class="lb-col__h"><${MicroLabel}>BOSS<//><span>${t('首领最快通关')}</span></h4>
        <div class="lb-cards">
          ${bosses.map((boss) => html`<${BossCard} key=${boss.id} boss=${boss} rec=${records.get(boss.id)} lookups=${gd} onOpen=${ask} />`)}
        </div>
      </div>
      <div class="lb-col lb-col--endless">
        <h4 class="lb-col__h"><${MicroLabel}>ENDLESS TIDE<//><span>${t('无尽狂潮')}</span></h4>
        <div class="lb-eboard">
          <div class="lb-eboard__h">${t('通过回合数')}</div>
          <${EndlessBoard} rows=${endless.rounds} metric="rounds" onOpen=${setOpenEndless} />
        </div>
        <div class="lb-eboard">
          <div class="lb-eboard__h">${t('打桩累计伤害')}</div>
          <${EndlessBoard} rows=${endless.damage} metric="damage" onOpen=${setOpenEndless} />
        </div>
      </div>
    </div>
    <p class="lb-note"><${MicroLabel}>LEADERBOARDS<//>
      <span class="t-dim">${t('首领榜：每个隐藏首领只收录最高难度下通关最快的一队，用时 = 隐秘核心那一场（R15）的耗时，含前面的准备与等待；点那条队伍查看该局结算。无尽榜各取前 5 支队伍，同队保留最好。')}</span></p>
    <${Modal} open=${openBoss != null} title=${t('通关记录')} micro="CLEAR RUN" tone="mint" onClose=${close} width="min(720px, 96vw)">
      ${entry ? html`<${BoardDetail} entry=${entry} onBack=${close} />`
        : html`<div class="lb-empty"><${Spinner} size="sm" label="LOADING" /></div>`}
    <//>
    <${Modal} open=${openEndless != null} title=${t('无尽局记录')} micro="ENDLESS TIDE" tone="mint"
      onClose=${() => setOpenEndless(null)} width="min(720px, 96vw)">
      ${openEndless ? html`<${EndlessDetail} entry=${openEndless} onBack=${() => setOpenEndless(null)} />` : null}
    <//>
  </div>`;
}
