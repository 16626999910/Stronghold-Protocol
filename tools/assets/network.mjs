// Explicit download-source selection and one shared policy per asset invocation.
// Selecting a source never looks up the user's public IP or makes a request.
import { downloadUrls, normalizeProxyPrefixes } from './sources.mjs';

export function validateSource(mode) {
  if (!['direct', 'mirror'].includes(mode)) throw new Error(`unknown asset source: ${mode} (direct|mirror)`);
  return mode;
}

export async function selectDownloadSource({ mode = 'direct', offline = false, proxyPrefix, proxyPrefixes, log = console.log } = {}) {
  validateSource(mode);
  if (offline) return 'direct';
  const prefixes = mode === 'mirror'
    ? normalizeProxyPrefixes(proxyPrefixes !== undefined ? proxyPrefixes : (proxyPrefix !== undefined ? proxyPrefix : undefined))
    : [];
  const label = prefixes.length ? prefixes.join(' → ') : '代理已禁用';
  log(mode === 'mirror'
    ? `[network] 手动开启 GitHub 镜像：${label}；文件仅校验格式和大小。`
    : '[network] 原始源（未开启 GitHub 镜像）');
  return mode;
}

/**
 * Shared by indexes, files, Spine follow-ups and fonts. Holds the ordered mirror prefixes and a per-prefix
 * circuit breaker: a prefix that fails `failureLimit` times in a row is dropped for the rest of the run
 * (its in-flight requests abort, later jobs start at the next prefix), while a success resets its streak.
 */
export class MirrorPolicy {
  constructor({ source = 'direct', proxyPrefix, proxyPrefixes, failureLimit = 3, timeoutMs = 8000, log = console.log } = {}) {
    this.source = validateSource(source);
    this.prefixes = this.source === 'mirror'
      ? normalizeProxyPrefixes(proxyPrefixes !== undefined ? proxyPrefixes : (proxyPrefix !== undefined ? proxyPrefix : undefined))
      : [];
    this.failureLimit = Math.max(1, Number(failureLimit) || 3);
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 8000);
    this.log = log;
    /** consecutive failures per prefix */
    this.failures = new Map();
    /** prefixes dropped for this run */
    this.disabledPrefixes = new Set();
    /** one AbortController per prefix (aborted when it is dropped) */
    this.abort = new Map();
    for (const p of this.prefixes) this.abort.set(p, new AbortController());
    this.hintShown = false;
  }

  /** True when every prefix is dropped (or there are none) — the mirror is off for this run. */
  get disabled() { return this.prefixes.every((p) => this.disabledPrefixes.has(p)); }

  /** The prefix a URL belongs to, or null (a direct / jsDelivr URL). */
  proxyOf(url) {
    if (this.source !== 'mirror') return null;
    for (const p of this.prefixes) if (url.startsWith(p)) return p;
    return null;
  }

  isProxy(url) { return this.proxyOf(url) !== null; }

  skip(url) { const p = this.proxyOf(url); return p !== null && this.disabledPrefixes.has(p); }

  urls(url) {
    const enabled = this.prefixes.filter((p) => !this.disabledPrefixes.has(p));
    return downloadUrls(url, { source: this.source, proxyPrefixes: enabled });
  }

  async request(url, fetchImpl, options = {}, timeoutMs = 120000) {
    const proxy = this.proxyOf(url);
    if (proxy === null) {
      return fetchImpl(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
    }
    const headerDeadline = new AbortController();
    const ctrl = this.abort.get(proxy);
    const signal = ctrl ? AbortSignal.any([headerDeadline.signal, ctrl.signal]) : headerDeadline.signal;
    const timer = setTimeout(() => headerDeadline.abort(new Error('GitHub mirror response headers timed out')), Math.min(timeoutMs, this.timeoutMs));
    try {
      return await fetchImpl(url, { ...options, signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async readBody(url, response) {
    const proxy = this.proxyOf(url);
    if (proxy === null) return Buffer.from(await response.arrayBuffer());
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await readChunk(reader, this.timeoutMs, this.abort.get(proxy)?.signal);
        if (done) break;
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        size += chunk.length;
      }
    } catch (error) {
      try { await reader.cancel(error); } catch { /* ignore */ }
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  }

  succeeded(url) {
    // A success from a request already in flight must not reopen a tripped circuit.
    const proxy = this.proxyOf(url);
    if (proxy !== null && !this.disabledPrefixes.has(proxy)) this.failures.set(proxy, 0);
  }

  failed(url) {
    const proxy = this.proxyOf(url);
    if (proxy === null || this.disabledPrefixes.has(proxy)) return;
    const n = (this.failures.get(proxy) || 0) + 1;
    this.failures.set(proxy, n);
    if (n < this.failureLimit) return;
    this.disabledPrefixes.add(proxy);
    const left = this.prefixes.filter((p) => !this.disabledPrefixes.has(p)).length;
    this.log(`[network] GitHub 镜像 ${proxy} 连续失败 ${n} 次：本次运行停用该镜像${left > 0 ? '，改用下一个镜像' : ''}（原始源 / jsDelivr 仍然可用）。`);
    try { this.abort.get(proxy)?.abort(new Error('GitHub mirror disabled for this run')); } catch { /* ignore */ }
  }

  directFailureHint() {
    if (this.source !== 'direct' || this.hintShown) return;
    this.hintShown = true;
    this.log('[network] GitHub 下载失败；如需使用第三方镜像，可重新运行并加 --asset-source=mirror（或 SP_ASSET_SOURCE=mirror）。');
  }
}

function readChunk(reader, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('GitHub mirror request aborted')); };
    if (signal?.aborted) return onAbort();
    timer = setTimeout(() => { cleanup(); reject(new Error(`GitHub mirror response body idle for ${timeoutMs} ms`)); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
