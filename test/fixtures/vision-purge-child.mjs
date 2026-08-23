import path from "node:path";

const [purgePath, nowText] = process.argv.slice(2);
if (!purgePath || !Number.isSafeInteger(Number(nowText))) {
  throw new Error("Usage: vision-purge-child.mjs PURGE_PATH NOW");
}

process.env.MODEL_ROUTER_STATE_DIR = path.dirname(purgePath);
process.env.MODEL_ROUTER_VISION_CACHE_PURGE = purgePath;
Date.now = () => Number(nowText);

const { requestVisionCachePurge } = await import("../../src/vision-bridge.mjs");
process.stdout.write(`${JSON.stringify(requestVisionCachePurge())}\n`);
