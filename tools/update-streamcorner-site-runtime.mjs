import { writeFile } from 'node:fs/promises';
import { openStreamCornerSiteCatalog } from './streamcorner-site-catalog.mjs';
import { createStreamCornerSiteSnapshot } from './streamcorner-site-snapshot.mjs';

const catalog = await openStreamCornerSiteCatalog();
try {
  if (catalog.usingCachedRuntime) throw Error('Refresh requires access to the current public site');
  const snapshot = await createStreamCornerSiteSnapshot(catalog.runtimeUrl);
  await writeFile(new URL('./assets/streamcorner-site-runtime.json', import.meta.url), JSON.stringify(snapshot) + '\n');
  console.log(JSON.stringify({ runtimePath: snapshot.runtimePath, assetCount: Object.keys(snapshot.assets).length }));
} finally { await catalog.close(); }
