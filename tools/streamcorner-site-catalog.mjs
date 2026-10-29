const SITE = 'https://streamcorner.st/';
const MAX_RESPONSE_BYTES = 4_000_000;
import { loadStreamCornerSiteSnapshot, validateStreamCornerSiteSnapshot } from './streamcorner-site-snapshot.mjs';

export function streamCornerCatalogRequestAllowed(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.origin === new URL(SITE).origin ||
        (/^data\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) && url.pathname === '/corner'));
  } catch { return false; }
}

export async function routeStreamCornerCatalogRequest(route) {
  const request = route.request();
  if (!streamCornerCatalogRequestAllowed(request.url()) ||
      !['GET', 'POST'].includes(request.method()) ||
      ['image', 'media', 'font'].includes(request.resourceType())) return route.abort();
  try {
    // Browser route handlers are not re-run for redirects. Fetch one hop only.
    const response = await route.fetch({ maxRedirects: 0, timeout: 10_000 });
    if (response.status() >= 300 && response.status() < 400) return route.abort();
    return await route.fulfill({ response });
  } catch { return route.abort().catch(() => {}); }
}

async function closeCatalogBrowser(browser, server) {
  let timer;
  try {
    await Promise.race([
      (async () => { await browser?.close(); await server.close(); })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('close timeout')), 5000); }),
    ]);
  } catch {
    let killTimer;
    try {
      await Promise.race([server.kill(), new Promise((_, reject) => {
        killTimer = setTimeout(() => reject(Error('kill timeout')), 3000);
      })]);
    } catch { try { server.process()?.kill('SIGKILL'); } catch { /* Already exited. */ } }
    finally { clearTimeout(killTimer); }
  } finally { clearTimeout(timer); }
}

/** Run the current public site's module/worker runtime, rather than emulate its
 * obsolete standalone decoder. This collects catalog metadata only, never players,
 * license requests or media. No browser state is persisted between refreshes. */
export async function openStreamCornerSiteCatalog({ chromium, lifetimeMs = 180_000, snapshot: initialSnapshot } = {}) {
  chromium ??= (await import('playwright')).chromium;
  const deadline = Date.now() + lifetimeMs;
  const remaining = () => {
    const ms = Math.min(15_000, deadline - Date.now());
    if (ms <= 0) throw new Error('StreamCorner catalog deadline exceeded');
    return ms;
  };
  let snapshot = initialSnapshot ? validateStreamCornerSiteSnapshot(initialSnapshot) : null;
  const server = await chromium.launchServer({ headless: true, timeout: remaining() });
  let browser;
  let closePromise;
  const close = () => closePromise ??= closeCatalogBrowser(browser, server);
  let phase = 'connect';
  let status = 0;
  try {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: remaining() });
    phase = 'context';
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await context.route('**/*', async route => {
      if (!snapshot) return routeStreamCornerCatalogRequest(route);
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'GET' && request.url() === SITE && request.resourceType() === 'document')
        return route.fulfill({ status: 200, contentType: 'text/html',
          body: '<!doctype html><title>Public catalog runtime</title>' });
      const asset = url.origin === new URL(SITE).origin && !url.search && !url.hash ? snapshot.assets[url.pathname] : null;
      if (request.method() === 'GET' && asset)
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: asset.code });
      // Only current catalog API traffic leaves the cached module context.
      if (url.origin === new URL(SITE).origin) return route.abort();
      return routeStreamCornerCatalogRequest(route);
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    // The first page is the sole metadata context. It never opens source embeds.
    const page = await context.newPage();
    context.on('page', extra => { if (extra !== page) void extra.close(); });
    page.setDefaultTimeout(remaining());
    phase = 'document';
    let response = await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: remaining() });
    status = response?.status() || 0;
    if (!snapshot && status === 403) {
      // Cache code, not games or sources. Do not alter TLS, solve challenges or
      // emulate the obsolete decoder: execute the verified public module graph.
      snapshot = await loadStreamCornerSiteSnapshot();
      response = await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: remaining() });
    }
    if (!response?.ok() || page.url() !== SITE) throw new Error('StreamCorner catalog page unavailable');
    phase = 'runtime';
    let initializationTimer;
    const runtimeUrl = snapshot ? new URL(snapshot.runtimePath, SITE).href : await Promise.race([page.evaluate(async () => {
      const read = async url => {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
        if (!response.ok || Number(response.headers.get('content-length')) > 600_000) throw Error('asset unavailable');
        const text = await response.text();
        if (text.length > 600_000) throw Error('asset too large');
        return text;
      };
      const validAsset = value => {
        const url = new URL(value, location.href);
        if (url.origin !== location.origin || !/^\/assets\/[A-Za-z0-9_-]+\.js$/.test(url.pathname) || url.search || url.hash)
          throw Error('asset left provider origin');
        return url.href;
      };
      const entry = [...document.scripts].find(s => s.type === 'module' && s.src)?.src;
      if (!entry) throw Error('entry unavailable');
      const entryUrl = validAsset(entry);
      const code = await read(entryUrl);
      const imports = [...new Set([...code.matchAll(/from["']\.\/([^"']+\.js)["']/g)].map(m => m[1]))];
      for (const name of imports.slice(0, 12)) {
        const url = validAsset(new URL(name, entryUrl).href);
        const text = await read(url);
        if (!/data\.[a-z0-9-]+\.workers\.dev/.test(text)) continue;
        const module = await import(url);
        if (typeof module.u !== 'function' || typeof module.e !== 'function') throw Error('catalog interface changed');
        return url;
      }
      throw Error('catalog runtime unavailable');
    }), new Promise((_, reject) => {
      initializationTimer = setTimeout(() => reject(Error('catalog initialization timed out')), 30_000);
    })]).finally(() => clearTimeout(initializationTimer));
    return {
      runtimeUrl,
      usingCachedRuntime: Boolean(snapshot),
      async request(provider, id = '') {
        if (!/^(?:admin|nba|nfl|alpha|beta|001|003|channels)$/.test(provider) ||
            typeof id !== 'string' || id.length > 200 || /[\u0000-\u001f]/.test(id)) throw Error('invalid catalog request');
        const timeoutMs = remaining();
        // Race on both sides: a stuck module request must not hold the publisher open.
        let timer;
        try {
          return await Promise.race([
            page.evaluate(async ({ runtimeUrl, provider, id, timeoutMs, maxBytes }) => {
              let timer;
              try {
                return await Promise.race([
                  (async () => {
                    const module = await import(runtimeUrl);
                    const result = await (id ? module.e(provider, id) : module.u(provider));
                    const encoded = JSON.stringify(result);
                    if (!encoded || encoded.length > maxBytes) throw Error('catalog response too large');
                    return JSON.parse(encoded);
                  })(),
                  new Promise((_, reject) => { timer = setTimeout(() => reject(Error('catalog timeout')), timeoutMs); }),
                ]);
              } finally { clearTimeout(timer); }
            }, { runtimeUrl, provider, id, timeoutMs, maxBytes: MAX_RESPONSE_BYTES }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error('StreamCorner catalog request timed out')), timeoutMs + 1000); }),
          ]);
        } catch { throw Error('StreamCorner catalog request failed'); }
        finally { clearTimeout(timer); }
      },
      close,
    };
  } catch {
    await close();
    throw new Error(`StreamCorner public site catalog unavailable (phase=${phase}; status=${status})`);
  }
}
