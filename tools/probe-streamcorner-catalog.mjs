import { openStreamCornerSiteCatalog } from './streamcorner-site-catalog.mjs';
let catalog;
try {
  catalog = await openStreamCornerSiteCatalog();
  const rows = await catalog.request('alpha');
  console.log(JSON.stringify({ available: true, catalogCount: Array.isArray(rows) ? rows.length : 0 }));
} catch (error) {
  // Errors from this collector contain only fixed phase labels and HTTP status.
  console.log(JSON.stringify({ available: false, diagnostic: String(error) }));
  process.exitCode = 1;
} finally { await catalog?.close(); }
