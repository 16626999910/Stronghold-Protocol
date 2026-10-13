// 预载资源 (this build): the asset list the player preloads into the local cache, derived from the asset manifest
// (`/data/assets.json`, docs/ASSETS.md).
//
// Instead of enumerating every field by hand (the manifest gains fields with every game update), this walks the whole
// object and keeps every string that names a shipped asset file (`/assets/…`, `/fonts/…`), tagging it by the branch it
// came from; `skillsById` and friends (an id → iconId index) never match, so nothing bogus gets in. New manifest fields
// are therefore picked up automatically.
//
// Categories mirror the reference 预载资源管理 panel: five REQUIRED ones (what a match needs immediately) and four
// OPTIONAL ones (the bulk: operator 头像, Spine models, maps/boards, 玩法说明 art — downloaded only when 同时预载 is on).
//
// Pure: no I/O, no browser API — unit tested in Node.

/** The categories, in display order. `required` decides whether 同时预载 must be on. */
export const CATEGORIES = Object.freeze([
  { id: 'ui', required: true, key: '界面、图标与字体' },
  { id: 'icon', required: true, key: '干员与敌人图片' },
  { id: 'bgm', required: true, key: '背景音乐' },
  { id: 'sfx', required: true, key: '音效' },
  { id: 'voice', required: true, key: '角色语音' },
  { id: 'avatar', required: false, key: '头像' },
  { id: 'spine', required: false, key: 'Spine 模型与特效' },
  { id: 'map', required: false, key: '地图与棋盘' },
  { id: 'guide', required: false, key: '玩法说明与其他资源' },
]);

const CATEGORY_IDS = new Set(CATEGORIES.map((c) => c.id));
export const isCategory = (id) => CATEGORY_IDS.has(id);
/** Whether a category is part of the required set. */
export const isRequired = (id) => !!(CATEGORIES.find((c) => c.id === id) || {}).required;

/** A shipped asset file path (what the pipeline produced and the preloader should fetch). */
const ASSET_URL = /^\/(?:assets|fonts)\//;

/**
 * The category of a manifest path: `['audio','voice','char_x','start']` → 'voice', `['chars','char_x','spine',…]` → 'spine'.
 * @param {string[]} path
 */
export function categoryOf(path) {
  const [top, second] = path;
  if (top === 'audio') {
    if (second === 'voice' || second === 'voiceJp') return 'voice';
    if (second === 'sfx') return 'sfx';
    return 'bgm'; // bgm / bossBgm
  }
  if (top === 'fonts' || top === 'ui' || top === 'prof') return 'ui';
  if (top === 'guide') return 'guide';
  if (top === 'maps' || top === 'boards') return 'map';
  // 个人头像 (this build): `avatars.<id>` = a 游戏本体玩家头像 (`/assets/avatar/*.png`) — its own OPTIONAL category.
  if (top === 'avatars') return 'avatar';
  if (top === 'chars' || top === 'enemies' || top === 'tokens') {
    // a spine model block (`spine.front/back`, skins' spine) — everything else on these branches is an image/icon
    return path.includes('spine') ? 'spine' : 'icon';
  }
  if (top === 'bonds' || top === 'items' || top === 'bands' || top === 'skills' || top === 'modules') return 'icon';
  return 'other';
}

/**
 * Every asset in one manifest: `{ files: [{ url, category }], counts: { [category]: n }, total, bytes }`.
 * `bytes` is the manifest's own `stats.bytes` when present (the aggregate the pipeline recorded), else 0 — the panel
 * shows real bytes only as files arrive.
 * @param {any} manifest `/data/assets.json` (null → empty)
 * @param {{ extra?: any[] }} [opts] extra manifests to include (e.g. the optional local-client art, `data/local-assets.json`)
 */
export function collectAssets(manifest, { extra = [] } = {}) {
  const files = [];
  const seen = new Set();
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  let other = 0;

  const add = (url, category) => {
    if (seen.has(url)) return;
    seen.add(url);
    files.push({ url, category });
    if (cat(category)) counts[category]++;
    else other++;
  };
  const cat = (c) => Object.hasOwn(counts, c);

  const walk = (value, path) => {
    if (typeof value === 'string') {
      if (ASSET_URL.test(value)) add(value, categoryOf(path));
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, path);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path.concat(k));
    }
  };
  walk(manifest, []);

  // the optional local-client art (`data/local-assets.json`): always the 地图与棋盘 bucket
  for (const m of extra) walkLocal(m, add);

  const total = files.length + other;
  const stats = manifest && typeof manifest === 'object' ? manifest.stats : null;
  const bytes = stats && Number.isFinite(stats.bytes) ? stats.bytes : 0;
  return { files, counts, other, total, bytes };
}

/** `data/local-assets.json` `{ groups: { map: { name: { path } }, … } }` → its asset paths. */
function walkLocal(local, add) {
  const groups = local && typeof local === 'object' ? local.groups : null;
  if (!groups || typeof groups !== 'object') return;
  for (const g of Object.values(groups)) {
    if (!g || typeof g !== 'object') continue;
    for (const rec of Object.values(g)) {
      const p = rec && typeof rec === 'object' ? rec.path : null;
      if (typeof p === 'string' && p) add(p, 'map');
    }
  }
}

/**
 * The categories that actually have files, in `CATEGORIES` order — what the manager panel renders.
 * @param {{ counts: Record<string, number> }} collected
 */
export function activeCategories(collected) {
  return CATEGORIES.filter((c) => (collected.counts[c.id] || 0) > 0);
}
