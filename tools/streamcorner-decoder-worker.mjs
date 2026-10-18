import { parentPort, workerData } from 'node:worker_threads';
import { decoderFor } from './streamcorner.mjs';

try {
  const value = await decoderFor(workerData.runtime, fetch)(...workerData.args);
  parentPort.postMessage({ ok: true, value });
} catch {
  // Never forward provider code, signed URLs, response bodies or raw exception messages.
  parentPort.postMessage({ ok: false });
}
