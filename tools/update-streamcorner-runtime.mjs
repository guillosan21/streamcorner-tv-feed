import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { discoverStreamCornerRuntime } from "./streamcorner.mjs";

const runtime = await discoverStreamCornerRuntime();
const output = {
  decoderUrl: runtime.decoderUrl,
  decoderSha256: createHash("sha256").update(runtime.decoderCode).digest("hex"),
  decoderExport: runtime.decoderExport,
  workers: runtime.workers,
  decoderCode: runtime.decoderCode,
};
await mkdir("tools/assets", { recursive: true });
await writeFile("tools/assets/streamcorner-runtime.json", `${JSON.stringify(output)}\n`, "utf8");
console.log(JSON.stringify({ decoderUrl: output.decoderUrl, decoderSha256: output.decoderSha256, workers: output.workers.length }));
