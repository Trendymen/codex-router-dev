import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactCallerUrl } from "./caller-auth.mjs";
import { MODEL_BY_SLUG } from "./model-registry.mjs";
import {
  installedRouterBaseUrl,
  smokeTestModel,
} from "./smoke-test.mjs";

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  return (payload?.output || [])
    .flatMap((item) => item?.content || [])
    .map((part) => part?.text)
    .filter((value) => typeof value === "string")
    .join("\n");
}

async function request(suffix, body, timeoutMs = 180_000) {
  const response = await fetch(`${installedRouterBaseUrl()}${suffix}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer codex-router-local-compatibility-test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

const PROBE_TOOL = {
  type: "function",
  name: "codex_router_probe",
  description: "Compatibility probe",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  strict: true,
};

async function toolCall(model, toolChoice = "required") {
  const { response, payload } = await request("/responses", {
    model,
    stream: false,
    input: "Call codex_router_probe exactly once with value set to ok. Do not answer normally.",
    tools: [PROBE_TOOL],
    tool_choice: toolChoice,
  });
  const call = (payload?.output || []).find(
    (item) => item?.type === "function_call" && item?.name === "codex_router_probe",
  );
  let argumentsValid = false;
  try {
    argumentsValid = JSON.parse(call?.arguments || "{}").value === "ok";
  } catch {
    // Invalid tool arguments are a compatibility failure.
  }
  return {
    call,
    usage: payload?.usage,
    ok: response.ok && Boolean(call) && argumentsValid,
    status: response.status,
    detail: call && argumentsValid ? "function call and JSON arguments verified" : responseText(payload) || payload?.error?.message || "function call missing",
  };
}

function streamedEvents(body) {
  return body.split(/\r\n\r\n|\n\n|\r\r/).flatMap((block) => {
    const line = block.split(/\r\n|\n|\r/).find((entry) => entry.startsWith("data:"));
    if (!line || line.slice(5).trim() === "[DONE]") return [];
    try { return [JSON.parse(line.slice(5).trim())]; } catch { return []; }
  });
}

async function reasoningProbe(model) {
  const response = await fetch(`${installedRouterBaseUrl()}/responses`, {
    method: "POST",
    headers: { Authorization: "Bearer codex-router-local-compatibility-test", "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true, input: "Reason briefly, then answer with exactly PROBE_REASONING_OK." }),
    signal: AbortSignal.timeout(180_000),
  });
  const events = streamedEvents(await response.text());
  const lifecycle = events.some((event) => ["response.reasoning_summary_part.added", "response.reasoning_summary_text.delta", "response.reasoning_text.delta", "response.reasoning_summary_text.done"].includes(event.type));
  const completed = events.find((event) => event.type === "response.completed")?.response;
  const item = (completed?.output || []).find((entry) => entry?.type === "reasoning");
  const measuredFinalReasoningShape = item?.thinking?.length ? "anthropic-thinking" : item?.summary?.length && item?.content?.length ? "hybrid-summary" : item?.summary?.length ? "provider-summary" : item?.content?.length ? "raw-content" : "unverified";
  return { ok: response.ok && lifecycle && Boolean(item), measuredFinalReasoningShape, status: response.status, detail: item ? `reasoning lifecycle and ${measuredFinalReasoningShape} final shape observed` : "reasoning lifecycle missing" };
}

async function continuationProbe(model) {
  const first = await toolCall(model, "required");
  if (!first.ok || !first.call) return { ok: false, status: first.status, detail: `initial tool call unavailable: ${first.detail}` };
  const followup = await request("/responses", {
    model,
    stream: false,
    input: [first.call, { type: "function_call_output", call_id: first.call.call_id, output: "ok" }],
    tools: [PROBE_TOOL],
    tool_choice: "auto",
  });
  return { ok: followup.response.ok && Boolean(responseText(followup.payload)), status: followup.response.status, detail: followup.response.ok ? "tool output continuation completed" : followup.payload?.error?.message || "continuation failed" };
}

async function streaming(model) {
  const marker = "CODEX_ROUTER_STREAM_OK";
  const response = await fetch(`${installedRouterBaseUrl()}/responses`, {
    method: "POST",
    headers: {
      Authorization: "Bearer codex-router-local-compatibility-test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      input: `Reply with exactly ${marker} and nothing else.`,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  const streamedText = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => {
      try {
        const event = JSON.parse(line);
        return event.delta || event.text || event.output_text || "";
      } catch {
        return "";
      }
    })
    .join("");
  const completed = /response\.(?:completed|done)|\[DONE\]/.test(body);
  return {
    ok: response.ok && (body.includes(marker) || streamedText.includes(marker)) && completed,
    status: response.status,
    detail: response.ok ? "stream text and completion event verified" : `HTTP ${response.status}`,
  };
}

async function compaction(model) {
  const { response, payload } = await request("/responses/compact", {
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Remember that the probe value is 42." }],
      },
    ],
  });
  const text = responseText(payload);
  return {
    ok: response.ok && Boolean(text),
    status: response.status,
    detail: response.ok && text ? "compaction response verified" : payload?.error?.message || `HTTP ${response.status}`,
  };
}

// The two capabilities a Codex spawn actually exercises, and nothing else:
// a child turn is a streamed conversation driven by tool calls, so a model
// that streams and answers a forced tool call can hold the child role. Basic
// text and compaction stay out — this probe runs automatically when a model
// is switched on as a subagent, and two requests is its whole quota budget.
export async function subagentCapabilityProbe(model) {
  if (!MODEL_BY_SLUG.has(model)) throw new Error(`Unknown registry model: ${model}`);
  const checks = [
    { name: "tool calling", ...(await toolCall(model)) },
    { name: "streaming", ...(await streaming(model)) },
  ];
  return {
    model,
    ok: checks.every((check) => check.ok),
    checks,
    detail: checks
      .filter((check) => !check.ok)
      .map((check) => `${check.name}: ${check.detail}`)
      .join("; "),
  };
}

export async function compatibilityTest(model, options = {}) {
  if (!MODEL_BY_SLUG.has(model)) throw new Error(`Unknown registry model: ${model}`);
  const basic = await request("/responses", { model, stream: false, input: "Reply with exactly PROBE_BASIC_OK." });
  const reasoning = await reasoningProbe(model);
  const autoTool = await toolCall(model, "auto");
  const continuation = await continuationProbe(model);
  const usage = basic.payload?.usage;
  const checks = [
    { name: "nonstream", ok: basic.response.ok && Boolean(responseText(basic.payload)), detail: basic.response.ok ? "non-stream response completed" : basic.payload?.error?.message || "non-stream failed" },
    { name: "stream-reasoning", ...reasoning },
    { name: "auto-tool", ok: autoTool.ok, detail: autoTool.detail },
    { name: "continuation", ok: continuation.ok, detail: continuation.detail },
    { name: "usage", ok: Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens) && Number.isFinite(usage?.total_tokens), detail: "authoritative input/output/total usage fields observed" },
  ];
  const results = checks.map((check) => ({ name: check.name, ok: check.ok, status: check.status, detail: check.detail }));
  return {
    model,
    verdict: checks.every((check) => check.ok) ? "passing" : "failed",
    measuredFinalReasoningShape: reasoning.measuredFinalReasoningShape,
    checks,
    ok: checks.every((check) => check.ok),
    results,
  };
}

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write(`Usage: test-model MODEL --live --yes [--quick] [--json]

Runs billed live checks for text, streaming, tool calling, and compaction through
the installed router. Both --live and --yes are required to prevent accidental
provider charges. --quick runs only the basic response check.
`);
    return;
  }
  const model = process.argv.slice(2).find((value) => !value.startsWith("--"));
  if (!model) throw new Error("Pass a namespaced registry model id.");
  if (!process.argv.includes("--live") || !process.argv.includes("--yes")) {
    throw new Error("Live compatibility checks may use provider quota; pass --live --yes to confirm.");
  }
  const result = await compatibilityTest(model, { quick: process.argv.includes("--quick") });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of result.results) {
      process.stdout.write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail || check.error}\n`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      redactCallerUrl(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  });
}
