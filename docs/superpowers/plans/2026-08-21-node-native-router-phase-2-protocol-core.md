# Node-Native Router Phase 2 Protocol Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route supported third-party models directly through Node-native Responses or Anthropic Messages while preserving tools, reasoning, usage, errors, aborts, retry, and failover semantics.

**Architecture:** Build pure request/response adapters around the Phase 1 `ResolvedNodeModel`. The Router always rebuilds from the pristine caller payload, applies request-local tool mappings, dispatches the declared transport, normalizes reasoning for display, and only then relays bytes.

**Tech Stack:** Node.js 22.19+, native `fetch`, Web Streams/SSE, `node:crypto`, `node:test` fixture servers.

**Spec:** `docs/superpowers/specs/2026-08-21-node-native-macos-router-design.md`

## Global Constraints

- Implement Appendices A, C, D, and I exactly.
- `openai-responses` never falls back to Chat Completions.
- Native OpenAI traffic bypasses every third-party transform byte-for-byte.
- Retry/failover occurs only before the first relayed byte and only for Appendix D cases.
- Forced-tool validation allows exactly 8 MiB and 30 seconds; the first extra byte or millisecond fails.
- Provider bodies, prompts, reasoning, tool arguments, credentials, caller capabilities, and reasoning envelopes never enter public diagnostics.
- Before the first implementation push, run only unit/fixture tests; live provider, app, install, and runtime checks remain Phase 5 post-push work.

---

## File Structure

- `src/public-error.mjs`: Appendix I error objects, stream terminals, and status mapping.
- `src/sensitive-redactor.mjs`: one redaction boundary for every diagnostic surface.
- `src/tool-dialect.mjs`: deterministic declaration/call/history mapping and forced-choice validation.
- `src/reasoning-summary-compat.mjs`: Appendix A streaming and non-streaming state machine.
- `src/openai-responses-adapter.mjs`: direct Responses request/profile handling.
- `src/provider-endpoint.mjs`: append protocol leaves without discarding provider base paths.
- `src/reasoning-envelope.mjs`: JCS/HMAC provenance envelopes.
- `src/anthropic-messages-adapter.mjs`: GLM request/history/stream conversion.
- `src/provider-dispatch.mjs`: transport selection, pristine rebuild, retry, and failover orchestration.

### Task 1: Centralize public errors and redaction

**Files:**
- Create: `src/public-error.mjs`
- Create: `src/sensitive-redactor.mjs`
- Modify: `src/error-translation.mjs`
- Modify: `src/support-bundle.mjs`
- Create: `test/public-error-redaction.test.mjs`
- Test: `test/error-translation.test.mjs`

**Interfaces:**
- Produces: `routerError(code, details?) -> RouterPublicError`.
- Produces: `failedResponseEvent(context, error) -> ResponsesEvent`.
- Produces: `incompleteResponseEvent(context, reason) -> ResponsesEvent`.
- Produces: `redactSensitive(value, context?) -> string | object`.

- [ ] **Step 1: Write failing Appendix I shape tests**

```js
test("pre-stream errors expose only the safe envelope", () => {
  const error = routerError("tool_mapping_error", {providerBody: DECOY_BODY});
  assert.deepEqual(error.body, {
    error: {type: "router_error", code: "tool_mapping_error", message: "Invalid tool mapping.", param: null},
  });
  assert.doesNotMatch(JSON.stringify(error), new RegExp(DECOY_BODY));
});
```

Plant unique decoys in API keys, bearer headers, caller URLs, prompts, reasoning, arguments, response bodies, exception causes, logs, snapshots, temp files, and support bundles. Assert one terminal frame plus one `[DONE]` after relay and no `[DONE]` for non-stream JSON.

- [ ] **Step 2: Run unit tests and confirm RED**

```bash
node --test test/public-error-redaction.test.mjs test/error-translation.test.mjs
```

Expected: FAIL on missing modules and leaked fixture values.

- [ ] **Step 3: Implement the fixed code/status catalog and one redactor**

```js
export function routerError(code, privateDetails = {}) {
  const definition = ERROR_DEFINITIONS[code];
  if (!definition) throw new TypeError(`unknown public error code: ${code}`);
  return {status: definition.status, body: {error: {
    type: "router_error", code, message: definition.message, param: null,
  }}, privateDetails};
}
```

Allowlist provider status, code/type, request ID, and rate-limit headers; never copy raw provider messages.

- [ ] **Step 4: Run focused unit tests and confirm GREEN**

```bash
node --test test/public-error-redaction.test.mjs test/error-translation.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/public-error.mjs src/sensitive-redactor.mjs src/error-translation.mjs src/support-bundle.mjs test/public-error-redaction.test.mjs test/error-translation.test.mjs
git commit -m "feat: centralize router errors and redaction"
```

### Task 2: Implement deterministic tool dialect conversion

**Files:**
- Create: `src/tool-dialect.mjs`
- Modify: `src/namespace-relay.mjs`
- Create: `test/tool-dialect.test.mjs`
- Test: `test/namespace-relay.test.mjs`

**Interfaces:**
- Produces: `encodeToolDialect({tools, toolChoice, input, profile}) -> ToolBuild`.
- Produces: `restoreToolEvent(event, mapping) -> ResponsesEvent`.
- Produces: `validateForcedToolResult(buffer, build) -> void`.
- `ToolBuild` contains `tools`, `toolChoice`, `input`, `mapping`, `forcedRequirement`, and `strictValidators`.

- [ ] **Step 1: Write failing deterministic-name and round-trip tests**

```js
test("custom declarations round-trip through one required input string", () => {
  const build = encodeToolDialect({tools: [customTool], toolChoice: "required", input: [], profile: deepseek});
  assert.deepEqual(build.tools[0].parameters.required, ["input"]);
  assert.deepEqual(restoreToolEvent(mappedCall(build), build.mapping), originalCustomCall);
});
```

Cover the exact `cr_<40-byte-prefix>_<16-base32-hash>` algorithm, valid native-name preservation, collision rejection, unknown returned names, duplicate/foreign call IDs, continuation lowering, custom argument errors, schema normalization, `auto`, `none`, `required`, named choice, and GLM pass-through.

- [ ] **Step 2: Run unit tests and confirm RED**

```bash
node --test test/tool-dialect.test.mjs test/namespace-relay.test.mjs
```

- [ ] **Step 3: Implement request-local mappings from pristine declarations**

```js
export function encodedToolName(kind, original) {
  const prefix = sanitize(original).slice(0, 40);
  const hash = base32(sha256(`${kind}\0${original}`)).slice(0, 16);
  return `cr_${prefix}_${hash}`;
}
```

Never infer mappings from returned names. Preserve original call IDs and reject non-exact `{input: string}` custom arguments.

- [ ] **Step 4: Add exact forced-buffer boundary tests**

Use an injected byte counter and clock for exactly 8 MiB, +1 byte, exactly 30 seconds, +1 ms, authoritative usage before abort, and caller abort. Assert one abort, zero relayed bytes, zero retries, and zero failovers.

- [ ] **Step 5: Run unit tests and confirm GREEN**

```bash
node --test test/tool-dialect.test.mjs test/namespace-relay.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/tool-dialect.mjs src/namespace-relay.mjs test/tool-dialect.test.mjs test/namespace-relay.test.mjs
git commit -m "feat: add responses tool dialect adapter"
```

### Task 3: Implement summary-compat reasoning state machine

**Files:**
- Create: `src/reasoning-summary-compat.mjs`
- Create: `test/reasoning-summary-compat.test.mjs`
- Create: `test/fixtures/reasoning-events/*.json`

**Interfaces:**
- Produces: `selectedFinalParts(sourceKind, finalItem) -> string[]`.
- Produces: `createReasoningCompatTransform({responseId, model, finalShape}) -> TransformStream`.
- Produces: `createRawPreserveTransform() -> TransformStream` and `normalizeRawReasoningResponse(json) -> object`.
- Produces: `normalizeReasoningResponse(json, model) -> object`.

- [ ] **Step 1: Check in fixtures for every Appendix A legal row and error code**

Include multiple interleaved items/parts, generated Anthropic IDs, final-only items, strict suffix, non-prefix mismatch, incomplete, failed, truncation, duplicate terminal, post-terminal events, and every listed internal reason.

- [ ] **Step 2: Write failing stream/final consistency tests**

```js
test("strict final suffix is emitted before one delayed text-done", async () => {
  const events = await transformFixture("strict-final-suffix");
  assert.deepEqual(types(events), ["response.output_item.added", "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta", "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done", "response.reasoning_summary_part.done",
    "response.output_item.done", "response.completed"]);
});
```

Assert unknown valid non-reasoning SSE bytes are unchanged and native OpenAI never attaches to this transform. Add `raw-preserve` fixtures proving reasoning events, final raw content, unknown events, item IDs, usage, and non-streaming JSON remain byte-/value-identical without summary synthesis.

- [ ] **Step 3: Run unit tests and confirm RED**

```bash
node --test test/reasoning-summary-compat.test.mjs
```

- [ ] **Step 4: Implement per-item and per-summary-index state**

```js
const items = new Map();
function stateFor(itemId) {
  const item = items.get(itemId);
  if (!item) throw reasoningProtocol("reasoning_delta_without_item");
  return item;
}
```

Delay downstream text-done until item/terminal final selection. Use `selectedFinalParts()` for streaming item-done, final-only streaming items, and non-stream JSON. Keep downstream raw `content` empty in summary mode. Export an explicit raw-preserve pass-through and make dispatch select it only when `reasoningDisplayMode === "raw-preserve"`; unknown modes fail through the Phase 1 registry contract.

- [ ] **Step 5: Run unit tests and confirm GREEN**

```bash
node --test test/reasoning-summary-compat.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/reasoning-summary-compat.mjs test/reasoning-summary-compat.test.mjs test/fixtures/reasoning-events
git commit -m "feat: normalize third-party reasoning summaries"
```

### Task 4: Implement direct OpenAI Responses provider profiles

**Files:**
- Create: `src/openai-responses-adapter.mjs`
- Create: `src/provider-endpoint.mjs`
- Modify: `src/api-forwarder.mjs`
- Create: `test/node-provider-adapter.test.mjs`
- Test: `test/response-usage.test.mjs`

**Interfaces:**
- Consumes: `ResolvedNodeModel`, `ToolBuild`, and reasoning normalizer.
- Produces: `buildOpenAIResponsesRequest({model, payload, credential}) -> ProviderRequest`.
- Produces: `adaptOpenAIResponses({model, upstream, requestContext}) -> ProviderResponse`.
- Produces: `providerEndpoint(baseUrl, leaf) -> URL`.

- [ ] **Step 1: Write failing DeepSeek/Qwen profile tests**

Assert complete endpoint URLs from checked-in provider fixtures, including Qwen Plan's current `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/responses`; cover base URLs with/without trailing slash and a Beijing environment override `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`. Also assert `store: false` for Qwen, nested reasoning preservation, no chat-only thinking fields, forced-choice downgrade, strict removal only where specified, authoritative cache usage, raw/hybrid final shape selection, abort propagation, malformed stream failure, and no `/chat/completions` request under any failure.

- [ ] **Step 2: Run unit tests and confirm RED**

```bash
node --test test/node-provider-adapter.test.mjs test/response-usage.test.mjs
```

- [ ] **Step 3: Implement pure request profiles and response composition**

```js
export function buildOpenAIResponsesRequest({model, payload, credential}) {
  if (model.effectiveTransport !== "openai-responses") throw new TypeError("transport mismatch");
  const toolBuild = encodeToolDialect({...payload, profile: model.requestProfile});
  return {url: providerEndpoint(model.baseUrl, "responses"), headers: providerHeaders(model, credential),
    body: encodeJson(applyResponsesProfile(model, payload, toolBuild)), toolBuild};
}
```

- [ ] **Step 4: Run unit tests and confirm GREEN**

```bash
node --test test/node-provider-adapter.test.mjs test/response-usage.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/provider-endpoint.mjs src/openai-responses-adapter.mjs src/api-forwarder.mjs test/node-provider-adapter.test.mjs test/response-usage.test.mjs
git commit -m "feat: route providers through native responses"
```

### Task 5: Implement GLM Anthropic Messages and provenance envelopes

**Files:**
- Create: `src/jcs.mjs`
- Create: `src/reasoning-envelope.mjs`
- Create: `src/anthropic-messages-adapter.mjs`
- Create: `test/reasoning-envelope.test.mjs`
- Create: `test/anthropic-messages-adapter.test.mjs`
- Create: `test/fixtures/reasoning-envelope-v1.json`

**Interfaces:**
- Produces: `sealReasoningEnvelope(payload, internalKey) -> string`.
- Produces: `verifyReasoningEnvelope(value, expected, internalKey) -> EnvelopeVerdict`.
- Produces: `buildAnthropicMessagesRequest({model, payload, credential, internalKey}) -> ProviderRequest`.
- Produces: `adaptAnthropicMessages({model, upstream, requestContext}) -> ProviderResponse`.

- [ ] **Step 1: Write failing JCS/HMAC golden-vector tests**

Cover reordered keys, control characters, non-ASCII, combining Unicode without normalization, numeric version, unpadded base64url, cross-release verification, and one-bit tampering.

- [ ] **Step 2: Write failing GLM request/history/stream tests**

Cover instructions, text, images, assistant text, one/multiple tools, continuation, parallel settings, every tool choice, all reasoning efforts and exact budgets, every output-limit boundary, thinking signatures, valid/foreign/unknown provenance, usage/cache, max-token incomplete, 4xx/5xx, malformed JSON delta, abort, truncation, unknown block, and duplicate terminal. Reuse `providerEndpoint()` and assert canonical GLM resolves the checked-in Qwen base to the complete `/compatible-mode/v1/messages` URL, including trailing-slash and Beijing environment override cases.

- [ ] **Step 3: Run unit tests and confirm RED**

```bash
node --test test/reasoning-envelope.test.mjs test/anthropic-messages-adapter.test.mjs
```

- [ ] **Step 4: Implement canonical envelopes and fail-closed continuation**

```js
const DOMAIN = Buffer.from("codex-router.reasoning-envelope.v1\0", "ascii");
export function sealReasoningEnvelope(payload, key) {
  const bytes = jcsBytes(payload);
  const mac = createHmac("sha256", key).update(DOMAIN).update(bytes).digest("base64url");
  return `cr.reasoning.v1.${bytes.toString("base64url")}.${mac}`;
}
```

Reconstruct GLM thinking only after HMAC, version, route provenance, item ID, and exact summary-parts hash all verify. Build the Messages URL only through `providerEndpoint(model.baseUrl, "messages")`.

- [ ] **Step 5: Implement exact Messages mapping**

Use the effort budgets `1024/2048/4096/8192/16384/32768`, default output cap `131072`, minimum `budget + 1024`, object-valued `tool_use.input`, and one terminal event.

- [ ] **Step 6: Run unit tests and confirm GREEN**

```bash
node --test test/reasoning-envelope.test.mjs test/anthropic-messages-adapter.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add src/jcs.mjs src/reasoning-envelope.mjs src/anthropic-messages-adapter.mjs test/reasoning-envelope.test.mjs test/anthropic-messages-adapter.test.mjs test/fixtures/reasoning-envelope-v1.json
git commit -m "feat: add glm messages adapter"
```

### Task 6: Integrate direct dispatch, retry, failover, and proof probes

**Files:**
- Create: `src/provider-dispatch.mjs`
- Modify: `src/router.mjs`
- Modify: `src/upstream-retry.mjs`
- Modify: `src/model-failover.mjs`
- Modify: `src/protocol-proof-verifier.mjs`
- Test: `test/native-retry.test.mjs`
- Test: `test/model-failover.test.mjs`
- Test: `test/model-failover-router.test.mjs`
- Test: `test/protocol-proof-verifier.test.mjs`
- Test: `test/routing.test.mjs`

**Interfaces:**
- Produces: `buildRoutedRequest(pristinePayload, model, context) -> BuiltRoutedRequest`.
- Produces: `dispatchRoutedRequest(built, response) -> Promise<DispatchResult>`.
- Supplies: `dispatchProtocolProbe()` to the Phase 1 verifier.

- [ ] **Step 1: Write failing whole-path fixture tests**

Assert stable slugs use the declared direct transport, `summary-compat` selects the state machine, `raw-preserve` selects the byte-preserving branch, native requests are unchanged, legacy slugs return `provider_not_available_in_node_build`, canaries enforce proof, compaction uses the same selector, all rebuilds start from pristine input, and Responses-only markers exclude incompatible failover candidates.

- [ ] **Step 2: Add Appendix D retry/failover matrix tests**

Cover connect/DNS/socket and `502/503/504/520-524` retry only; `429 Retry-After > 60`, `402`, and `out_of_usage` failover only; all forbidden statuses; 250/750ms backoff; five-second retry budget; two-hop/30-second failover; six-hour provider-declared cooldown cap; same-family, native, Chat, transport, dialect, marker, proof, and context exclusions.

- [ ] **Step 3: Run unit tests and confirm RED**

```bash
node --test test/native-retry.test.mjs test/model-failover.test.mjs test/model-failover-router.test.mjs test/protocol-proof-verifier.test.mjs test/routing.test.mjs
```

- [ ] **Step 4: Implement transport dispatch before any response write**

```js
export function buildRoutedRequest(pristinePayload, model, context) {
  const payload = structuredClone(pristinePayload);
  return model.effectiveTransport === "anthropic-messages"
    ? buildAnthropicMessagesRequest({model, payload, ...context})
    : buildOpenAIResponsesRequest({model, payload, ...context});
}
```

Keep retries and failover entirely before `pipeResponse`; use the same builder for each attempt and proof probe with retry/failover disabled.

- [ ] **Step 5: Run unit tests and confirm GREEN**

```bash
node --test test/native-retry.test.mjs test/model-failover.test.mjs test/model-failover-router.test.mjs test/protocol-proof-verifier.test.mjs test/routing.test.mjs
```

- [ ] **Step 6: Run the Phase 2 unit gate**

```bash
node --test test/public-error-redaction.test.mjs test/tool-dialect.test.mjs test/reasoning-summary-compat.test.mjs test/node-provider-adapter.test.mjs test/reasoning-envelope.test.mjs test/anthropic-messages-adapter.test.mjs test/model-failover-router.test.mjs test/routing.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add src/provider-dispatch.mjs src/router.mjs src/upstream-retry.mjs src/model-failover.mjs src/protocol-proof-verifier.mjs test/native-retry.test.mjs test/model-failover.test.mjs test/model-failover-router.test.mjs test/protocol-proof-verifier.test.mjs test/routing.test.mjs
git commit -m "feat: dispatch node-native provider routes"
```

## Phase Verification

- [ ] Before push, run only the Phase 2 `node --test` unit/fixture commands named above.
- [ ] Commit and push reviewed Phase 2 implementation.
- [ ] After push, defer live provider probes, real Codex routing, app/runtime checks, and visual checks to Phase 5.
- [ ] Any post-push validation fix must receive a unit regression, review, a new commit, and another push.
