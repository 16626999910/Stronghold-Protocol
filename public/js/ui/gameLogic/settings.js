// ui/gameLogic/settings.js — settings defaults and sanitising. Re-exported from ../gameLogic.js.

import { clamp, isObj } from './shared.js';
import { DEFAULT_HOTKEYS, sanitizeHotkeys } from './shortcuts.js';


// ---- settings ------------------------------------------------------------------------------------------------------

/** keys: the in-match shortcuts' key map (ui/gameLogic/shortcuts.js; settings → 快捷键). */
export const DEFAULT_SETTINGS = Object.freeze({ bgm: 0.6, sfx: 0.8, voice: 0.8, muted: false, damageNumbers: true, quality: 'high', battleSpeed: 1, voiceLang: 'jp', keys: DEFAULT_HOTKEYS });
const QUALITIES = ['high', 'medium', 'low'];
/** 战斗速度 (this build): the top bar's batch toggle (ui/hud.js SpeedButton → battle/runner.js setBattleSpeedFactor). */
export const BATTLE_SPEEDS = Object.freeze([1, 2]);
/** 语音语言 (this build): which dub a battle voice line plays (audio.js voiceLang; the other is the fallback). */
export const VOICE_LANGS = Object.freeze([['jp', '日语'], ['cn', '中文']]);

/**
 * Sanitize persisted settings.
 * @param {any} raw
 * @returns {{ bgm: number, sfx: number, voice: number, muted: boolean, damageNumbers: boolean, quality: 'high'|'medium'|'low',
 *   battleSpeed: number, voiceLang: 'jp'|'cn',
 *   keys: Record<'refresh'|'freeze'|'levelUp'|'retreat'|'sell'|'ready', string> }}
 */
export function sanitizeSettings(raw) {
  const r = isObj(raw) ? raw : {};
  const vol = (v, d) => (Number.isFinite(v) ? clamp(Math.round(v * 100) / 100, 0, 1) : d);
  return {
    bgm: vol(r.bgm, DEFAULT_SETTINGS.bgm),
    sfx: vol(r.sfx, DEFAULT_SETTINGS.sfx),
    voice: vol(r.voice, DEFAULT_SETTINGS.voice),
    muted: typeof r.muted === 'boolean' ? r.muted : DEFAULT_SETTINGS.muted,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULT_SETTINGS.damageNumbers,
    quality: QUALITIES.includes(r.quality) ? r.quality : DEFAULT_SETTINGS.quality,
    battleSpeed: BATTLE_SPEEDS.includes(r.battleSpeed) ? r.battleSpeed : DEFAULT_SETTINGS.battleSpeed,
    voiceLang: r.voiceLang === 'cn' || r.voiceLang === 'jp' ? r.voiceLang : DEFAULT_SETTINGS.voiceLang,
    keys: sanitizeHotkeys(r.keys),
  };
}
