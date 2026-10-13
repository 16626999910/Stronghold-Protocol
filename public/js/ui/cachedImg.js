// public/js/ui/cachedImg.js — 界面 <img> 的预载缓存接入。
//
// 渲染层（PIXI）走 `assets.image()`、音频走 `audio.js`，它们都先查预载缓存（public/js/preload/cache.js）。
// 但**界面用的普通 DOM `<img>`**（自选/皮肤头像、局内表情、各种小图标）以前完全没查缓存 —— 预载明明把
// `/assets/**` 存进了 IndexedDB，这些 <img> 还是每张都实时走网络（严格镜像模式下即镜像），冷缓存时每张
// 100~800ms，一屏几十张就肉眼可见地慢。这个 hook 让它们和渲染层一致：命中缓存就用本地 `blob:` 秒出，
// 未命中（没预载 / 不在清单里）才回落网络。
//
// 用法：`const [src, ready, onLoad] = useCachedSrc(url)` → 把 `src` 给 `<img src>`、`ready` 为 true 后再渲染、
// 把 `onLoad` 接到 `<img onLoad>`（加载后释放 blob URL —— <img> 已经拿到解码后的位图，和 assets.image 一致）。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { h } from '../../vendor/preact.module.js';
import htm from '../../vendor/htm.module.js';
import { cachedObjectUrl } from '../preload/cache.js';

const html = htm.bind(h);

/**
 * Resolve `url` through the 预载 cache. Returns `[src, ready, onLoad]`:
 *   `src`    the local `blob:` URL when cached, else `url` unchanged (network / mirror);
 *   `ready`  false while the (fast, IndexedDB) lookup is pending — render a placeholder until then, so an uncached
 *            `<img>` does NOT start a network request that the cache hit would only cancel;
 *   `onLoad` wire to `<img onLoad>` to free the blob URL once the element holds the decoded bitmap.
 * @param {string|null|undefined} url
 * @returns {[string|null|undefined, boolean, () => void]}
 */
export function useCachedSrc(url) {
  const [hit, setHit] = useState(null);        // { src, revoke } | null
  const [ready, setReady] = useState(false);   // false = the lookup has not answered yet
  useEffect(() => {
    let alive = true;
    setHit(null);
    setReady(false);
    if (!url) { setReady(true); return undefined; }
    cachedObjectUrl(url)
      .then((h) => { if (!alive) { if (h) h.revoke(); return; } setHit(h); setReady(true); })
      .catch(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [url]);
  const src = hit ? hit.src : url;
  return [src, ready, () => { if (hit) hit.revoke(); }];
}

/**
 * `<img>` whose `src` goes through the 预载 cache (useCachedSrc). Renders nothing until the lookup answers — a local
 * IndexedDB read, a blink at worst — so an un-preloaded file still falls back to the network URL. Hook-free callers
 * (SkinRow) can render it directly.
 * @param {{ src?: string|null, class?: string, alt?: string, loading?: string }} props
 */
export function CachedImg({ src, class: cls, alt = '', loading = 'lazy' }) {
  const [shown, ready, onLoaded] = useCachedSrc(src);
  if (!src || !ready) return null;
  return html`<img class=${cls} src=${shown} alt=${alt} draggable=${false} loading=${loading} onLoad=${onLoaded} />`;
}
