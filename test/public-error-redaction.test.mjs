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

test("redactor removes every sensitive diagnostic source while preserving safe fields", () => {
  const value = {
    safe: { status: 503, requestId: "req_safe", retryAfter: "12" },
    ...DECOYS,
    authorization: `Bearer ${DECOYS.bearer}`,
    api_key: DECOYS.apiKey,
    nested: { prompt: DECOYS.prompt, providerBody: DECOYS.providerBody },
  };

  const redacted = redactSensitive(value);
  assert.deepEqual(redacted.safe, value.safe);
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
