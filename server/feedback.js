// server/feedback.js — 问题反馈 (this build): a small message board the lobby's 问题反馈 button opens. Players post a
// message and comment on one another's messages; everything is kept on the server in ONE JSON file so it survives a
// restart (the rest of the server is stateless — rooms and matches live in memory only).
//
//   const board = new Feedback({ file, log })   // loads the file (missing / broken → starts empty)
//   board.list()                                 → the items, newest message first
//   board.post({ playerId, name, text })         → the new item, or null when the text is empty
//   board.comment({ id, playerId, name, text })  → the updated item, or null (unknown id / empty text)
//
// The file lives OUTSIDE the served directories (default <root>/feedback/feedback.json — never /data, which the static
// server serves), so nobody can fetch other players' reports by URL. Writes are atomic (temp file + rename) and
// best-effort: a failed write is logged and the board keeps working in memory.
//
// Caps keep the file bounded: the newest `maxItems` messages, `maxComments` comments each, `maxText` / `maxComment`
// characters per text. Timestamps come from the injected `now` (ms).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './http/config.js';

/** Default board file (never inside a served directory). */
export const DEFAULT_FEEDBACK_FILE = () => path.join(ROOT, 'feedback', 'feedback.json');

const noopLog = { info() {}, warn() {}, error() {} };

/**
 * Strip control characters (keeping newlines and tabs), normalize line endings, trim and cap the length. The client
 * renders text as text nodes, so this is only about tidy storage, not escaping.
 * @param {unknown} t @param {number} max
 */
export function cleanText(t, max) {
  return String(t ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

/** Tunables of the board. */
export const FEEDBACK_DEFAULTS = Object.freeze({
  maxItems: 300,     // newest messages kept
  maxComments: 200,  // comments kept per message
  maxText: 500,      // characters of a message
  maxComment: 300,   // characters of a comment
});

/** @typedef {{ id: number, playerId: string, name: string, text: string, at: number,
 *              comments: { id: number, playerId: string, name: string, text: string, at: number }[] }} FeedbackItem */

export class Feedback {
  /**
   * @param {{ file?: string | null, log?: object, now?: () => number } & Partial<typeof FEEDBACK_DEFAULTS>} [opts]
   */
  constructor({ file = undefined, log = noopLog, now = Date.now, ...caps } = {}) {
    this.file = file === undefined ? DEFAULT_FEEDBACK_FILE() : file; // null → memory-only (tests)
    this.log = log;
    this.now = now;
    this.opts = { ...FEEDBACK_DEFAULTS, ...caps };
    /** @type {FeedbackItem[]} newest first */
    this.items = [];
    this.seq = 1;
    this.load();
  }

  /** Read the board file (missing / unreadable → empty). Never throws. */
  load() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const items = Array.isArray(data?.items) ? data.items : [];
      this.items = items.filter(isItem).slice(0, this.opts.maxItems);
      const maxId = this.items.reduce((m, it) => Math.max(m, it.id), 0);
      this.seq = Math.max(Number(data?.seq) || 0, maxId + 1, 1);
    } catch (e) {
      this.log.warn?.('[feedback] could not read the board file, starting empty', e);
      this.items = [];
      this.seq = 1;
    }
  }

  /** Write the board file atomically (temp + rename). Best-effort — a failure is logged, not thrown. */
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, seq: this.seq, items: this.items }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log.error?.('[feedback] could not save the board file', e);
    }
  }

  /** The items, newest message first. */
  list() {
    return this.items;
  }

  /**
   * Post a new message.
   * @param {{ playerId: string, name: string, text: string }} input
   * @returns {FeedbackItem | null} null when the text is empty after cleaning
   */
  post({ playerId, name, text }) {
    const body = cleanText(text, this.opts.maxText);
    if (!body) return null;
    const item = { id: this.seq++, playerId: String(playerId ?? ''), name: cleanText(name, 32), text: body, at: this.now(), comments: [] };
    this.items.unshift(item);
    if (this.items.length > this.opts.maxItems) this.items.length = this.opts.maxItems;
    this.save();
    return item;
  }

  /**
   * Comment on a message.
   * @param {{ id: number, playerId: string, name: string, text: string }} input
   * @returns {FeedbackItem | null} null when the id is unknown or the text is empty
   */
  comment({ id, playerId, name, text }) {
    const item = this.items.find((it) => it.id === id);
    if (!item) return null;
    const body = cleanText(text, this.opts.maxComment);
    if (!body) return null;
    item.comments.push({ id: this.seq++, playerId: String(playerId ?? ''), name: cleanText(name, 32), text: body, at: this.now() });
    if (item.comments.length > this.opts.maxComments) item.comments.splice(0, item.comments.length - this.opts.maxComments);
    this.save();
    return item;
  }

  /**
   * Delete one of the caller's OWN messages (its comments go with it).
   * @param {number} id @param {string} playerId
   * @returns {boolean} false when there is no such message or the caller did not write it
   */
  removeItem(id, playerId) {
    const i = this.items.findIndex((it) => it.id === id);
    if (i < 0 || this.items[i].playerId !== playerId) return false;
    this.items.splice(i, 1);
    this.save();
    return true;
  }

  /**
   * Delete one of the caller's OWN comments.
   * @param {number} id message id @param {number} commentId @param {string} playerId
   * @returns {boolean} false when the message / comment is unknown or not the caller's
   */
  removeComment(id, commentId, playerId) {
    const item = this.items.find((it) => it.id === id);
    if (!item) return false;
    const j = item.comments.findIndex((c) => c.id === commentId);
    if (j < 0 || item.comments[j].playerId !== playerId) return false;
    item.comments.splice(j, 1);
    this.save();
    return true;
  }
}

/** Shape check for one loaded item (a hand-edited or truncated file must not crash the server). */
function isItem(it) {
  return !!it && typeof it === 'object'
    && Number.isInteger(it.id) && it.id > 0
    && typeof it.text === 'string'
    && Number.isFinite(it.at)
    && Array.isArray(it.comments);
}
