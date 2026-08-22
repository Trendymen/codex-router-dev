export const FORCED_DISPATCH_TIMEOUT_MS = 30_000;

export function createForcedDispatchDeadline({ signal, onTimeout, timers = globalThis, timeoutMs = FORCED_DISPATCH_TIMEOUT_MS } = {}) {
  if (!signal || typeof onTimeout !== "function" || typeof timers.setTimeout !== "function" || typeof timers.clearTimeout !== "function") throw new TypeError("invalid forced dispatch deadline");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError("invalid forced dispatch timeout");
  let fired = false;
  const handle = timers.setTimeout(() => {
    if (fired || signal.aborted) return;
    fired = true;
    onTimeout("forced_tool_buffer_timeout");
  }, timeoutMs + 1);
  handle?.unref?.();
  return Object.freeze({ clear() { timers.clearTimeout(handle); }, get fired() { return fired; } });
}
