import { PORTS, ROUTER_PLANE_TARGET, TARGET, loopback } from "./paths.mjs";

// Only these local Node dependencies can make the service degraded. The list
// is closed so stale health payloads cannot resurrect a retired runtime row.
export const NODE_HEALTH_DEPENDENCIES = Object.freeze([
  "oauth",
  "api",
  "grokOauth",
  "devinCli",
]);
const NODE_HEALTH_DEPENDENCY_SET = new Set(NODE_HEALTH_DEPENDENCIES);

function currentNodeHealth(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const { gateway: _retiredGateway, ...current } = payload;
  return {
    ...current,
    degraded: Array.isArray(current.degraded)
      ? current.degraded.filter((name) => NODE_HEALTH_DEPENDENCY_SET.has(name))
      : [],
  };
}

// The name the router reports on `/health`. It identifies the *service*, which
// is one process shared by every client integration, so it is keyed on the
// router plane rather than on whichever client this command was invoked for.
// Keying it on the client made a second integration look like a foreign
// process squatting on the router port.
const SERVICE_BY_TARGET = {
  [ROUTER_PLANE_TARGET]: "codex-router",
};
// The health endpoint is shipped for the Codex service target only. Legacy
// external documents are removed through the explicit uninstall transaction and
// never create a second health namespace.
const SUPPORTED_TARGETS = new Set(["codex"]);

export async function waitForRouterHealth({
  target = TARGET,
  url = loopback(PORTS.router, "/health"),
  timeoutMs = 30_000,
  requestTimeoutMs = 4_000,
  intervalMs = 250,
  fetchImpl = fetch,
} = {}) {
  if (!SUPPORTED_TARGETS.has(target)) throw new Error(`Unknown router target: ${target}`);
  const expectedService = SERVICE_BY_TARGET[ROUTER_PLANE_TARGET];

  const deadline = Date.now() + Math.max(0, timeoutMs);
  let lastError = "service unavailable";
  // A router that answers but reports a current dependency down is a different
  // failure from a router that is not listening. Keep the last such payload so
  // the caller can say which of the two happened instead of "not ready".
  let lastPayload;
  do {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const body = await response.text();
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        lastError = "health response was not JSON";
      }
      const currentPayload = currentNodeHealth(payload);
      const currentDegraded = currentPayload.degraded;
      const retiredOnlyPayload =
        response.status === 503 &&
        payload.service === expectedService &&
        Array.isArray(payload.degraded) &&
        payload.degraded.length === 1 &&
        payload.degraded[0] === "gateway" &&
        Object.hasOwn(payload, "gateway") &&
        payload.gateway?.reachable === false;
      if (payload.service === expectedService && (response.ok || retiredOnlyPayload)) {
        return { ok: true, payload: currentPayload };
      }
      if (currentPayload.service && currentPayload.service !== expectedService) {
        lastError = `a different service (${currentPayload.service}) is listening on the router port`;
      } else if (currentPayload.service === expectedService) {
        lastPayload = currentPayload;
        const down = currentDegraded;
        lastError = down.length
          ? `it is listening but reports ${down.join(", ")} unreachable (HTTP ${response.status})`
          : `it is listening but answered HTTP ${response.status}`;
      } else if (response.status) {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remainingMs)));
  } while (Date.now() <= deadline);

  return { ok: false, error: lastError, degradedPayload: lastPayload };
}
