# Node-Native macOS Codex Router Design

- **Status**: Accepted for specification review
- **Date**: 2026-08-21
- **Target**: Codex CLI and Codex Desktop on macOS
- **Control plane**: CC Switch owns Codex configuration; the Router owns its runtime and catalogs

## 1. Decision Summary

This fork becomes a macOS-only, Node-native Codex router with two complete UI
surfaces: the existing Swift menu-bar application and the existing browser
panel. Python/LiteLLM and Rust/Tauri are removed from the runtime, installer,
health model, packaging, and visible UI.

The supported model/provider surface is intentionally narrow:

- native OpenAI/ChatGPT subscription traffic
- DeepSeek official
- Qwen Plan/Bailian Qwen models
- Qwen Plan/Bailian resold DeepSeek models
- GLM-5.2

Other provider credentials and state are preserved on disk but are not
advertised or routable in this fork. Requests for a legacy slug fail closed
with `provider_not_available_in_node_build`; they never start Python or select
another provider.

Third-party reasoning is emitted to Codex using a complete
`summary-compat` Responses lifecycle by default. A hidden `raw-preserve` mode
exists for protocol diagnosis. The compatibility mode does not claim that the
provider generated a concise summary: it places the provider's complete
visible thinking text into Codex's stable summary display channel.

## 2. Evidence and Problem Statement

### 2.1 LiteLLM conversion is observably lossy

Live probes through the installed router returned
`response.reasoning_summary_text.delta` events without first creating a
reasoning output item. Codex recorded reasoning-token usage but had no valid
item envelope to display.

Direct upstream Responses probes produced the expected item lifecycle:

1. `response.output_item.added` for a reasoning item
2. reasoning deltas and a done event
3. `response.output_item.done` for reasoning
4. a message or function-call item
5. a terminal `response.completed`

DeepSeek official, Qwen3.8 Max, Bailian resold DeepSeek, and GLM-5.2 all
returned usable reasoning and tool-call data through at least one native
protocol. DeepSeek and Qwen function calls worked under `tool_choice: auto`;
the measured forced/strict combination returned HTTP 400 and requires a
request-profile downgrade. GLM accepted the forced/strict probe.

### 2.2 Provider reasoning wire shapes differ

| Provider/protocol | Streaming source | Final reasoning shape |
| --- | --- | --- |
| OpenAI native | reasoning summary deltas | concise `summary[]` |
| DeepSeek official Responses | raw reasoning deltas | `content[]`, empty summary |
| Bailian Qwen/resold DeepSeek Responses | raw reasoning deltas | complete text in `summary[]` |
| Chat Completions | `message.reasoning_content` | adapter-defined |
| Anthropic Messages | `thinking` blocks | adapter-defined |

Codex Desktop/TUI is stable on the summary event path. Native raw reasoning
items can cause visible item shrink/re-expand behavior at tool boundaries, and
disabling raw display does not prevent the frontend from receiving the raw
item lifecycle. Summary compatibility is therefore the product default.

### 2.3 Catalog generation is not stable under CC Switch

The existing `merged-models.json` includes routed models only when the live
Codex config points at the router during generation. CC Switch changes the
live config without notifying the router, so a previously native-only catalog
can remain stale after switching to the aggregate profile.

Older Codex CLI builds also require fields that newer builds treat as
optional. A generated catalog that omitted `supports_parallel_tool_calls`
failed on Codex 0.147 while Codex Desktop 0.149 accepted it.

### 2.4 Heavy dependencies do not serve the chosen scope

Python exists primarily for LiteLLM. Rust exists primarily for the
Windows/Linux Tauri companion. The chosen providers can be served by focused
Node adapters, and macOS already uses a separate Swift tray.

## 3. Goals

1. Route selected models through Node-native OpenAI Responses or Anthropic
   Messages adapters without a LiteLLM hop.
2. Preserve Responses text, tools, item IDs, usage, unknown events, aborts,
   and errors except for explicit, tested compatibility transforms.
3. Emit a complete, internally consistent summary lifecycle for third-party
   visible reasoning.
4. Keep OpenAI native summary events byte-identical.
5. Keep Codex standalone web search on the Codex-owned `/alpha/search` path.
6. Publish a deterministic routed catalog for CC Switch aggregate profiles.
7. Provide complete, safe write operations in both Swift and browser UIs.
8. Remove Python/LiteLLM and Rust/Tauri without leaving broken controls,
   installers, health checks, or hidden runtime branches.
9. Preserve user credentials, history, retained tool results, and unrelated
   Codex/CC Switch settings.

## 4. Non-Goals

- Volcengine Agent Plan or Coding Plan
- Supporting every provider shipped by upstream codex-router
- Windows or Linux desktop/runtime support
- Provider-prefix-free canonical model IDs
- Custom picker display-name overlays
- Generating actual concise summaries with a second model call
- A router-owned web-search engine or tool loop
- Local models as Codex chat providers
- Writing or migrating the CC Switch database
- Replacing the current managed installation before explicit deployment approval

## 5. Runtime Architecture

No new service or port is introduced.

```text
Codex /responses
  -> Router caller authentication and native/routed classification
  -> model resolver
  -> transport selector
       openai-responses   -> Node API Forwarder -> provider /responses
       anthropic-messages -> Node Messages adapter -> provider /messages
       native-openai      -> existing ChatGPT native path
  -> tool-dialect transform
  -> reasoning display normalizer
  -> Codex Responses SSE
```

The runtime contains only:

- Node Router
- Node API Forwarder and protocol adapters
- Swift macOS tray
- browser panel served by the Router

The same transport selector is used for normal turns, compaction, retries, and
cross-model failover. Request rebuilding always starts from the pristine
caller payload.

### 5.1 Model transport metadata

Each routable model resolves:

```text
effectiveTransport:
  native-openai
  openai-responses
  anthropic-messages

toolDialect:
  responses-native
  responses-functions

reasoningDisplayMode:
  summary-compat
  raw-preserve

declaredFinalReasoningShape:
  provider-summary
  raw-content
  hybrid-summary
  anthropic-thinking
  unverified

rolloutState:
  stable
  experimental

purpose:
  primary
  compatibility
```

Unknown values are registry errors at startup. Transport and tool dialect are
independent: an upstream can speak Responses without accepting Codex custom or
namespace tool declarations. `unverified` is legal only with experimental
rollout state. Stable models use the declared shape directly. Experimental
models resolve `effectiveFinalReasoningShape` from a valid exact-slug protocol
proof; unresolved effective shape cannot generate a route.

### 5.2 Strict transport semantics

Models marked `openai-responses` never fall back to Chat Completions. A 4xx,
5xx, malformed stream, or unsupported feature is reported under the original
transport. Retrying is legal only before the first relayed byte and only under
the existing bounded transient-failure policy.

Cross-model failover can select only a candidate with a compatible transport
and tool dialect. Requests containing Responses-only input/tool markers exclude
incompatible candidates. If none remain, the original safe provider error is
returned. Appendix D is the normative retry/failover decision table; no other
status or error may trigger either mechanism.

## 6. Reasoning Display Contract

### 6.1 Summary compatibility state

Every reasoning item has isolated state:

```text
item_id
output_index
summary_index
source_kind
accumulated_text
started / text_done / item_done
```

Appendix A defines the normative state machine for streaming and non-streaming
responses, including multiple items/parts, generated IDs, truncation, abort,
terminal events, and error codes.

The downstream lifecycle is always complete:

```text
response.output_item.added(type=reasoning, summary=[], content=[])
response.reasoning_summary_part.added(summary_index=0)
response.reasoning_summary_text.delta(...)
response.reasoning_summary_text.done(item_id, summary_index, text)
response.reasoning_summary_part.done(...)
response.output_item.done(reasoning.summary=[complete text], content=[])
response.completed.response.output contains the identical final item
```

### 6.2 Source mapping

| Upstream source | Summary-compat handling |
| --- | --- |
| OpenAI native summary | bypass unchanged |
| provider summary delta | enter summary state directly |
| `reasoning_text.delta` / raw content | map to summary lifecycle |
| Anthropic `thinking` | map to summary lifecycle |

The text is not translated, shortened, copied into assistant output, or logged.
`summary-compat` ends with empty raw content so `show_raw_agent_reasoning` cannot
switch the completed item back to the unstable raw path.

### 6.3 Stream/final consistency

Already emitted text is authoritative for the downstream stream. A matching
upstream final item confirms it. A final suffix can be appended. A conflicting
non-prefix final item cannot replace visible text; the emitted text is used in
the downstream final item and a fixed mismatch code plus lengths/hashes is
recorded without reasoning content.

The downstream text-done event is deliberately delayed until the upstream
item-done or terminal response is available. This permits a final suffix to be
emitted before the single downstream done event. A final non-prefix conflict is
handled by Appendix A and never rewrites visible text.

Duplicate starts/done events, deltas without an active item, and output-index
reuse are protocol errors. Before relay they produce a structured failure.
After relay they terminate as safe `response.failed`/`response.incomplete` and
never change transport or model.

### 6.4 Raw preserve

`raw-preserve` is hidden diagnostic behavior. It preserves raw events and final
content without the compatibility state machine. It carries no promise of
stable Codex Desktop/TUI rendering.

## 7. Provider Profiles

Appendix B is the normative model/route matrix. Registry, route generation,
catalog generation, CLI controls, Swift, and browser UI must derive model state
from that matrix's fields rather than reinterpreting `listed`, `hidden`, or
`experimental` independently.

### 7.1 Native OpenAI

Existing ChatGPT authentication, native model routing, encrypted content,
official summaries, and standalone search behavior remain unchanged. Native
traffic never attaches to third-party normalization.

### 7.2 DeepSeek official

Flash and Pro default to:

```text
transport = openai-responses
toolDialect = responses-functions
reasoningDisplayMode = summary-compat
rolloutState = stable
```

Nested Responses reasoning is preserved until display normalization. Chat-only
thinking parameters are not generated. `auto` and `none` tool choices pass
through; string `required` and named forced-choice objects become `auto` due to
the measured strict-tool refusal. Errors never fall back to Chat.

### 7.3 Qwen Plan/Bailian Qwen and resold DeepSeek

Qwen3.8 Max and the measured resold DeepSeek Flash default to native Responses.
Other checked-in Qwen/resold models receive native Responses metadata but
remain hidden `experimental` canaries. They generate no route until the
operator explicitly enables that exact slug; there is no legacy Chat fallback
after Python removal.

Responses profiles enforce `store: false`, preserve authoritative usage/cache
fields, use `responses-functions`, and apply the same forced-choice downgrade
as DeepSeek.

No new Bailian quota-consuming request is required for Phase 1; existing
sanitized evidence is retained as the current proof boundary.

### 7.4 GLM-5.2

The listed canonical slug `qwen-plan/glm-5.2` uses Node-native Anthropic
Messages. It preserves thinking controls and object-valued `tool_use.input`.
The adapter converts thinking into the common summary-compat lifecycle and
serializes tool input as standard Responses JSON-string arguments.

A hidden compatibility slug `qwen-plan-responses/glm-5.2` uses native
Responses. It removes the entire caller `reasoning` object because explicit
reasoning options failed live while automatic reasoning succeeded. It keeps
`store: false`, `max_output_tokens`, automatic reasoning, and authoritative
usage.

GLM preserves forced tool choice because the measured strict/required probe
succeeded.

Appendix C defines the full Responses/Anthropic request, stream, tool-choice,
history, usage, image, stop-reason, and error mapping. It is the executable
contract for the Node Messages adapter.

## 8. Tool Dialect

Phase 1 third-party models start with `responses-functions`.

- Function tools/calls/outputs retain standard Responses shapes.
- Namespace tools use deterministic existing flattened names and are restored
  before any byte reaches Codex.
- A custom/freeform declaration becomes a function with one required string
  property named `input`.
- A mapped returned function call becomes the original `custom_tool_call` with
  the original call ID and decoded input string.
- On continuation, `custom_tool_call` history and
  `custom_tool_call_output` lower back to function call/output shapes.
- Mappings are per built request and rebuilt from pristine input. Returned
  names alone never create a mapping.

Missing/non-string/extra custom arguments are named compatibility errors, not
guessed tool calls. Promotion to `responses-native` requires a per-slug live
declaration/call/output/continuation proof.

Appendix C also defines the no-collision flattened-name algorithm, schema
normalization, forced-choice enforcement, call-ID ownership, and continuation
rebuild rules.

## 9. Standalone Web Search

Codex remains the search executor.

```text
model requests tools.web__run
-> Codex calls Router /alpha/search
-> Router forwards to authenticated ChatGPT search backend
-> Codex returns tool output to the model
```

The Router keeps `supports_standalone_web_search = true` on the generated
provider. It does not inject hosted search or fake a `web_search_call` from a
normal function call.

Codex requires `features.standalone_web_search = true` for routed models whose
catalog has `use_responses_lite = false`. The Router reports this gate through
read-only status/doctor output and prints a configuration snippet. It never
writes the user's `[features]` table or CC Switch database. Review mode follows
Codex's own search-disable behavior.

## 10. Catalog and CC Switch

The Router publishes two files:

```text
merged-models.json
  existing auto/native semantics

routed-models.json
  stable native GPT + enabled Node-provider models
  independent of the currently active CC Switch profile
```

CC Switch aggregate profiles reference `routed-models.json`. Direct profiles
ignore it. Switching profiles no longer requires a catalog refresh.

The Router publishes a copyable aggregate TOML snippet but never reads or
writes CC Switch's database and never changes its current provider.

Appendix E is the normative ownership and catalog-update contract. Router
commands, installer, doctor/fix, Swift, and browser UI are prohibited from
writing Codex config in this fork; only Router-owned files listed there may be
written.

Catalog generation must:

- preserve full instructions and model messages
- fill every required schema field explicitly
- write `supports_parallel_tool_calls` as a boolean, defaulting unknown to false
- parse under Codex 0.147 and 0.149 fixtures
- retain provider-prefixed canonical slugs
- hide experimental models and the GLM Responses alias by default
- keep `show_raw_agent_reasoning` out of model metadata because it is a Codex
  configuration field

## 11. UI and Configuration Control

### 11.1 Single Node command contract

Swift and browser UI call the same `desktop-commands.mjs` commands. Validation,
credential writes, state mutations, and returned snapshots exist only in Node.
Both UIs remain feature-complete for the supported product surface.

### 11.2 Capability manifest

The Node snapshot publishes the exact supported command/provider/feature set.
Both UIs render solely from that manifest. A capability with no complete Node
implementation is removed from both UIs; disabled placeholders are forbidden.

Appendix F is the normative command/capability matrix and schema-version
contract. Tests validate against that independent matrix, not against a
manifest generated by the same implementation under test.

Supported visible areas include:

- Router lifecycle, health, logs, doctor, and update
- native OpenAI session and usage
- DeepSeek and Qwen Plan credentials, models, and usage
- GLM canonical/diagnostic protocol state
- picker, subagents, failover, tool-result aging, and usage
- Vision Bridge with native/cloud/local image readers
- macOS presence and Dynamic Island

Removed visible areas include:

- unsupported legacy provider setup/login/cards
- LiteLLM/Python gateway status and repair
- Windows/Linux/Tauri settings
- signed-routing control, because CC Switch owns Codex configuration
- local models as chat providers

### 11.3 Browser write sessions

The existing browser panel gains write support through short-lived sessions.
The caller key is sent in a local request header to mint a one-time nonce. The
bootstrap endpoint sets an HttpOnly, SameSite=Strict, path-scoped cookie and
redirects to a clean `/panel/` URL.

Mutations require the cookie, CSRF header, exact Host/Origin, JSON content type,
and POST. CORS, iframes, third-party scripts, external assets, and referrers are
forbidden. API key inputs disable autocomplete and never enter URLs, history,
logs, or returned snapshots. Destructive actions require explicit confirmation.

Appendix J defines the complete bootstrap/session/CSRF protocol, exact
loopback host/origin policy, nonce and cookie lifetimes, operation-bound
confirmations, revocation, replay handling, and security tests.

Swift retains its complete settings UI and uses the same Node command contract.

## 12. Local Model Boundary

Local models are removed as Codex chat providers:

- no `local` or `lmstudio` routed provider
- no local chat picker/catalog overlay
- no coding-model recommendation, speed, memory-fit, tool, or agent checks
- no Local LLMs section in Swift or browser UI

Local engines remain only as Vision Bridge readers:

- explicit Ollama/LM Studio/llama.cpp reader pinning
- measured vision-reader downloads, probes, benchmarks, cache, and fallback
- no chat, tool, subagent, context-window, or picker claims

Existing local model weights are never deleted.

Appendix H defines the only allowed Vision Bridge readers. Credentials for an
unsupported legacy provider never make it eligible for automatic or pinned
vision use.

## 13. Dependency and Platform Removal

This is a macOS-only fork.

Remove:

- LiteLLM and the Python virtual environment
- Python requirements, lock generation, installer branches, and health checks
- gateway supervision and port-4200 dependency
- Rust/Tauri Windows/Linux companion and packaging
- Homebrew Python/Rust/LLVM dependencies
- runtime checks or UI controls for removed components

Keep:

- Node.js runtime and adapters
- Swift macOS tray
- browser panel assets
- target-provider credentials and state
- existing history, retained results, backups, and unsupported-provider secrets

Unsupported legacy provider slugs fail with
`provider_not_available_in_node_build` and never cause a Python spawn.

Appendix G is the upgrade/removal matrix covering installer, update, repair,
uninstall, services, health, packaging, support bundles, CI, tests, old runtime
artifacts, and deterministic non-macOS refusal.

## 14. Error and Security Boundaries

- Unknown registry values fail startup.
- Same-model transport fallback is forbidden.
- Retry/failover is legal only before the first relayed byte.
- Reasoning state errors after relay terminate safely without model/protocol
  replacement.
- Credentials remain in protected provider storage or Keychain.
- Header allowlists prevent ChatGPT auth, router keys, and attestation from
  reaching third parties.
- Provider error bodies, prompts, reasoning, tool arguments, and credentials
  are never logged.
- Browser mutations use short-lived write sessions and CSRF/origin protection.
- Removing Python/Rust never deletes old provider credentials or local weights.

Appendix I is the normative public error catalog and redaction contract for
non-streaming JSON, streaming Responses, logs, doctor, snapshots, support
bundles, and exception paths.

## 15. Testing Strategy

### 15.1 Protocol adapters

- streaming and non-streaming Responses
- byte-identical passthrough for unknown valid events
- complete summary-compat lifecycle and final-response consistency
- raw-preserve diagnostics
- Anthropic conversion for GLM canonical routing
- tools, history continuation, call IDs, images, usage, aborts, and failures
- strict no-Chat fallback assertions

### 15.2 Provider profiles

- DeepSeek Responses and forced-choice downgrade
- Qwen Responses, `store: false`, usage, and canary metadata
- GLM Anthropic thinking/tool input
- hidden GLM Responses reasoning-object removal
- no provider-specific field leakage

### 15.3 Catalog and clients

- deterministic routed catalog under any live CC Switch profile
- 0.147/0.149 catalog parsing
- instruction/template preservation
- standalone search gates
- real Codex CLI/Desktop probes using explicit quota approval
- tool-result continuation and summary UI stability at tool boundaries

### 15.4 Swift and browser UI

- extract every rendered command and match it to the Node command table
- capability-hidden controls are absent, not disabled
- browser read/write/CSRF/origin tests
- Swift snapshot and mutation-contract tests
- identical shared Node feature sets for the same capability fixture; Swift-only presentation preferences are tested separately
- every visible control succeeds against fixture state

### 15.5 Dependency removal and clean install

- repository and artifacts contain no Python/LiteLLM/Tauri runtime path
- installer never invokes python, pip, uv, cargo, or rustc
- a clean macOS user can install, start, use the tray, use the browser panel,
  and route every supported model
- all visible controls pass after clean install

## 16. Rollout

1. Implement Node transports and adapters behind non-default model metadata.
2. Implement summary compatibility and tool-dialect tests.
3. Enable the measured stable DeepSeek/Qwen entries; keep unmeasured Qwen
   entries experimental.
4. Add canonical GLM Messages and hidden GLM Responses.
5. Publish deterministic routed catalog and CC Switch snippet.
6. Complete Swift/browser capability-driven UI changes.
7. Remove local chat features and unsupported provider UI.
8. Delete Python/LiteLLM and Rust/Tauri paths.
9. Run full tests and clean macOS install.
10. Produce a reversible local release package.
11. Replace the managed checkout or current service only after explicit user
    deployment approval.

Development occurs only in the independent clone. The current managed
checkout, LaunchAgents, credentials, CC Switch database, and Codex config are
not changed during implementation.

## 17. Success Criteria

1. Supported third-party models never call LiteLLM and preserve provider
   Responses/Messages semantics except for declared compatibility transforms.
2. Third-party reasoning streams and completes through a valid summary
   lifecycle with no orphan deltas or item replacement mismatch.
3. DeepSeek/Qwen standalone search completes through `/alpha/search`.
4. Tool calls and tool-result continuation preserve names, IDs, arguments, and
   history.
5. CC Switch aggregate profiles use a stable routed catalog without manual
   refresh.
6. Every visible Swift/browser control has a working Node implementation.
7. Local chat models and unsupported provider controls are absent.
8. The clean macOS install contains and invokes no Python/LiteLLM/Rust/Tauri.
9. The current production installation remains untouched until deployment is
   separately approved.

## Appendix A. Normative Reasoning Conversion State Machine

### A.1 Identity and indexing

State is a map keyed by upstream reasoning `item_id`; items may interleave and
no global active item is assumed. Each item owns a map of summary parts keyed
by `summary_index`. Output indices must be unique within a response.

Anthropic has no Responses IDs or output indices. The adapter creates a
response ID once per request and generates item IDs as
`rsn_<base64url(sha256(response_id + ":" + output_index))[0:24]>`. Output
indices are assigned monotonically in upstream content-block order. Generated
IDs are deterministic within a replayed request and never inferred from text.

### A.2 Per-item states

Item state and summary-part state are independent.

```text
item: absent -> open -> item_done
part: absent -> open -> text_done -> done
```

- item `open` begins immediately after `response.output_item.added`; an open
  item may temporarily have no summary part.
- part `open` begins after `response.reasoning_summary_part.added`.
- part `text_done` rejects further deltas but awaits part/item completion.
- item `item_done` rejects every later event for that item.

Raw parts are opened lazily on the first raw delta, using upstream
`content_index` as downstream `summary_index`. Upstream summary sources may
open one or more parts later and preserve every summary index and part order.

### A.3 Streaming conversion table

| Upstream event | Preconditions | Downstream action |
| --- | --- | --- |
| reasoning output-item added | item absent | add reasoning item with empty summary/content; open no part yet |
| summary-part added | item open, part absent | add same-index summary part and mark the part open |
| summary-text delta | part open | emit same-index summary delta and append text |
| first raw reasoning delta at content index | item open, part absent | synthesize same-index summary part, emit delta, append text |
| later raw reasoning delta | addressed synthesized part open | emit same-index summary delta and append text |
| upstream text done for summary index | item open, addressed part open | mark that part text-done upstream; delay downstream text-done |
| output-item done with matching selected final parts | item open | compare/finish every part by summary index, then item-done |
| output-item done with no prior added/delta | item absent | select final parts from the model profile, synthesize all parts in order, then complete each and item-done |
| output-item done with non-prefix conflicting text | item open | keep emitted text, emit done sequence, record `reasoning_final_mismatch` |
| response completed/incomplete | all open items | close each item in output-index order before emitting one terminal event |
| response failed | all open items | close partial items as incomplete, then emit one failed terminal event |

If an upstream final text is a strict extension of emitted text, its suffix is
emitted before the delayed text-done. Whitespace is significant; no normalized
comparison or content rewrite is permitted.

Multiple reasoning items and multiple summary parts are legal. Interleaved
events are routed by `(item_id, summary_index)`; output order remains upstream
output-index order and part order is ascending summary index.

Final source is selected by the model profile's required
`finalReasoningShape`, never by whether deltas happened to arrive:

- `raw-content`: ordered `reasoning_text` entries from final `content[]`;
  `summary[]` must be empty. Used by DeepSeek official.
- `provider-summary`: ordered `summary_text` entries from final `summary[]`;
  `content[]` must be empty.
- `hybrid-summary`: streaming raw deltas are legal, but ordered final
  `summary[]` is authoritative and `content[]` must be empty. Used by measured
  Bailian Qwen/resold DeepSeek.
- `anthropic-thinking`: ordered accumulated thinking blocks are authoritative.

`selectedFinalParts(source_kind, finalItem)` is the one function used for
streaming item-done, final-only streaming items, and non-streaming JSON. A
profile/final-shape mismatch is `reasoning_final_mismatch` even when no delta
was observed.

The selected final parts must be contiguous from zero. Raw `content[]` parts
map one-to-one by content index; text fragments inside a part concatenate in
wire order and parts are never concatenated across indices. Each opened part
is compared only with final text at its own index. A strict suffix is emitted
before its one downstream text-done. A final part never opened is synthesized
as part-added, one delta, text-done, and part-done. An opened part absent from
the selected final set is `reasoning_final_part_missing`; duplicate/reordered/
non-contiguous indices are `reasoning_index_mismatch`. Every part reaches done
before item-done. Final-only items synthesize every part.

A provider summary stream is reconstructed through the same state machine
rather than blindly piped so final/terminal consistency is still enforced.

### A.4 Abort and truncation

Caller abort immediately aborts upstream and writes no synthetic terminal
event to a disconnected response. Upstream `response.incomplete` closes active
parts/items with accumulated text and emits one incomplete terminal response
whose reason is preserved. EOF without a terminal event is
`upstream_stream_truncated`; before relay it is a JSON error, after relay it is
a single `response.failed` terminal event.

Exactly one terminal event is legal. Events after terminal are ignored for
output, counted as `event_after_terminal`, and make the request fail if no byte
has yet been relayed.

### A.5 Non-streaming conversion

For each final reasoning item, the adapter invokes the same
`selectedFinalParts(source_kind, finalItem)` used by streaming. Every selected
part maps one-to-one by source index to one downstream `summary_text` part;
raw content parts are never collapsed together. Anthropic thinking blocks map
one-to-one in block order. Downstream `content` is empty and item ID/output
index are preserved or generated by A.1.

The response remains non-streaming; no synthetic SSE is created. Usage and all
non-reasoning output items are preserved.

### A.6 State-machine error codes

```text
reasoning_delta_without_item
reasoning_part_without_item
reasoning_duplicate_item
reasoning_duplicate_part
reasoning_delta_after_done
reasoning_duplicate_done
reasoning_index_mismatch
reasoning_final_mismatch
reasoning_final_part_missing
reasoning_unclosed_at_terminal
event_after_terminal
upstream_stream_truncated
```

Fixtures must cover every legal row and every error code for streaming and
non-streaming paths.

## Appendix B. Normative Model and Route Matrix

Field definitions:

- `enabled`: provider/model selected in Router state.
- `routable`: a route is generated and direct slug calls are accepted.
- `listed`: appears in the routed catalog when routable.
- `visible`: listed and not hidden by picker state.
- `experimental`: requires an explicit per-slug canary enable.
- `credential owner`: protected credential namespace, never a copied key.

Canary state lives in protected Router state `experimental-models.json` and is
changed only by `control experimental-models set SLUG on|off` or the equivalent
Swift/Web command. Protocol shape proof lives in protected
`protocol-proofs.json`, keyed by exact slug/provider/transport and written only
by an explicitly quota-approved live verifier. A canary becomes routable only
when enabled and backed by a proof resolving one of the four verified final
shapes. An off/unproved canary returns `model_not_enabled`. Compatibility is a
model purpose, not a rollout state; compatibility aliases are experimental and
use the same proof gate.

| Access | Canonical slug | Upstream model | Transport | Tool dialect | Declared final shape | Purpose | Credential owner | Default enabled | Routable rule | Listed/UI | Rollout |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| native | account-provided `gpt-*` | same native slug | native-openai | responses-native | provider-summary; bypass normalizer | primary | caller ChatGPT session | session-driven | usable session | account catalog | stable |
| deepseek | `deepseek/deepseek-v4-flash` | `deepseek-v4-flash` | openai-responses | responses-functions | raw-content | primary | deepseek | provider-selected | provider enabled | listed/visible | stable |
| deepseek | `deepseek/deepseek-v4-pro` | `deepseek-v4-pro` | openai-responses | responses-functions | raw-content | primary | deepseek | provider-selected | provider enabled | listed/visible | stable |
| qwen-plan | `qwen-plan/qwen3.8-max` | `qwen3.8-max` | openai-responses | responses-functions | hybrid-summary | primary | qwen-plan | provider-selected | provider enabled | listed/visible | stable |
| qwen-plan | `qwen-plan/deepseek-v4-flash-0731` | `deepseek-v4-flash-0731` | openai-responses | responses-functions | hybrid-summary | primary | qwen-plan | provider-selected | provider enabled | listed/visible | stable |
| qwen-plan | `qwen-plan/qwen3.8-max-preview` | `qwen3.8-max-preview` | openai-responses | responses-functions | unverified | primary | qwen-plan | off | provider enabled + canary on + valid proof | hidden until proof | experimental |
| qwen-plan | `qwen-plan/qwen3.7-max` | `qwen3.7-max` | openai-responses | responses-functions | unverified | primary | qwen-plan | off | provider enabled + canary on + valid proof | hidden until proof | experimental |
| qwen-plan | `qwen-plan/qwen3.7-plus` | `qwen3.7-plus` | openai-responses | responses-functions | unverified | primary | qwen-plan | off | provider enabled + canary on + valid proof | hidden until proof | experimental |
| qwen-plan | `qwen-plan/qwen3.6-flash` | `qwen3.6-flash` | openai-responses | responses-functions | unverified | primary | qwen-plan | off | provider enabled + canary on + valid proof | hidden until proof | experimental |
| qwen-plan | `qwen-plan/deepseek-v4-pro` | `deepseek-v4-pro` | openai-responses | responses-functions | unverified | primary | qwen-plan | off | provider enabled + canary on + valid proof | hidden until proof | experimental |
| qwen-plan | `qwen-plan/deepseek-v4-pro-0813` | `deepseek-v4-pro-0813` | openai-responses | responses-functions | unverified | primary | qwen-plan | off | provider enabled + canary on + valid proof | hidden until proof | experimental |
| qwen-plan Messages | `qwen-plan/glm-5.2` | `glm-5.2` | anthropic-messages | responses-functions | anthropic-thinking | primary | qwen-plan | provider-selected | provider enabled | listed/visible | stable |
| qwen-plan Responses | `qwen-plan-responses/glm-5.2` | `glm-5.2` | openai-responses | responses-functions | unverified | compatibility | qwen-plan | off | provider enabled + canary on + valid proof | unlisted/hidden; direct after proof | experimental |

Registry, route table, catalog, control snapshot, Swift, and browser tests must
derive and assert every column. No other provider/model is routable in the
Node-only build.

Registry validation rejects a stable/routable model with missing or unresolved
effective shape. A proof must match slug, provider, upstream model, transport,
tool dialect, request profile, and registry fingerprint. Route/catalog tests
assert that canary enable without a matching proof, or with any mismatched proof
field, produces no route or visible entry.

## Appendix C. Tool and GLM Messages Contracts

### C.1 Deterministic tool names

Allowed upstream function names are `[A-Za-z0-9_-]` and at most 64 bytes.
Native valid names are preserved unless they collide. Namespace/custom names
are encoded as:

```text
cr_<sanitized-prefix-truncated-to-40>_<base32(sha256(kind + NUL + original))[0:16]>
```

The full request-local map stores encoded name, original kind/name, schema, and
call type. Hash collisions or duplicate encoded names are startup/build errors,
not runtime overwrites. Unknown returned names, duplicate call IDs, and call IDs
not present in the current/history map are `tool_mapping_error`.

### C.2 Function/custom conversion

- Function declarations/calls/outputs remain Responses-native.
- Custom/freeform declarations become a function with one required string
  property `input`, `additionalProperties: false`, and `strict` removed for
  DeepSeek/Qwen profiles.
- Mapped function arguments must decode to exactly `{ "input": string }`.
- Mapped calls restore original name/type and preserve call ID.
- History lowering/restoration repeats the same deterministic mapping from the
  request's declarations; it never guesses from a model name.

### C.3 Forced choice and strict schemas

For DeepSeek and Qwen profiles:

| Caller shape | Upstream shape | Downstream enforcement |
| --- | --- | --- |
| `auto` | `auto` | none |
| `none` | `none` | no tool call accepted |
| string `required` | `auto` | buffer response; require at least one mapped tool call |
| named function | `auto` | buffer response; require that exact mapped function |
| function `strict: true` | remove `strict`; preserve schema after supported-key normalization | validate returned arguments locally |

Forced turns buffer at most 8 MiB of decoded upstream response bytes and 30
seconds from initial upstream dispatch before relay. Exactly 8 MiB and exactly
30 seconds are allowed; the first additional byte/millisecond fails. Size
overflow aborts upstream and returns HTTP 413 `forced_tool_buffer_limit`.
Deadline overflow aborts upstream and returns HTTP 504
`forced_tool_buffer_timeout`. Neither case relays, retries, or fails over. A
caller abort cancels immediately and writes no response to a disconnected
caller. Authoritative usage observed before abort is recorded in private usage
telemetry but omitted from the public error. No required call after a complete
buffer produces HTTP 422 `required_tool_not_called`; a wrong named call
produces `required_tool_mismatch`.
GLM preserves `auto`, `none`, `required`, named choice, and strict schemas as
measured.

Forced-buffer fixtures cover exactly 8 MiB, 8 MiB plus one decoded byte,
exactly 30 seconds, 30 seconds plus one millisecond, authoritative usage before
abort, and caller abort. They assert one upstream abort, no relayed byte, no
retry, and no failover.

### C.4 GLM Responses-to-Anthropic request mapping

| Codex Responses | Anthropic Messages |
| --- | --- |
| `instructions` string/blocks | one ordered `system` block list |
| user `input_text` | user text block |
| user `input_image` | Anthropic image source block; unsupported source is rejected |
| assistant `output_text` | assistant text block |
| function call | assistant `tool_use` with parsed object input |
| function-call output | user `tool_result` with same tool-use ID |
| custom call/output | lower through C.2, then tool-use/tool-result |
| reasoning from prior GLM Messages turn | assistant `thinking` block when valid; foreign reasoning is omitted, never converted to user-visible text |
| valid `max_output_tokens` integer | identical `max_tokens` |
| `parallel_tool_calls=false` | `disable_parallel_tool_use=true` on applicable choice |

Reasoning configuration maps to Anthropic thinking as follows:

| Caller reasoning | Effective effort | Anthropic thinking |
| --- | --- | --- |
| field omitted | model-profile default `max` | enabled, budget 32768 |
| object with omitted effort | model-profile default `max` | enabled, budget 32768 |
| effort `off` or `none` | off | thinking omitted |
| supported effort | same effort | enabled with table budget |
| explicit null/non-object | none | HTTP 400 `invalid_reasoning_config` |
| unknown effort | none | HTTP 400 `unsupported_reasoning_effort` |

Any caller summary preference is a downstream display preference only and does
not become an Anthropic thinking parameter.

Enabled effort maps to a requested thinking budget:

```text
minimal 1024
low     2048
medium  4096
high    8192
xhigh  16384
max    32768
```

When `max_output_tokens` is omitted, the GLM Messages profile uses the measured
provider maximum `131072` as `max_tokens`; the value is a generation cap, not a
requested token count. Explicit null, non-integer, zero, or negative values are
HTTP 400 `invalid_output_limit`. A valid caller integer becomes Anthropic
`max_tokens` byte-for-byte and must be between `budget_tokens + 1024` and
131072. The Router never raises or lowers an explicit limit. A smaller limit is
HTTP 400 `thinking_budget_exceeds_output_limit`; a larger limit is HTTP 400
`output_limit_exceeds_provider_cap`. No reasoning request silently omits or
weakens `thinking`. When thinking is off, any positive integer through 131072
is valid and no budget-derived minimum applies.

Tool choice mapping:

```text
auto     -> {type:"auto"}
none     -> omit tools and tool_choice
required -> {type:"any"}
named    -> {type:"tool", name:mapped_name}
```

### C.5 GLM Anthropic stream mapping

| Anthropic event/block | Responses event |
| --- | --- |
| message start | response created/in-progress; initial usage |
| thinking block start | generated reasoning item + summary part start |
| thinking delta | summary text delta |
| signature delta | accumulate as opaque continuation metadata; never display/log |
| text block start/delta/stop | message item + output-text lifecycle |
| tool-use block + input JSON deltas | function-call item and argument deltas/done |
| message delta with stop reason/usage | record reason and final usage; emit no terminal event |
| message error before terminal | close active items, emit one failed terminal event, ignore later stop |
| message stop after `end_turn`/`tool_use` | emit one completed terminal event |
| message stop after `max_tokens` | emit one incomplete event, reason `max_output_tokens` |
| message stop without reason | emit completed only when all items are validly closed; otherwise protocol error |

Input/output/cache usage is copied when authoritative. Missing cache fields stay
missing. Abort cancels upstream immediately. Unknown content blocks fail before
relay or terminate as `unsupported_anthropic_block` after relay.

Exactly one terminal event is emitted. Missing `message_stop` is
`upstream_stream_truncated`; duplicate stop is `event_after_terminal`. An error
after a stop is ignored and counted; an error after a delta but before stop
emits the one failed terminal event.

Thinking signatures are accumulated per thinking block and carried through
Codex history in the reasoning item's `encrypted_content` as a common
Router-owned provenance envelope:

```text
cr.reasoning.v1.<base64url(canonical JSON payload)>.<base64url(HMAC-SHA256)>
```

The payload schema is:

```json
{
  "v": 1,
  "provider": "qwen-plan",
  "model": "glm-5.2",
  "transport": "anthropic-messages",
  "responseId": "...",
  "itemId": "...",
  "textSha256": "...",
  "signature": "..."
}
```

The payload is serialized using RFC 8785 JSON Canonicalization Scheme (JCS),
UTF-8, with no Unicode normalization. `textSha256` is
`base64url(SHA-256(UTF8(JCS(summaryParts))))`, where `summaryParts` is the exact
ordered array of part strings. HMAC input is the ASCII domain separator
`codex-router.reasoning-envelope.v1`, one zero byte, then the UTF-8 JCS payload
bytes. HMAC-SHA256 uses the Router internal key. Payload and MAC use unpadded
base64url.

The HMAC covers those canonical bytes.
Every Node adapter may emit the same envelope; non-Anthropic adapters set
`signature` to null. The envelope is never logged. On continuation, HMAC,
version, current item/text hash, and route provenance are verified before a
valid GLM envelope plus summary-compat text reconstructs the Anthropic
`thinking` block/signature before tool-use history.

If a verified envelope identifies canonical GLM Messages but the signature is
missing/empty, dispatch fails HTTP 422 `thinking_signature_missing`. Invalid
HMAC/schema/version/text hash is `thinking_signature_invalid`. A verified
envelope for another provider/model/transport is positively foreign and may be
omitted. Missing envelope, untagged encrypted content, or provenance that is
neither valid-current nor valid-foreign is `thinking_provenance_unknown` and
fails closed. Native Fernet data is foreign only when native-route metadata
also verifies it; no prefix alone is trusted. There is no unknown/missing
continue path.

Fixtures cover text, thinking, image, one/multiple tools, tool continuation,
parallel disabled/enabled, every tool-choice shape, max-token incomplete,
usage/cache, 4xx/5xx, malformed JSON deltas, abort, and truncation. Output-limit
fixtures cover omitted, null, non-integer, zero, negative, exact
`budget + 1024`, one below that boundary, exactly 131072, and one above it.
Thinking-continuation fixtures cover valid signature, confirmed-GLM missing
signature, malformed/HMAC-tampered tagged envelope, unsupported version,
cross-model/provider copy, text-hash mismatch, missing/unknown provenance, and
positively verified foreign reasoning. Reasoning fixtures cross omitted,
effort-omitted, off/none, every supported effort, null/non-object, and unknown
effort with omitted/default/explicit output limits.

Checked-in golden vectors cover ASCII, reordered object keys, escaped control
characters, non-ASCII and combining Unicode without normalization, numeric
version encoding, payload/MAC base64url, verification across releases, and
one-bit tampering.

## Appendix D. Retry and Failover Decision Table

Retry and failover are mutually exclusive decisions made before piping.

| Failure | Retry | Model failover |
| --- | --- | --- |
| connect/DNS/socket error before response | up to 2 | no |
| 502/503/504/520-524 before bytes | up to 2 | no |
| 429 | no | only `Retry-After > 60s` |
| 402 or classified `out_of_usage` | no | yes |
| entitlement/401/403/404/400/409/422 | no | no |
| 500 | no | no |
| malformed/partial stream | no | no |
| reasoning/tool compatibility error | no | no |

Retry backoff is 250 ms then 750 ms, total cheap-attempt budget 5 seconds,
abort-aware, and legal only while no byte has been relayed. Configuration may
reduce retries to zero but not widen status/error classes in this fork.

Failover permits at most two hops and 30 seconds total. Candidates must:

- be outside the failed provider family
- fit the estimated context
- not be in a provider-declared cooldown
- have the identical effective transport and compatible tool dialect
- satisfy Appendix A/C marker requirements
- never be Chat Completions

Native OpenAI is not a candidate for routed-provider failover. The original
selected-model error is returned if every candidate fails or none qualifies.
Only provider-declared reset windows create cooldowns, capped at six hours.

## Appendix E. Configuration Ownership and Catalog Lifecycle

In this fork, Router installer, update, repair, doctor/fix, CLI control, Swift,
and browser UI are prohibited from writing any file under `$CODEX_HOME` except
Router-owned state below `$CODEX_HOME/codex-router`. They never write
`config.toml`, `auth.json`, agents, profiles, projects, MCP settings, features,
or CC Switch files/database.

Allowed writes are limited to:

- Router protected state and credentials
- `merged-models.json` and `routed-models.json`
- Router logs, usage, retained results, backups, and proof state
- Router LaunchAgents and the installed Swift application

Catalog inputs are the captured native account catalog, the checked-in supported
registry, protected selection/credential/visibility/canary state, and supported
user model/protocol-proof state. Triggers are service startup,
registry/update completion, credential change, provider/model selection,
visibility/canary change, protocol-proof create/update/revoke/invalidation, and
native-session usability transition. Every trigger recomputes effective model
metadata, route table, both catalogs, control snapshot, and both UI snapshots
under one state lock.

Generation holds one process lock. Each output is written 0600 to a sibling
temporary file, fsynced, validated against both Codex schemas, and atomically
renamed. A failed build leaves the previous file byte-identical. Concurrent
triggers coalesce into one subsequent rebuild.

The CC Switch snippet is a pure deterministic render returned by CLI/UI. It is
never written automatically. Repeated rendering is byte-identical and redacts
the caller capability in status/log output.

## Appendix F. Normative UI Command Matrix

`capabilitySchemaVersion` is `1`. Swift/browser with an unknown major version
render read-only incompatibility status and expose no mutations. Commands use
JSON-schema-validated arguments and `{ok,value}` or Appendix I errors.

| Capability | Node commands | Swift | Browser write session |
| --- | --- | --- | --- |
| lifecycle | status, start, stop, restart, logs | full | status/logs/restart; stop ends panel with confirmation |
| doctor/update | doctor, doctor-fix, update, rollback | full | full, destructive confirmation where applicable |
| native session/usage | native-status, account-usage | full | full |
| provider credentials | credential status/set/remove for deepseek/qwen-plan | full | full; set/remove protected |
| provider/model state | provider enable, model visibility, canary set | full | full |
| protocol proof | protocol-proof status/verify/revoke for exact slug | full; verify labels quota and confirms | full; verify labels quota and uses server confirmation |
| picker/catalog | picker status/set/show-all, catalog status/render-snippet | full | full |
| subagents | status/mode/model/selection/verify | full | full; verify labels quota use |
| failover | status/reset | full | full; reset confirmation |
| tool-result aging | status/on/off/ttl/purge | full | full; purge confirmation |
| usage | router/provider/model usage | full | full |
| Vision Bridge | status/on/off/engine/effort/probe/pull/purge-cache | full | full; downloads/purge confirmed |
| presence | status/mode | full | full |
| Dynamic Island | Swift-local settings only; no Node mutation capability | full | not applicable |
| CC Switch integration | snippet/status only | full | full |

Dynamic Island is a Swift presentation preference, not a shared Router
capability. Browser completeness is measured only against shared Node
capabilities. Unsupported provider, Python gateway, Tauri, signed-routing, login-free, and
local-chat commands are absent from the Node command table and both UIs.

The test oracle is a checked-in `required-capabilities.json` derived from this
table, not from runtime code. Tests assert every required command exists in Node
and every required UI presentation exists, as well as the inverse absence set.

`protocol-proof verify SLUG --yes` is the only proof writer. Without `--yes`
the CLI prints the quota warning and exits without a request; Swift/browser use
their operation-bound confirmation flow. The verifier uses registry-bound
provider credentials and calls the declared upstream transport internally even
when no public route exists. It never uses Chat fallback, public model
failover, or another slug. It verifies non-stream text/terminal, streaming
reasoning final shape, auto function call, tool-result continuation, and usage.

Proof records contain version, slug, provider, upstream model, transport, tool
dialect, request profile, registry fingerprint, measured final reasoning shape,
verified timestamp, and verdict. Only a passing verdict is route-authoritative.
A failed attempt does not create/replace a proof; an existing proof remains
valid only while its fingerprint still matches. Changes to slug/provider/
upstream model/transport/tool dialect/request profile or the verifier version
invalidate the proof immediately. `protocol-proof revoke SLUG` removes it and
atomically removes the route/catalog/UI entry when no stable declaration exists.
Tests cover no-confirmation/no-request, direct declared transport, no
fallback/failover, passing proof, failed first proof, failed reverify, revoke,
every fingerprint mismatch, atomic refresh, and UI quota labeling.

## Appendix G. Upgrade, Removal, and Platform Matrix

| Surface | Upgrade action | Preserve |
| --- | --- | --- |
| service | stop exact Router LaunchAgent; install Node-only args; bootstrap; health-check | caller/internal keys, logs, usage |
| Python venv/LiteLLM config | remove only fork-owned venv/config after backup and successful Node health | provider credentials/state |
| port 4200/gateway supervisor | remove launch args, health dependency, env, support output | other known Router processes |
| Rust/Tauri artifacts | remove fork-owned installed companion/build/package entries | Swift app/settings |
| installer/update/repair | replace with macOS Node/Swift flow | unrelated user files and package managers |
| uninstall | remove only fork-owned service/app/runtime/catalog files | credentials, history, backups, retained results, local weights unless separately requested |
| doctor/support bundle | remove Python/Tauri checks; add target-provider/Node/UI checks | redaction contract |
| CI/tests/docs | delete executable/build jobs and obsolete product docs; retain historical design references | benchmark evidence |

An upgrade snapshots file bytes and modes before mutation. Failure restores the
old LaunchAgent/runtime and restarts the old service. Cleanup runs only after
the new Node service and both UI contracts pass. Old runtime artifact paths are
resolved against a closed allowlist; no recursive deletion or broad glob is
allowed.

Linux/Windows install, update, repair, service, panel-write, and tray entry
points fail before writes with `unsupported_platform` and exit code 2. Source
history may mention Python/Rust; the static gate forbids executable imports,
spawn commands, lock/install requirements, service args, package dependencies,
or release artifacts for them.

Upgrade fixtures start from the current released installation and assert that
credentials, history, backups, CC Switch/Codex settings, retained results, and
local weights remain byte-identical while old processes and owned runtime
artifacts are gone.

## Appendix H. Vision Bridge Allow Matrix

Allowed readers:

- native ChatGPT vision models with a usable caller session
- supported Node-provider models whose registry declares image input and whose
  credential/provider is enabled
- an explicitly pinned loopback Ollama, LM Studio, or llama.cpp vision reader

Automatic selection excludes loopback engines and every unsupported legacy
provider even when a credential exists. Explicit pins to a legacy cloud slug
are rejected with `vision_engine_not_supported`; direct old-slug requests also
fail closed. Local readers never enter the chat picker or acquire chat/tool/
subagent metadata.

Registry, catalog, Swift, browser, auto selection, explicit pin, fallback, and
request tests all use this same allow matrix.

## Appendix I. Public Error and Redaction Contract

Non-streaming errors use:

```json
{"error":{"type":"router_error","code":"CODE","message":"SAFE_MESSAGE","param":null}}
```

Before any stream byte, the same JSON is returned with the listed HTTP status.
After stream relay, exactly one terminal event is followed by exactly one
`data: [DONE]\n\n` frame. Sequence numbers are monotonically increasing.

Failed stream shape:

```json
{
  "type": "response.failed",
  "sequence_number": 17,
  "response": {
    "id": "resp_<request-id>",
    "object": "response",
    "created_at": 0,
    "status": "failed",
    "model": "canonical/slug",
    "output": [],
    "error": {"code": "CODE", "message": "SAFE_MESSAGE"},
    "incomplete_details": null,
    "usage": null
  }
}
```

`output` contains any already validly closed items and `usage` contains only
authoritative usage observed before failure. No request body or provider error
body is copied. The event is framed as `data: <json>\n\n`.

Incomplete stream shape uses the same response fields with:

```json
{
  "type": "response.incomplete",
  "response": {
    "status": "incomplete",
    "error": null,
    "incomplete_details": {"reason": "REASON_CODE"}
  }
}
```

Fields not shown above are omitted rather than synthesized. A failed event is
used for protocol/compatibility/upstream errors; incomplete is used only for an
authoritative provider max-output/context terminal or an explicit upstream
incomplete event.

| Code | HTTP | Public message class |
| --- | --- | --- |
| provider_not_available_in_node_build | 404 | provider unsupported by this build |
| model_not_enabled | 404 | model/canary not enabled |
| unsupported_platform | 400 | macOS-only build |
| reasoning_protocol_error | 502 | invalid upstream reasoning sequence |
| reasoning_final_mismatch | 502 | upstream final reasoning mismatch |
| upstream_stream_truncated | 502 | upstream stream ended early |
| unsupported_anthropic_block | 502 | unsupported Messages block |
| thinking_signature_missing | 422 | required GLM thinking signature is missing |
| thinking_signature_invalid | 422 | invalid GLM thinking continuation metadata |
| thinking_provenance_unknown | 422 | reasoning provenance cannot be verified |
| invalid_reasoning_config | 400 | reasoning must be an object or omitted |
| unsupported_reasoning_effort | 400 | requested reasoning effort is unsupported |
| invalid_output_limit | 400 | output limit must be a positive integer |
| thinking_budget_exceeds_output_limit | 400 | output limit cannot contain requested thinking budget |
| output_limit_exceeds_provider_cap | 400 | output limit exceeds GLM provider cap |
| tool_mapping_error | 422 | invalid/unknown tool mapping |
| required_tool_not_called | 422 | required tool absent |
| required_tool_mismatch | 422 | wrong named tool |
| forced_tool_buffer_limit | 413 | forced-tool response exceeded buffer limit |
| forced_tool_buffer_timeout | 504 | forced-tool validation exceeded time limit |
| upstream_timeout | 504 | upstream timed out |
| panel_auth_required | 401 | write session required |
| panel_csrf_invalid | 403 | invalid panel mutation proof |
| panel_confirmation_required | 409 | operation-bound confirmation required |
| vision_engine_not_supported | 400 | reader excluded by allow matrix |

Appendix A internal reasons map to public errors as follows:

| Internal reason | Public code | Terminal |
| --- | --- | --- |
| reasoning_delta_without_item | reasoning_protocol_error | failed |
| reasoning_part_without_item | reasoning_protocol_error | failed |
| reasoning_duplicate_item | reasoning_protocol_error | failed |
| reasoning_duplicate_part | reasoning_protocol_error | failed |
| reasoning_delta_after_done | reasoning_protocol_error | failed |
| reasoning_duplicate_done | reasoning_protocol_error | failed |
| reasoning_index_mismatch | reasoning_protocol_error | failed |
| reasoning_final_mismatch | reasoning_final_mismatch | failed |
| reasoning_final_part_missing | reasoning_protocol_error | failed |
| reasoning_unclosed_at_terminal | reasoning_protocol_error | failed |
| upstream_stream_truncated | upstream_stream_truncated | failed |
| event_after_terminal | internal metric only; no second public event | none |

Logs retain the internal reason; callers receive only the public code. The
mapping is identical for streaming and non-streaming requests.

Provider status may be preserved, but raw provider bodies/messages are never
public. Only allowlisted provider code/type/request ID/rate-limit headers may be
relayed. Every log, exception formatter, doctor row, control snapshot, support
bundle, benchmark, and partial-write failure uses the same redactor for API
keys, bearer values, capability paths, prompts, reasoning, tool arguments, and
response bodies.

Leak tests plant unique decoy values in each sensitive source and assert none
appears in stdout, stderr, logs, JSON snapshots, support bundles, errors, temp
files, or exception cause chains.

## Appendix J. Browser Write-Session Protocol

### J.1 Bootstrap

1. Swift or `panel --write` reads the caller secret locally.
2. It sends `POST /<caller-capability>/panel-sessions` to
   `127.0.0.1:<router-port>` with the caller key in the Authorization header,
   JSON content type, and no request body secrets.
3. Router verifies loopback peer, exact Host, capability, and method, then
   creates a 256-bit bootstrap nonce with 30-second TTL and one-use state.
4. The launcher opens `/panel-bootstrap/<nonce>`. The nonce may appear in
   history but carries no caller key, is single-use, and expires in 30 seconds.
5. Router consumes the nonce atomically, creates a 256-bit session ID and a
   separate 256-bit CSRF token, sets the session cookie, and redirects 303 to
   `/panel/`.
6. `/panel/session` returns the CSRF token only to a request carrying the
   session cookie. Browser JS keeps it in memory only.

### J.2 Session policy

- Cookie: `HttpOnly; SameSite=Strict; Path=/panel`; no Secure flag on plain
  loopback HTTP; never a Domain attribute.
- Idle TTL 15 minutes; absolute TTL 60 minutes; maximum eight concurrent write
  sessions. Oldest idle session is revoked when the cap is reached.
- Explicit logout and Router restart revoke sessions. Swift/CLI can revoke all
  sessions through caller-authenticated loopback POST.
- Bootstrap/session/CSRF values never enter logs, snapshots, referrers, or UI
  state serialization.

### J.3 Request validation

Mutation requests require:

- exact Host `127.0.0.1:<router-port>`
- exact Origin `http://127.0.0.1:<router-port>`
- no acceptance of forwarded host/origin headers
- loopback peer address
- POST and `application/json`
- valid session cookie
- `X-CSRF-Token` equal to the session token
- a client-generated request UUID; the session keeps a bounded replay cache and
  returns the previous result without repeating the mutation

Mutations reject missing Origin. Bootstrap navigation is the only state-changing
request allowed without Origin and is protected by its one-use nonce.

### J.4 Destructive confirmation

The UI first posts command plus canonical argument hash to
`/panel/confirmations`. Router returns a 256-bit, one-use, 60-second token bound
to session ID, command, and argument hash. The mutation must present it in
`X-Confirmation-Token`; the server consumes it before execution. A UI dialog
without this server token grants no authority.

### J.5 Browser headers and tests

Every request under `/panel`, `/panel-bootstrap`, `/panel/session`, panel APIs,
and panel static assets first requires a loopback peer and exact Host
`127.0.0.1:<router-port>`. Forwarded host/address headers are ignored. This
read-side gate applies before session, Origin, or command handling and prevents
DNS rebinding from reading panel state. Mutations additionally require the
exact Origin from J.3.

All bootstrap, session, mutation, credential, usage/state, and error responses
set `Cache-Control: no-store` and `Pragma: no-cache`. Static assets set
`Cache-Control: no-cache` so no authenticated representation is persisted.

Panel responses set CSP `default-src 'self'; frame-ancestors 'none';
object-src 'none'; base-uri 'none'`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, and `X-Content-Type-Options: nosniff`. CORS is absent.
No third-party resource is loaded.

Tests cover nonce replay/expiry/race, session expiry/revocation/cap, wrong or
missing Host/Origin/CSRF/cookie/content type/method on read and write routes,
DNS-rebinding reads/headers, iframe/navigation CSRF, duplicate request IDs,
confirmation mismatch/replay, HTTP-cache persistence, and leakage into
URL/history/log/snapshot/support bundle fixtures.
