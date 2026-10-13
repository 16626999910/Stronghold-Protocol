// shared/chat.js — the one text cleaner shared by in-match chat (server/match/match/intents.js) and 大厅聊天
// (server/lobbyChat.js). Kept here so neither layer reaches into the other for it.
//
// cleanChatText: strip control characters (C0/C1), collapse runs of whitespace to a single space, trim; return null
// for a non-string or an empty result. The cap counts **code points** ([...t]), so a cut never splits a surrogate pair
// (an emoji stays whole). Broadcast/stored text is therefore already tidy; the client renders it as a text node.

import { CHAT_MAX_LEN } from './constants.js';

/**
 * @param {unknown} raw
 * @param {number} [max] max length in code points
 * @returns {string|null} the cleaned text, or null when nothing is left / not a string
 */
export function cleanChatText(raw, max = CHAT_MAX_LEN) {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const cp = [...t];
  return cp.length > max ? cp.slice(0, max).join('') : t;
}
