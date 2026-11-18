const SITE = 'https://streamcorner.st/';
export const STREAMCORNER_PUBLIC_SITE = 'https://strmcrnr.st/';
const MAX_RESPONSE_BYTES = 4_000_000;
import { loadStreamCornerSiteSnapshot, validateStreamCornerSiteSnapshot } from './streamcorner-site-snapshot.mjs';

export function streamCornerCatalogRequestAllowed(value, site = SITE) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.origin === new URL(site).origin ||
        (/^data\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) && url.pathname === '/corner'));
  } catch { return false; }
}

export async function routeStreamCornerCatalogRequest(route, site = SITE) {
  const request = route.request();
  if (!streamCornerCatalogRequestAllowed(request.url(), site) ||
      !['GET', 'POST'].includes(request.method()) ||
      ['image', 'media', 'font'].includes(request.resourceType())) return route.abort();
  try {
    // Browser route handlers are not re-run for redirects. Fetch one hop only.
    const response = await route.fetch({ maxRedirects: 0, timeout: 10_000 });
    if (response.status() >= 300 && response.status() < 400) return route.abort();
    return await route.fulfill({ response });
  } catch { return route.abort().catch(() => {}); }
}

const CHANNEL_PATH = /^\/stream\/channels\/([A-Za-z0-9_-]{1,128})$/;

/** Derive a channel only from the public card's exact link and visible title. */
export function streamCornerPublicChannel(path, title) {
  const route = CHANNEL_PATH.exec(path);
  if (!route || typeof title !== 'string' || !title.trim() || title.length > 180) return null;
  return { provider: 'channels', id: route[1], row: { title: title.trim() } };
}

/** Strip only the website's observed Bitmovin selection suffix. */
export function streamCornerPublicChannelPlayer(value) {
  if (typeof value !== 'string' || value.length > 1100) return null;
  const match = /^https:\/\/amazon\.com\.pandecocogaming\.sbs\/\?p=[A-Za-z0-9_-]{32,1024}={0,2}(?=&player=bitmovin$|$)/.exec(value);
  return match && (value === match[0] || value === match[0] + '&player=bitmovin') ? match[0] : null;
}

/** Collect rendered sports channel cards and their exact source buttons. The
 * browser may load catalog documents and data only; embedded players never run. */
export async function openStreamCornerPublicChannels({ chromium } = {}) {
  chromium ??= (await import('playwright')).chromium;
  const server = await chromium.launchServer({ headless: true, timeout: 12_000 });
  let browser, closePromise;
  const close = () => {
    clearTimeout(deadline);
    return closePromise ??= closeCatalogBrowser(browser, server);
  };
  const deadline = setTimeout(() => { void close(); }, 50_000);
  const site = STREAMCORNER_PUBLIC_SITE;
  try {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 12_000 });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    // Per-page routes take priority. Popups are denied even before their page
    // object becomes available to close.
    await context.route('**/*', route => route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const visit = async (page, path) => {
      const url = new URL(path, site).href;
      page.on('popup', popup => { void popup.close().catch(() => {}); });
      await page.route('**/*', route => {
        const request = route.request();
        const destination = new URL(request.url());
        const allowed = request.resourceType() === 'document'
          ? request.url() === url && request.frame() === page.mainFrame() && request.method() === 'GET'
          : destination.origin !== new URL(site).origin ||
            (request.method() === 'GET' && !destination.search &&
              /^\/assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(destination.pathname));
        return allowed ? routeStreamCornerCatalogRequest(route, site) : route.abort();
      });
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8_000 });
      if (!response?.ok() || page.url() !== url) throw Error('StreamCorner public page unavailable');
    };
    const index = await context.newPage();
    let channels;
    try {
      await visit(index, '/channels');
      const cards = index.locator('a[href^="/stream/channels/"]');
      await cards.first().waitFor({ timeout: 8_000 });
      channels = (await cards.evaluateAll(links => links.slice(0, 128).map(link => [
        link.getAttribute('href'), link.querySelector('h2')?.textContent,
      ]))).map(([path, title]) => streamCornerPublicChannel(path, title)).filter(Boolean);
    } finally { await index.close(); }

    return {
      channels,
      async sources(id) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw Error('Invalid StreamCorner channel ID');
        const page = await context.newPage();
        try {
          await visit(page, `/stream/channels/${id}`);
          const buttons = page.locator('fieldset').filter({ has: page.getByText('AVAILABLE SOURCES', { exact: true }) })
            .locator('button.stream-source-btn[aria-pressed]');
          await buttons.first().waitFor({ timeout: 6_000 });
          const sources = [];
          const count = Math.min(await buttons.count(), 4);
          for (let i = 0; i < count; i++) {
            const button = buttons.nth(i);
            const title = (await button.locator('span.truncate').first().textContent({ timeout: 2_000 }))?.trim();
            const frameSelector = 'iframe[src^="https://amazon.com.pandecocogaming.sbs/?p="]';
            const previous = await page.locator(frameSelector).evaluateAll(items => items.map(item => item.getAttribute('src')));
            const alreadySelected = await button.getAttribute('aria-pressed') === 'true';
            if (!alreadySelected) await button.click({ timeout: 2_000 });
            // A site-owned iframe is unrelated to the selected capture. The one valid
            // player address still has to pass the app's native source validator.
            const captured = await page.waitForFunction(({ index, selector, previous }) => {
              const active = document.querySelectorAll('fieldset button.stream-source-btn[aria-pressed]')[index];
              const frames = document.querySelectorAll(selector);
              const src = frames.length === 1 ? frames[0].getAttribute('src') : null;
              return active?.getAttribute('aria-pressed') === 'true' && src && !previous.includes(src) ? src : null;
            }, { index: i, selector: frameSelector, previous: alreadySelected ? [] : previous },
            { timeout: 1_200 }).catch(() => null);
            // Avoid binding a late iframe from this click to a later source.
            if (!captured) break;
            const raw = await captured?.jsonValue();
            await captured?.dispose();
            const embed = streamCornerPublicChannelPlayer(raw);
            if (page.url() !== new URL(`/stream/channels/${id}`, site).href) {
              throw Error('StreamCorner channel changed during discovery');
            }
            if (embed) sources.push({ embed_url: embed, source_name: title });
          }
          return sources;
        } finally { await page.close(); }
      },
      close,
    };
  } catch {
    await close();
    throw Error('StreamCorner public channel catalog unavailable');
  }
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
