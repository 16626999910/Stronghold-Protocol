#!/usr/bin/env node
// tools/sync-assets-mirror.mjs — 把 data/assets.json 引用的、但素材镜像仓库 (bin-g-ice/-) 里还没有的素材
// 同步上去（assets/** 与 fonts/**）。本机直连 github.com:443 不通，只有 api.github.com 可达，故走 GitHub REST
// Git Data API 建 blob/tree/commit 并更新 ref，无需 clone。
//
//   GH_TOKEN=ghp_xxx node tools/sync-assets-mirror.mjs [--dry-run]
//
// token 只从 GH_TOKEN / GITHUB_TOKEN 环境变量读，不写入磁盘。已存在（按路径）的文件跳过；盘上缺失的清单条目
// 只警告、不上传。为保证一个文件全部字节一致，只有“路径不存在”才传新文件，不覆盖已有路径。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'E:/卫戍协议';
const OWNER = 'bin-g-ice';
const REPO = '-';
const BRANCH = 'main';
const DRY = process.argv.includes('--dry-run');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(2); }
const API = 'https://api.github.com';

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'stronghold-mirror-sync', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${json?.message || text.slice(0, 200)}`);
  return json;
}

// 1) 清单引用的 /assets/** 与 /fonts/**
const manifest = JSON.parse(readFileSync(join(ROOT, 'data/assets.json'), 'utf8'));
const refs = new Set();
(function walk(v) {
  if (v == null) return;
  if (typeof v === 'string') {
    for (const pre of ['/assets/', '/fonts/']) if (v.startsWith(pre)) refs.add(v.slice(1));
    return;
  }
  if (Array.isArray(v)) { v.forEach(walk); return; }
  if (typeof v === 'object') for (const x of Object.values(v)) walk(x);
})(manifest);

// 2) 镜像现有文件集合
const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const headCommit = ref.object.sha;
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits/${headCommit}`);
const rootTree = commit.tree.sha;
const tree = await api(`/repos/${OWNER}/${REPO}/git/trees/${rootTree}?recursive=1`);
if (tree.truncated) throw new Error('镜像 tree 被截断，需分页（未实现）');
const have = new Set();
for (const e of tree.tree) if (e.type === 'blob') have.add(e.path);
console.log(`镜像 blobs ${have.size}，清单引用 ${refs.size}`);

// 3) 缺失 = 清单有、镜像无、盘上有
const missing = []; let noDisk = 0, bytes = 0;
for (const p of refs) {
  if (have.has(p)) continue;
  const file = join(ROOT, 'public', p);
  if (!existsSync(file)) { noDisk++; continue; }
  missing.push({ path: p, file, size: statSync(file).size });
  bytes += statSync(file).size;
}
missing.sort((a, b) => a.path.localeCompare(b.path));
console.log(`待上传 ${missing.length} 个（${(bytes / 1048576).toFixed(1)} MiB）；盘上缺失清单条目 ${noDisk} 个`);
if (DRY) { console.log('--dry-run：只报告。'); process.exit(0); }
if (!missing.length) { console.log('镜像已是最新，无需上传。'); process.exit(0); }   // 空 tree 会被 GitHub 拒（422 Invalid tree info）

// 4) blobs
const entries = [];
let n = 0;
for (const m of missing) {
  const buf = readFileSync(m.file);
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }) });
  entries.push({ path: m.path, mode: '100644', type: 'blob', sha: blob.sha });
  if (++n % 100 === 0) console.log(`  blobs ${n}/${missing.length}`);
}

// 5) tree + commit + ref
const newTree = await api(`/repos/${OWNER}/${REPO}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: rootTree, tree: entries }) });
const newCommit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message: `assets: 同步清单中镜像缺失的 ${missing.length} 个文件`, tree: newTree.sha, parents: [headCommit] }),
});
await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) });
console.log(`完成：${newCommit.sha.slice(0, 10)} —— 推送 ${missing.length} 个文件（${(bytes / 1048576).toFixed(1)} MiB）`);
