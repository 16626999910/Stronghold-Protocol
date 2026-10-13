// server/lobbyChat.js — 大厅聊天 (this build): the lobby's chat board. A pure in-memory ring buffer — unlike the 问题反馈
// board (server/feedback.js) nothing is written to disk, so a server restart starts the chat over (与「聊天记录仅保存在
// 本次运行」一致).
//
//   const chat = new LobbyChat({ maxItems, maxText, now, log })
//   chat.push({ playerId, name, status, kind, text?, emote?, code? })  → the stored item, or null (rejected)
//   chat.list()                                                        → the ring, oldest first
//
// `status` is the sender's activity at send time ('lobby' | 'room'), captured by server/lobby.js. `kind` is one of
// 'text' | 'emote' | 'party'; text is cleaned + capped by code point (shared/chat.js), an emote must be a known id, and
// a party ad must carry the sender's room code (derived server-side). The cap keeps memory bounded.

import { EMOTES, LOBBY_CHAT_MAX_LEN } from '../shared/constants.js';
import { cleanChatText } from '../shared/chat.js';

const noopLog = { info() {}, warn() {}, error() {} };

/** Tunables of the board. */
export const LOBBY_CHAT_DEFAULTS = Object.freeze({
  maxItems: 100,            // newest messages kept (the ring capacity)
  maxText: LOBBY_CHAT_MAX_LEN, // characters (code points) of a text message
});

/**
 * @typedef {{ id: number, playerId: string, name: string, status: 'lobby'|'room',
 *             kind: 'text'|'emote'|'party', text?: string, emote?: string, code?: string, at: number }} LobbyChatItem
 */

export class LobbyChat {
  /**
   * @param {{ now?: () => number, log?: object } & Partial<typeof LOBBY_CHAT_DEFAULTS>} [opts]
   */
  constructor({ now = Date.now, log = noopLog, ...caps } = {}) {
    this.now = now;
    this.log = log;
    this.opts = { ...LOBBY_CHAT_DEFAULTS, ...caps };
    /** @type {LobbyChatItem[]} oldest first */
    this.items = [];
    this.seq = 1;
  }

  /** The ring, oldest first. */
  list() {
    return this.items;
  }

  /**
   * Append a message.
   * @param {{ playerId: string, name: string, status: 'lobby'|'room', kind: 'text'|'emote'|'party',
   *           text?: unknown, emote?: unknown, code?: unknown }} input
   * @returns {LobbyChatItem | null} null when the message is refused (empty/oversized text, unknown emote, no code)
   */
  push({ playerId, name, status, kind, text, emote, code }) {
    const item = { id: this.seq, playerId: String(playerId ?? ''), name: cleanChatText(name, 32) || '', status, kind, at: this.now() };
    if (kind === 'text') {
      const body = cleanChatText(text, this.opts.maxText);
      if (!body) return null;
      item.text = body;
    } else if (kind === 'emote') {
      if (!EMOTES.includes(emote)) return null;
      item.emote = emote;
    } else if (kind === 'party') {
      if (typeof code !== 'string' || !code) return null;
      item.code = code;
    } else {
      return null;
    }
    this.seq++;
    this.items.push(item);
    if (this.items.length > this.opts.maxItems) this.items.splice(0, this.items.length - this.opts.maxItems);
    return item;
  }
}
