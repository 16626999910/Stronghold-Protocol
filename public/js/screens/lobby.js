// Lobby screen: pick 独立模拟 / 同盟模拟 and a difficulty (标准/险境/绝境/终极), create a room,
// or join one with a 同盟密钥 (recent codes remembered) — as a player (加入同盟) or in one of its MAX_SPECTATORS
// spectator seats (观战: room.spectate, also while its match runs; community report #26, a remake feature — the
// official room has none). Shows connection status + ping.
//
// Difficulty descriptions come from data/config.json `modes[modeId]` when present, else from the
// official act2autochess `modeDataDict` texts embedded below (desc + effectDescList), so the
// screen is complete before data is generated. Rounds: solo 标准 = 9, everything else 14 (+R15
// hidden core on 险境+), per research 00-INDEX §2. Battlefield pool (`modes[].stages`): 标准 always
// plays 战场#01, 险境 draws one of 8, 绝境 / 终极 one of 7 (m01 excluded).
// Texts go through t() (docs/I18N.md); the module-level tables hold msgids (N_) translated where they are shown, the
// config.json mode texts come localized from data.js.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, ROOM_CODE_LEN, MAX_SEATS, MAX_SPECTATORS, ROOM_PLAYER_OPTIONS, DEFAULT_ROOM_PLAYERS, modeIdFor, ERR, APP_VERSION } from '../../../shared/constants.js';
import { html, Button, Icon, MicroLabel, Modal, Panel, TextField, PingPill, AvatarFrame, Tooltip, Spinner, DifficultyIcon, doctorNo } from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { GuideButton } from '../ui/guide.js';
import { AnnounceButton, announceAutoOpen } from '../ui/announcements.js';
import { OnlinePill } from '../ui/online.js';
import { MatchmakingButton } from '../ui/matchmaking.js';
import { FeedbackButton } from '../ui/feedback.js';
import { LobbyLeaderboard } from '../ui/leaderboard.js';
import { LoadoutButton } from './loadout.js';
import { net, identity } from '../net.js';
import { store, useStore, shallowEqual, loadPref, savePref, serverNow } from '../store.js';
import { getMode, getStage, useData } from '../data.js';
import { t, tc, N_ } from '../../../shared/i18n.js';
import { PreloadWidget } from '../ui/preload.js';

/** Official mode texts (activity_table act2autochess.modeDataDict), fallback when config.json is absent. */
export const MODE_TEXT = {
  single: {
    FUNNY: { code: 'AC-1', desc: N_('时长较短的模拟训练'), effects: [N_('可以快速完成作战'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
  multi: {
    FUNNY: { code: 'AC-1', desc: N_('敌方攻击强度较低的模拟训练'), effects: [N_('作战环境较为温和'), N_('常规奖励')] },
    NORMAL: { code: 'AC-2', desc: N_('敌方攻击强度较高的模拟训练'), effects: [N_('可使用盟约数增加'), N_('大幅增加奖励')] },
    HARD: { code: 'AC-3', desc: N_('敌方攻击强度极高的模拟训练'), effects: [N_('作战环境困难'), N_('出现更加危险的敌人')] },
    ABYSS: { code: 'AC-4', desc: N_('敌方攻击强度到达极限的模拟训练'), effects: [N_('作战环境无比困难'), N_('出现极度危险的敌人')] },
  },
};

/** Battlefield pool per difficulty when config.json is absent (the modes' `stages` lists; same for solo and co-op). */
export const STAGE_POOL = { FUNNY: ['act1autochess_m01'], NORMAL: 8, HARD: 7, ABYSS: 7 };

/** 开始匹配 waiting stage: how often the lobby re-asks the server for a seat in an existing room of the chosen size. */
export const MM_SEARCH_MS = 1500;

/**
 * Display name of a stage: stages.json when it is loaded, else derived from the id (act1 m0N → 战场#0N, act2 m0N → 战场#0(N+4)).
 * From the data name only its 战场#NN part (with a (上半) / (下半) mark) — 'Battlefield #NN (First Half)' in English.
 * @param {string} id e.g. 'act1autochess_m01'
 */
export function stageLabel(id) {
  const rec = getStage(id);
  if (rec && typeof rec.name === 'string' && rec.name) {
    const m = rec.name.match(/^(.*?#\d+(?:\s*[(（][^)）]*[)）])?)/);
    return m ? m[1] : rec.name.split(/\s+/)[0];
  }
  const m = String(id || '').match(/^act(\d)autochess_m(\d+)$/);
  return m ? t('战场#{no}', { no: String(Number(m[2]) + (m[1] === '2' ? 4 : 0)).padStart(2, '0') }) : '';
}

/**
 * The battlefield note of a difficulty (official wording): a single-stage pool is fixed ("战场固定为 战场#01"), a larger
 * one is drawn at random ("战场随机（共8张）").
 * @param {string[] | number | null | undefined} stages the mode's `stages` list (or a count)
 * @returns {string} '' when unknown
 */
export function stageNote(stages) {
  if (Array.isArray(stages)) {
    const ids = stages.filter((s) => typeof s === 'string' && s);
    if (ids.length === 1) { const name = stageLabel(ids[0]); return name ? t('战场固定为 {name}', { name }) : t('战场固定'); }
    return ids.length > 1 ? t('战场随机（共{n}张）', { n: ids.length }) : '';
  }
  return Number.isInteger(stages) && stages > 1 ? t('战场随机（共{stages}张）', { stages }) : '';
}

const MODE_CARDS = [
  {
    id: 'solo', name: N_('独立模拟'), en: 'SOLO SIMULATION', icon: 'user',
    desc: N_('独自调配资金与干员，以自己的节奏完成整场模拟。'),
    points: [N_('1 名博士'), N_('休整期与机变阶段不限时')],
  },
  {
    id: 'coop', name: N_('同盟模拟'), en: 'ALLIANCE SIMULATION', icon: 'users',
    desc: N_('与至多 {n} 名博士组成同盟，共享干员池，联防协作抵御敌潮。'), params: { n: MAX_SEATS - 1 },
    points: [N_('1–{n} 名博士 · 可由 AI 队友补位'), N_('联防阶段 · 最终攻势合并生命值')], pointParams: { n: MAX_SEATS },
  },
];

/**
 * Text for a difficulty card, preferring data/config.json.
 * @param {'solo'|'coop'} roomMode
 * @param {string} difficulty
 * @returns {{ code: string, desc: string, effects: string[], rounds: number, hidden: boolean, stageNote: string }}
 */
export function difficultyInfo(roomMode, difficulty) {
  const fallback = MODE_TEXT[roomMode === 'solo' ? 'single' : 'multi'][difficulty] || { code: '', desc: '', effects: [] };
  // modeIdFor() lower-cases the difficulty: never call it with a value the server did not validate.
  const m = DIFFICULTIES.includes(difficulty) ? getMode(modeIdFor(roomMode, difficulty)) : null;
  const effects = Array.isArray(m?.effectDescList)
    ? m.effectDescList.map((e) => String(e).replace(/^[·•・･\s]+/, '')).filter(Boolean)
    : fallback.effects.map((e) => t(e));
  const rounds = Number.isFinite(m?.lastRound) ? m.lastRound : roomMode === 'solo' && difficulty === 'FUNNY' ? 9 : 14;
  return {
    code: typeof m?.code === 'string' ? m.code : fallback.code,
    desc: typeof m?.desc === 'string' ? m.desc : t(fallback.desc),
    effects,
    rounds,
    hidden: difficulty !== 'FUNNY',
    stageNote: stageNote(Array.isArray(m?.stages) && m.stages.length ? m.stages : STAGE_POOL[difficulty]),
  };
}

const CODE_RE = new RegExp(`^[A-Z0-9]{${ROOM_CODE_LEN}}$`);
/**
 * Normalise user input into a room code: accepts a pasted invite link (`…?room=ABCD`), keeps
 * upper-cased alphanumerics and clamps to the code length.
 * @param {string} v
 * @returns {string}
 */
export function normalizeCode(v) {
  let s = String(v ?? '');
  const m = s.match(/[?&]room=([A-Za-z0-9]+)/);
  if (m) s = m[1];
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN);
}

/**
 * A handler that Preact binds as `onClick=${fn}` receives the click EVENT as its first argument, and a default
 * parameter only applies to `undefined` — so `fn(c = code)` would normalise the event target into a nonsense code
 * (`String(el)` → `"[object HTMLElement]"` → "OBJE"). Only a string is ever a code; anything else falls back to the
 * input field. Returns null when neither yields a well-formed code.
 * @param {unknown} arg the argument a handler was called with
 * @param {string} field the current input-field value
 * @returns {string|null}
 */
export function codeArg(arg, field) {
  const k = normalizeCode(typeof arg === 'string' ? arg : field);
  return CODE_RE.test(k) ? k : null;
}

/**
 * Room code from a deep link query string (`?room=CODE`), or null when absent/malformed.
 * Accepts ROOM_CODE_LEN..ROOM_CODE_LEN+2 alphanumerics (the protocol's join limit).
 * @param {string} search e.g. location.search
 * @returns {string|null}
 */
export function parseRoomParam(search) {
  try {
    const raw = new URLSearchParams(search || '').get('room');
    if (!raw) return null;
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9]+$/.test(code)) return null;
    return code.length >= ROOM_CODE_LEN && code.length <= ROOM_CODE_LEN + 2 ? code : null;
  } catch {
    return null;
  }
}

/** Recently joined/created co-op room codes (most recent first). */
export function recentRooms() {
  const list = loadPref('recentRooms', []);
  return Array.isArray(list) ? list.filter((c) => typeof c === 'string' && CODE_RE.test(c)).slice(0, 4) : [];
}

/** @param {string} code */
export function rememberRoom(code) {
  if (!CODE_RE.test(code)) return;
  savePref('recentRooms', [code, ...recentRooms().filter((c) => c !== code)].slice(0, 4));
}

function ModeCard({ card, selected, onSelect }) {
  return html`<button type="button" class=${`mode-card brackets${selected ? ' is-selected' : ''}`} onClick=${() => onSelect(card.id)}
      aria-pressed=${selected ? 'true' : 'false'}>
    <span class="mode-card__bg" aria-hidden="true"></span>
    <span class="mode-card__icon"><${Icon} name=${card.icon} /></span>
    <span class="mode-card__text">
      <${MicroLabel} tone=${selected ? 'mint' : undefined}>${card.en}<//>
      <span class="mode-card__name">${t(card.name)}</span>
      <span class="mode-card__desc">${t(card.desc, card.params)}</span>
      <span class="mode-card__points">${card.points.map((p) => html`<span key=${p}>${t(p, card.pointParams)}</span>`)}</span>
    </span>
    <span class="mode-card__check" aria-hidden="true"><${Icon} name="check" />${t('已选定')}</span>
  </button>`;
}

function DifficultyCard({ roomMode, difficulty, selected, onSelect }) {
  const info = difficultyInfo(roomMode, difficulty);
  return html`<button type="button" class=${`diff-card${selected ? ' is-selected' : ''}`}
      style=${`--d-color:${DIFFICULTY_COLORS[difficulty]}`} onClick=${() => onSelect(difficulty)} aria-pressed=${selected ? 'true' : 'false'}>
    <span class="diff-card__bar" aria-hidden="true"></span>
    <span class="diff-card__head">
      <${DifficultyIcon} difficulty=${difficulty} class="diff-card__glyph" />
      <span class="diff-card__name">${t(DIFFICULTY_NAMES[difficulty])}</span>
      <span class="diff-card__code num">${info.code}</span>
      <span class="diff-card__meta">
        <span class="num">${info.rounds}</span> ${tc('rounds', '回合')}${info.hidden ? html`<span class="diff-card__hidden">${t('+ 隐秘核心')}</span>` : null}
      </span>
    </span>
    <span class="diff-card__desc">${info.desc}</span>
    <span class="diff-card__effects">${info.effects.map((e) => html`<span key=${e}>${e}</span>`)}${info.stageNote ? html`<span key="stage" class="diff-card__stage"><${Icon} name="rook" />${info.stageNote}</span>` : null}</span>
    <span class="diff-card__check" aria-hidden="true"><${Icon} name="check" /><span>${t('已选定')}</span></span>
  </button>`;
}

/** Milliseconds from `now` to the NEXT local `hour:minute` (mirrors server/http/restart.js msUntilTime). */
function msUntilRestart(at, now) {
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), at.hour, at.minute, 0, 0);
  while (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now;
}

/** The countdown text: 'H 小时 M 分' / 'M 分 S 秒' / 'S 秒'. */
export function restartCountdownText(ms, tt = t) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return tt('{h} 小时 {m} 分', { h, m });
  if (m > 0) return tt('{m} 分 {s} 秒', { m, s: sec });
  return tt('{s} 秒', { s: sec });
}

/**
 * 每日重启 (this build): the lobby copy shows a **fixed 北京时间 03:25** — a product decision, so players always read 3:25
 * whatever the host clock is. The process schedules on its own local clock (`SP_RESTART_AT`, server/http/restart.js; the
 * default 19:25 makes a UTC host restart at 03:25 Beijing). `at` (welcome.restartAt) is only the ON/OFF signal — a null
 * hides the line; its hour/minute are ignored. The countdown targets the viewer's local 3:25 (the audience is 北京时间).
 */
export const RESTART_DISPLAY = Object.freeze({ hour: 3, minute: 25 });

/**
 * 每日重启倒计时 (welcome.restartAt as the on/off signal): a live, non-blocking line under the lobby header. Replaces
 * the old dismissible 「服务器每日 … 重启」 popup; renders nothing when the server has the feature off (restartAt null).
 * Amber inside the last 5 minutes. The displayed time is RESTART_DISPLAY, not the server's own value.
 */
export function RestartCountdown({ at }) {
  const on = !!(at && Number.isInteger(at.hour) && Number.isInteger(at.minute));
  const { hour, minute } = RESTART_DISPLAY;
  const time = on ? `${hour}:${String(minute).padStart(2, '0')}` : null;
  const [left, setLeft] = useState(() => (on ? msUntilRestart(RESTART_DISPLAY, serverNow()) : 0));
  const key = on ? `${hour}:${minute}` : '';
  useEffect(() => {
    if (!key) return undefined;
    const tick = () => setLeft(msUntilRestart(RESTART_DISPLAY, serverNow()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!time) return null;
  const soon = left <= 5 * 60_000;
  return html`<div class="lobby-restart" role="status" data-tone=${soon ? 'soon' : 'idle'} data-testid="restart-countdown">
    <span class="lobby-restart__dot" aria-hidden="true"></span>
    <span class="lobby-restart__text">${t('距服务器每日重启 {time} 还有', { time })} <b class="num" data-testid="restart-left">${restartCountdownText(left)}</b></span>
  </div>`;
}

/** Lobby screen component. */
export function LobbyScreen() {
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  useData('config');
  // 更新公告: entering the lobby, if there is anything unread the viewer opens by itself (author 2026-10-11).
  useEffect(() => { announceAutoOpen(); }, []);
  const [roomMode, setRoomMode] = useState(() => (loadPref('lobby.mode', 'coop') === 'solo' ? 'solo' : 'coop'));
  const [difficulty, setDifficulty] = useState(() => {
    const d = loadPref('lobby.difficulty', 'FUNNY');
    return DIFFICULTIES.includes(d) ? d : 'FUNNY';
  });
  const [code, setCode] = useState('');
  // 房间人数 (开始匹配 / 创建同盟): the room capacity both buttons open at — the matcher fills exactly this many seats.
  const [roomSize, setRoomSize] = useState(() => {
    const n = loadPref('lobby.roomSize', DEFAULT_ROOM_PLAYERS);
    return ROOM_PLAYER_OPTIONS.includes(n) ? n : DEFAULT_ROOM_PLAYERS;
  });
  const [busy, setBusy] = useState(null);
  // 开始匹配 (the waiting stage): true while the lobby is inside the server 匹配池 at `roomSize`. No room is opened by
  // the caller — the player waits (spinner) until enough matchers of the same difficulty + size are pooled and the
  // server opens a fresh room for exactly them, or cancels (the modal's close / 取消匹配).
  const [searching, setSearching] = useState(false);
  // 每日重启 (server SP_RESTART_AT, welcome.restartAt): a live countdown line under the header (RestartCountdown) —
  // replaces the old dismissible popup.
  const [recent] = useState(recentRooms);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);

  const online = conn.status === 'online';
  const codeOk = CODE_RE.test(code);

  // 每日重启 (welcome.restartAt): the countdown component reads it from the store directly
  const restartAt = useStore((s) => s.restartAt, shallowEqual);

  // 开始匹配 waiting stage: while it is open, re-ask the server to be in the 匹配池 at `roomSize` every MM_SEARCH_MS
  // (server/lobby.js _matchFromPool — idempotent: out of the pool and back in, so one human never counts twice). A miss
  // is a plain `ok`; a hit (the 匹配池 opened a fresh hidden room for the group) broadcasts room.state, which sets
  // store.room and unmounts this screen (clearing the timer).
  useEffect(() => {
    if (!searching || !online) return undefined;
    let stopped = false;
    const ask = () => { net.request('lobby.quickMatch', { difficulty, size: roomSize }).catch(() => {}); };
    ask();
    const id = setInterval(() => { if (!stopped) ask(); }, MM_SEARCH_MS);
    return () => { stopped = true; clearInterval(id); };
  }, [searching, online, difficulty, roomSize]);

  const pickMode = (m) => { setRoomMode(m); savePref('lobby.mode', m); };
  const pickDifficulty = (d) => { setDifficulty(d); savePref('lobby.difficulty', d); };
  const pickRoomSize = (n) => { setRoomSize(n); savePref('lobby.roomSize', n); };

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast(t('尚未连接到服务器，请稍候'), 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  // 创建同盟 opens the room at the chosen 房间人数 (co-op); 开始独立模拟 needs no capacity.
  const create = () => run('create', () => net.request('room.create', {
    mode: roomMode, difficulty, ...(roomMode === 'coop' ? { players: roomSize } : {}),
  }));
  // 沙盒 (娱乐玩法): a solo room flagged sandbox — the in-match 控制台 sets the map / waves / boss / 倍率 / 羁绊层数.
  // No 模拟难度 here (the author 2026-10-11: 沙盒 just asks for a map): fixed 终极 internally.
  const createSandbox = () => run('sandbox', () => net.request('room.create', { mode: 'solo', difficulty: 'ABYSS', sandbox: true }));
  // 无尽模式 (娱乐玩法): a fixed 4-player co-op room flagged endless — 取消 boss 轮 / 回合无限 / 共享血量固定 1 / 打桩环节.
  const createEndless = () => run('endless', () => net.request('room.create', { mode: 'coop', difficulty: 'ABYSS', players: 4, endless: true }));
  // 开始匹配: enter the waiting stage — the poll effect above enters the server 匹配池 at the chosen 模拟难度 + 房间人数;
  // when enough players of the same difficulty and size have queued up, the server opens a fresh room for exactly them
  // and starts it by itself (server/lobby.js _matchFromPool / _launchMatchedRoom). Nobody joins a hand-made room — the
  // matched group is always the 匹配池-built one. The player stays here until the group forms (or they cancel).
  const startMatchmaking = () => {
    if (!online) { toast(t('尚未连接到服务器，请稍候'), 'warn'); return; }
    setSearching(true);
  };
  const cancelMatchmaking = () => {
    // 开始匹配: tell the server to drop the caller from the 匹配池 (a miss is fine — nothing to undo on a quiet server)
    net.request('lobby.quickMatchCancel').catch(() => {});
    setSearching(false);
  };
  const join = (c = code) => {
    // `onClick=${join}` hands the click EVENT as the first argument, and a default parameter only applies to
    // `undefined` — codeArg keeps an event target out of the key and falls back to the input field
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    run('join', () => net.request('room.join', { code: k }));
  };
  // a spectator seat: no player seat taken, nothing to do but watch (also a match already running)
  const spectate = (c = code) => {
    // same guard as join: `onClick=${spectate}` passes the click event, not a code
    const k = codeArg(c, code);
    if (!k) { toast(t('同盟密钥为 {ROOM_CODE_LEN} 位字母或数字', { ROOM_CODE_LEN }), 'warn'); return; }
    run('spectate', () => net.request('room.spectate', { code: k }).catch((err) => {
      // Clearer than the bare ERR_TEXT: the usual cause is a code that is not the host's (a remembered one from an
      // earlier room, or another machine's) — the server can only answer "no such room".
      if (err?.code === ERR.ROOM_NOT_FOUND) {
        toast(t('没有找到密钥 {k} 对应的同盟：请和房主核对密钥（同盟结束后密钥即失效）', { k }), 'warn');
        return;
      }
      if (err?.code === ERR.ALREADY) {
        toast(t('你已经是该同盟的博士：先离开同盟，才能以观战身份进入'), 'warn');
        return;
      }
      throw err;
    }));
  };
  const backToTitle = () => {
    identity.setEntered(false);
    store.set((s) => ({ session: { ...s.session, entered: false } }));
  };

  return html`<div class="screen lobby-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${Button} variant="ghost" size="sm" icon="chevronLeft" onClick=${backToTitle} title=${t('返回标题')}>${t('返回')}<//>
        <${PingPill} ms=${conn.ping} online=${online} />
        <${OnlinePill} class="lobby-online" />
        <span class="lobby-ver" title=${`当前版本 v${APP_VERSION}`}><${MicroLabel}>v${APP_VERSION}<//></span>
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">SIMULATION PROTOCOL SELECT<//>
        <h1 class="topbar__title">${t('选择模拟协议')}</h1>
      </div>
      <div class="topbar__right">
        <${AnnounceButton} class="lobby-ann" />
        <${GuideButton} class="lobby-guide" variant="secondary" label=${t('玩法说明')} />
        <${FeedbackButton} class="lobby-feedback" variant="secondary" size="sm" />
        <${LoadoutButton} from="lobby" size="sm" class="lobby-loadout" label=${t('干员调配')} />
        <div class="me-chip">
          <${AvatarFrame} size="sm" name=${me.name} seat=${0} self=${true} />
          <div class="me-chip__text">
            <span class="me-chip__name">${me.name || t('博士')}</span>
            <${MicroLabel}>${me.playerId != null ? `DOCTOR #${doctorNo(me.playerId)}` : 'DOCTOR'}<//>
          </div>
        </div>
      </div>
    </header>

    <${RestartCountdown} at=${restartAt} />

    <div class="lobby-body screen__scroll">
      <section class="lobby-left">
        <div class="section-label"><span class="section-label__idx num">01</span>${t('模拟方式')}<${MicroLabel}>MODE<//></div>
        <div class="mode-cards">
          ${MODE_CARDS.map((c) => html`<${ModeCard} key=${c.id} card=${c} selected=${roomMode === c.id} onSelect=${pickMode} />`)}
        </div>

        <div class="section-label"><span class="section-label__idx num">·</span>${t('房间大厅')}<${MicroLabel}>ROOM HALL<//></div>
        <${Panel} class="mm-cta" tone="mint">
          <div class="mm-cta__row">
            <span class="mm-cta__text">
              <span class="mm-cta__title">${t('匹配在线博士')}</span>
              <span class="mm-cta__desc">${t('浏览服务器上公开的同盟房间并一键加入，也可以让系统直接把你送进最合适的那个。')}</span>
            </span>
            <span class="mm-cta__act">
              <${OnlinePill} label=${false} />
              <${MatchmakingButton} variant="primary" size="lg" />
            </span>
          </div>
        <//>

        <div class="section-label"><span class="section-label__idx num">03</span>${t('加入同盟')}<${MicroLabel}>JOIN WITH ALLIANCE KEY<//></div>
        <${Panel} class="join-panel" tone="amber">
          <div class="join-row">
            <${TextField} size="code" icon="key" value=${code} placeholder=${t('输入同盟密钥 / 粘贴邀请链接')}
              transform=${normalizeCode} onInput=${(v) => setCode(normalizeCode(v))} onEnter=${() => join()} />
            <${Button} variant="amber" size="lg" icon="users" loading=${busy === 'join'} disabled=${!codeOk || !online} onClick=${() => join()}>${t('加入同盟')}<//>
            <${Tooltip} text=${t('以观战者身份进入：不占博士席位，只能观看（每个同盟最多 {MAX_SPECTATORS} 名，模拟进行中也可进入）', { MAX_SPECTATORS })}>
              <${Button} variant="secondary" size="lg" icon="eye" class="join-spectate" loading=${busy === 'spectate'} disabled=${!codeOk || !online} onClick=${spectate}>${t('观战')}<//>
            <//>
          </div>
          <div class="join-foot">
            ${recent.length ? html`<span class="t-lo">${t('最近的同盟')}</span>
              ${recent.map((c) => html`<button key=${c} type="button" class="code-chip num" title=${t('填入密钥（不会直接加入）')}
                onClick=${() => setCode(c)}>${c}</button>`)}`
              : html`<span class="t-dim">${t('向同伴索取 {ROOM_CODE_LEN} 位同盟密钥，或直接打开邀请链接', { ROOM_CODE_LEN })}</span>`}
          </div>
        <//>

        <div class="section-label"><span class="section-label__idx num">04</span>${t('娱乐玩法')}<${MicroLabel}>ENTERTAINMENT<//></div>
        <${Panel} class="mm-cta" tone="mint">
          <div class="mm-cta__row">
            <span class="mm-cta__text">
              <span class="mm-cta__title">${t('沙盒')}</span>
              <span class="mm-cta__desc">${t('接下来自由探索吧')}</span>
            </span>
            <span class="mm-cta__act">
              <${Button} variant="amber" size="lg" icon="rook" loading=${busy === 'sandbox'} disabled=${!online} onClick=${createSandbox}>${t('进入沙盒')}<//>
            </span>
          </div>
          <div class="mm-cta__row">
            <span class="mm-cta__text">
              <span class="mm-cta__title">${t('无尽狂潮')}</span>
              <span class="mm-cta__desc">${t('固定四人 · 无尽回合 · 打桩结算')}</span>
            </span>
            <span class="mm-cta__act">
              <${Button} variant="amber" size="lg" icon="signal" loading=${busy === 'endless'} disabled=${!online} onClick=${createEndless}>${t('进入无尽')}<//>
            </span>
          </div>
        <//>
      </section>

      <section class="lobby-right">
        <div class="section-label"><span class="section-label__idx num">02</span>${t('模拟难度')}<${MicroLabel}>DIFFICULTY<//></div>
        <div class="diff-list">
          ${DIFFICULTIES.map((d) => html`<${DifficultyCard} key=${d} roomMode=${roomMode} difficulty=${d} selected=${difficulty === d} onSelect=${pickDifficulty} />`)}
        </div>
        <div class="create-box">
          ${roomMode === 'coop' ? html`
            <div class="create-box__size">
              <span class="create-box__size-label">${t('房间人数')}</span>
              <div class="pcount__chips" role="radiogroup" aria-label=${t('房间人数')}>
                ${ROOM_PLAYER_OPTIONS.map((n) => html`<button key=${n} type="button" role="radio"
                  aria-checked=${roomSize === n ? 'true' : 'false'}
                  class=${`pcount__chip${roomSize === n ? ' is-active' : ''}`} disabled=${!online}
                  onClick=${() => { if (roomSize !== n) pickRoomSize(n); }}>${n}</button>`)}
              </div>
            </div>` : null}
          <div class=${`create-box__actions${roomMode === 'coop' ? ' is-split' : ''}`}>
            <${Tooltip} block=${true} text=${online ? null : t('正在连接服务器…')}>
              <${Button} variant="primary" size="xl" block=${true} iconRight="chevrons" loading=${busy === 'create'} disabled=${!online} onClick=${create}>
                ${roomMode === 'solo' ? t('开始独立模拟') : t('创建同盟')}
              <//>
            <//>
            ${roomMode === 'coop' ? html`
              <${Tooltip} block=${true} text=${online ? t('按所选模拟难度与房间人数加入有空位的公开同盟，人满自动开始；没有合适的房间时会一直等待，可随时取消') : t('正在连接服务器…')}>
                <${Button} variant="ice" size="xl" block=${true} icon="signal" disabled=${!online} onClick=${startMatchmaking}>
                  ${t('开始匹配')}
                <//>
              <//>` : null}
          </div>
          <div class="create-box__hint">
            ${online
              ? html`<span>${roomMode === 'solo' ? t('创建后即可开始模拟') : t('创建后可邀请好友或添加 AI 队友')}</span>`
              : html`<${Spinner} size="sm" label="CONNECTING" />`}
          </div>
        </div>
      </section>

      <section class="lobby-library">
        <div class="section-label"><span class="section-label__idx num">05</span>${t('排行榜')}<${MicroLabel}>LEADERBOARD<//></div>
        <${LobbyLeaderboard} />
      </section>
    </div>

    ${searching ? html`<${Modal} open=${true} title=${t('正在匹配')} micro="MATCHMAKING" tone="mint"
        onClose=${cancelMatchmaking} width="min(400px, 92vw)">
      <div class="lobby-mm">
        <${Spinner} size="lg" label="SEARCHING" />
        <p class="lobby-mm__text">${t('正在寻找 {mode} · 房间人数 {n} 的公开同盟…', { mode: t(DIFFICULTY_NAMES[difficulty]), n: roomSize })}</p>
        <p class="lobby-mm__hint">${t('匹配到有空位的同盟后会自动加入并准备就绪；没有合适的房间时会一直等待，你可以随时取消。')}</p>
        <${Button} variant="secondary" block=${true} icon="close" onClick=${cancelMatchmaking}>${t('取消匹配')}<//>
      </div>
    <//>` : null}

    <${PreloadWidget} />
  </div>`;
}
