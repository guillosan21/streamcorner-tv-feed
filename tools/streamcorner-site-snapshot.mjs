import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const SITE = 'https://streamcorner.st/';
const ASSET_PATH = /^\/assets\/[A-Za-z0-9_-]+\.js$/;
const digest = text => createHash('sha256').update(text).digest('hex');

export async function createStreamCornerSiteSnapshot(runtimeUrl, fetcher = fetch) {
  const runtime = new URL(runtimeUrl);
  if (runtime.origin !== new URL(SITE).origin || !ASSET_PATH.test(runtime.pathname) || runtime.search || runtime.hash)
    throw Error('Invalid public runtime URL');
  const assets = {};
  const queue = [runtime.pathname];
  let total = 0;
  while (queue.length) {
    const path = queue.shift();
    if (assets[path]) continue;
    if (!ASSET_PATH.test(path) || Object.keys(assets).length >= 20) throw Error('Public module graph is too large');
    const response = await fetcher(new URL(path, SITE), { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > 600_000) throw Error('Public module unavailable');
    const code = await response.text();
    total += code.length;
    if (code.length > 600_000 || total > 4_000_000) throw Error('Public module graph is too large');
    assets[path] = { code, sha256: digest(code) };
    for (const match of code.matchAll(/["'](?:\.\/)?([A-Za-z0-9_-]+\.js)["']/g)) queue.push('/assets/' + match[1]);
  }
  return { schema: 1, capturedAt: new Date().toISOString(), runtimePath: runtime.pathname, assets };
}

export function validateStreamCornerSiteSnapshot(snapshot) {
  if (snapshot?.schema !== 1 || !ASSET_PATH.test(snapshot.runtimePath) ||
      !snapshot.assets || !snapshot.assets[snapshot.runtimePath] ||
      Object.keys(snapshot.assets).length > 20) throw Error('Invalid public module snapshot');
  let total = 0;
  for (const [path, asset] of Object.entries(snapshot.assets)) {
    if (!ASSET_PATH.test(path) || typeof asset.code !== 'string' || asset.code.length > 600_000 ||
        digest(asset.code) !== asset.sha256) throw Error('Public module snapshot integrity failed');
    total += asset.code.length;
  }
  if (total > 4_000_000) throw Error('Public module snapshot is too large');
  return snapshot;
}

export async function loadStreamCornerSiteSnapshot() {
  const file = await readFile(new URL('./assets/streamcorner-site-runtime.json', import.meta.url), 'utf8');
  if (file.length > 5_000_000) throw Error('Public module snapshot is too large');
  return validateStreamCornerSiteSnapshot(JSON.parse(file));
}
