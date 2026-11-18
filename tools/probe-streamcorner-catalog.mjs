import { openStreamCornerPublicChannels } from './streamcorner-site-catalog.mjs';
let catalog;
try {
  catalog = await openStreamCornerPublicChannels();
  console.log(JSON.stringify({ available: true, catalogCount: catalog.channels.length }));
} catch (error) {
  // Errors from this collector contain only fixed phase labels and HTTP status.
  console.log(JSON.stringify({ available: false, diagnostic: String(error) }));
  process.exitCode = 1;
} finally { await catalog?.close(); }
