import { dispatchProtocolProbe } from "../../src/provider-dispatch.mjs";

const model = {
  slug: "fixture/glm-messages-process",
  provider: "fixture",
  upstreamModel: "glm-5.2",
  baseUrl: "http://127.0.0.1:9999/v1",
  effectiveTransport: "anthropic-messages",
  toolDialect: "responses-functions",
  requestProfile: "glm-thinking",
  reasoningDisplayMode: "summary-compat",
  effectiveFinalReasoningShape: "anthropic-thinking",
};

function anthropicSse(events) {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

const firstBody = anthropicSse([
  { type: "message_start", message: { id: "msg_basic", model: "glm-5.2", usage: { input_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "PROBE_BASIC_OK" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]);

let fetches = 0;
let cancels = 0;
const evidence = await dispatchProtocolProbe(model, {
  retry: false,
  failover: false,
  confirmed: true,
  baseUrl: model.baseUrl,
  credential: "proof-secret",
  internalKey: "proof-internal-key-with-sufficient-length",
  timeoutMs: 30,
  fetchImpl: async () => {
    fetches += 1;
    if (fetches === 1) {
      return new Response(firstBody, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('data: {"type":"message_start"}\n\n', "utf8"));
      },
      cancel() {
        cancels += 1;
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  },
});

const errorCode = evidence.checks.find((check) => check.name === "stream-reasoning")?.observed?.errorCode;
process.stdout.write(`${JSON.stringify({ survived: true, verdict: evidence.verdict, cancels, fetches, errorCode })}\n`);
