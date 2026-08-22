import assert from "node:assert/strict";
import test from "node:test";

import {
  failedResponseEvent,
  formatTerminalFrames,
  incompleteResponseEvent,
  routerError,
} from "../src/public-error.mjs";
import { redactSensitive } from "../src/sensitive-redactor.mjs";

const DECOYS = {
  apiKey: "task1-api-key-decoy-31c7e33b",
  bearer: "task1-bearer-decoy-5460ccfe",
  callerUrl: "http://127.0.0.1:4202/_codex-router/task1-caller-decoy-343926ec/v1",
  prompt: "task1-prompt-decoy-e1ff42a8",
  reasoning: "task1-reasoning-decoy-46ec0703",
  arguments: "task1-arguments-decoy-a5b6a7bb",
  providerBody: "task1-provider-body-decoy-d03ce6af",
  cause: "task1-cause-decoy-d8aee149",
  log: "task1-log-decoy-0140dc95",
  snapshot: "task1-snapshot-decoy-2a694cf1",
  temporary: "task1-temp-decoy-fb57466d",
  support: "task1-support-decoy-7222383a",
};

const SERIALIZED_DECOYS = Object.values(DECOYS);

function assertNoDecoys(value) {
  const serialized = JSON.stringify(value);
  for (const decoy of SERIALIZED_DECOYS) assert.doesNotMatch(serialized, new RegExp(decoy));
}

test("pre-stream errors expose only the safe envelope", () => {
  const error = routerError("tool_mapping_error", {
    ...DECOYS,
    headers: { authorization: `Bearer ${DECOYS.bearer}` },
  });

  assert.deepEqual(error.body, {
    error: {
      type: "router_error",
      code: "tool_mapping_error",
      message: "Invalid tool mapping.",
      param: null,
    },
  });
  assert.equal(error.status, 422);
  assertNoDecoys(error);
});

test("trusted public errors cannot be mutated or forged into terminal frames", () => {
  const trusted = routerError("tool_mapping_error", { providerBody: DECOYS.providerBody });
  assert.throws(() => {
    trusted.body.error.message = DECOYS.providerBody;
  }, TypeError);

  assert.throws(
    () => failedResponseEvent(
      { sequenceNumber: 1, responseId: "resp_safe", createdAt: 0, model: "canonical/slug" },
      {
        status: 422,
        body: { error: { code: "tool_mapping_error", message: DECOYS.providerBody } },
      },
    ),
    /trusted router public error/,
  );

  const event = failedResponseEvent(
    { sequenceNumber: 1, responseId: "resp_safe", createdAt: 0, model: "canonical/slug" },
    trusted,
  );
  assert.equal(event.sequence_number, 1);
  assert.equal(event.response.error.message, "Invalid tool mapping.");
  assert.throws(() => {
    event.response.error.message = DECOYS.providerBody;
  }, TypeError);
  assertNoDecoys(event);
});

test("redactor removes every sensitive diagnostic source while preserving safe fields", () => {
  const value = {
    status: 503,
    requestId: "req_safe",
    retryAfter: "12",
    ...DECOYS,
    authorization: `Bearer ${DECOYS.bearer}`,
    api_key: DECOYS.apiKey,
    nested: { prompt: DECOYS.prompt, providerBody: DECOYS.providerBody },
  };

  const redacted = redactSensitive(value);
  assert.deepEqual(redacted, { status: 503, requestId: "req_safe", retryAfter: "12" });
  assertNoDecoys(redacted);
});

test("redactor retains only explicitly safe diagnostic fields and is cycle-safe", () => {
  const decoy = "task1-redactor-bypass-decoy-05870213";
  const diagnostic = {
    status: 503,
    code: "upstream_unavailable",
    type: "server_error",
    requestId: "req_safe",
    headers: {
      "x-request-id": "req_header_safe",
      "retry-after": "12",
      authorization: `Bearer ${decoy}`,
    },
    input: decoy,
    content: decoy,
    text: decoy,
    cookie: decoy,
    session: decoy,
  };
  diagnostic.self = diagnostic;

  assert.deepEqual(redactSensitive(diagnostic), {
    status: 503,
    code: "upstream_unavailable",
    type: "server_error",
    requestId: "req_safe",
    headers: { "x-request-id": "req_header_safe", "retry-after": "12" },
  });
  assertNoDecoys(redactSensitive(new Error(decoy, { cause: new Error(decoy) })));
});

test("redactor removes decoys from diagnostic output, snapshots, temp files, and cause chains", () => {
  const channels = {
    stdout: DECOYS.log,
    stderr: DECOYS.providerBody,
    logs: [DECOYS.prompt, DECOYS.reasoning],
    jsonSnapshot: { input: DECOYS.arguments, content: DECOYS.providerBody },
    tempFiles: [{ path: DECOYS.temporary, text: DECOYS.support }],
    error: new Error(DECOYS.cause, { cause: new Error(DECOYS.providerBody) }),
  };
  const redacted = redactSensitive(channels);
  assert.deepEqual(redacted, {});
  assertNoDecoys(redacted);
});

test("post-relay failures use one safe terminal frame followed by one done frame", () => {
  const event = failedResponseEvent(
    {
      sequenceNumber: 17,
      responseId: "resp_req_safe",
      createdAt: 0,
      model: "canonical/slug",
      output: [{ type: "message", id: "msg_safe" }],
      usage: { input_tokens: 7, output_tokens: 3 },
    },
    routerError("upstream_stream_truncated", DECOYS),
  );

  assert.deepEqual(event, {
    type: "response.failed",
    sequence_number: 17,
    response: {
      id: "resp_req_safe",
      object: "response",
      created_at: 0,
      status: "failed",
      model: "canonical/slug",
      output: [{ type: "message", id: "msg_safe" }],
      error: { code: "upstream_stream_truncated", message: "Upstream stream ended early." },
      incomplete_details: null,
      usage: { input_tokens: 7, output_tokens: 3 },
    },
  });
  assertNoDecoys(event);
  assert.equal(
    formatTerminalFrames(event),
    `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
  );
  const frames = formatTerminalFrames(event);
  assert.equal((frames.match(/data: \[DONE\]/g) || []).length, 1);
  assert.ok(frames.indexOf('"type":"response.failed"') < frames.indexOf("data: [DONE]"));
  assert.throws(
    () => formatTerminalFrames({
      type: "response.failed",
      sequence_number: 18,
      response: { error: { code: "upstream_stream_truncated", message: DECOYS.providerBody } },
    }),
    /trusted terminal event/,
  );
});

test("incomplete terminal retains only the authoritative reason", () => {
  const event = incompleteResponseEvent(
    { sequenceNumber: 18, responseId: "resp_req_safe", createdAt: 0, model: "canonical/slug" },
    "max_output_tokens",
  );

  assert.deepEqual(event, {
    type: "response.incomplete",
    sequence_number: 18,
    response: {
      id: "resp_req_safe",
      object: "response",
      created_at: 0,
      status: "incomplete",
      model: "canonical/slug",
      output: [],
      error: null,
      incomplete_details: { reason: "max_output_tokens" },
      usage: null,
    },
  });
});

test("incomplete terminals reject unrecognized or sensitive reasons", () => {
  const context = { sequenceNumber: 19, responseId: "resp_req_safe", createdAt: 0, model: "canonical/slug" };
  assert.throws(() => incompleteResponseEvent(context, "context_length_exceeded"), /unsupported incomplete reason/);
  assert.throws(() => incompleteResponseEvent(context, DECOYS.reasoning), /unsupported incomplete reason/);
});

test("non-stream JSON never carries a done frame", () => {
  assert.doesNotMatch(JSON.stringify(routerError("tool_mapping_error")), /\[DONE\]/);
});
