// 预载资源 (this build): the read side of the local cache — what the asset loaders consult before going to the network.
//
// The preloader (./service.js) is installed here once (`setAssetCache`); the loaders call `cachedBlob(url)` and fall back
// to the network when it returns null. Nothing here touches the network itself, and with no cache installed every call
// returns null — so the Node tests of assets.js / audio.js keep working unchanged.
//
// Which loaders use it (and which cannot):
//   * public/js/assets.js `image()`   — every PIXI-side image (operator pictures, board art, the mountain).
//   * public/js/audio.js  `_buffer()` — background music, SFX, voice lines.
// Both are async choke points, so the cached bytes are read on demand (one blob at a time — the whole 460 MB is never
// held in memory) and handed over as a `blob:` URL / ArrayBuffer.
//
// NOT served from here: Spine models and fonts. pixi-spine resolves an atlas's page images relative to the `.skel` URL,
// which a blob: URL breaks, and `@font-face` URLs inside fonts.css cannot be intercepted at all without a Service
// Worker (unavailable on a plain-http origin). Both are still preloaded — that keeps the browser's own HTTP cache warm.

let source = null;

/** Install (or clear) the cache read side. @param {{ blobFor: (url: string) => Promise<Blob|null> } | null} s */
export function setAssetCache(s) {
  source = s && typeof s.blobFor === 'function' ? s : null;
}

/** Whether a cache is installed (diagnostics). */
export function hasAssetCache() { return !!source; }

/**
 * The cached bytes of an asset, or null when it is not cached (or anything goes wrong reading it — a cache problem
 * must never break the game).
 * @param {string} url
 * @returns {Promise<Blob|null>}
 */
export async function cachedBlob(url) {
  if (!source || typeof url !== 'string' || !url) return null;
  try { return await source.blobFor(url); } catch { return null; }
}

/**
 * A `blob:` URL for a cached asset, or null. `revoke()` frees it — call it once the consumer has the data (an <img> keeps
 * its decoded bitmap, so revoking right after load is fine).
 * @param {string} url
 * @returns {Promise<{ src: string, revoke: () => void } | null>}
 */
export async function cachedObjectUrl(url) {
  const blob = await cachedBlob(url);
  if (!blob) return null;
  let src = null;
  try { src = URL.createObjectURL(blob); } catch { return null; }
  return { src, revoke: () => { try { URL.revokeObjectURL(src); } catch { /* already gone */ } } };
}
