import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callerBaseUrl } from "../src/caller-auth.mjs";
import { PROVIDERS } from "../src/model-registry.mjs";

// End-to-end proof of the namespace relay through the REAL router: a routed
// request carrying the client's namespace toolset must reach the (mock)
// gateway with every namespace flattened into plain functions -- including the
// MCP namespaces (mcp__node_repl__js and friends) that LiteLLM's bridge drops
// when left as namespace entries -- and function calls streaming back must be
// restored to the client's native { name, namespace } shape. The router must
// not execute any app tool itself. The whole scenario runs twice and must
// produce byte-identical outgoing and incoming bodies (determinism).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";

function routerBase(port) {
  return callerBaseUrl(port, CALLER_KEY);
}

function json(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function mockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return { server, port: address.port };
}

function run(script, env) {
  const stateIsolation =
    env?.MODEL_ROUTER_STATE_DIR || env?.CODEX_ROUTER_STATE_DIR
      ? {}
      : { MODEL_ROUTER_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), "relay-routing-state-")) };
  const childEnv = {
    ...process.env,
    ...stateIsolation,
    CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    CODEX_ROUTER_SHOW_ALL_MODELS: "1",
    ...env,
  };
  if (script === "router.mjs" && childEnv.CODEX_ROUTER_GATEWAY_BASE_URL) {
    childEnv.CODEX_ROUTER_TEST_NODE_ROUTE_FIXTURE = "1";
    for (const provider of PROVIDERS.values()) {
      if (provider.baseUrlEnv) childEnv[provider.baseUrlEnv] ||= childEnv.CODEX_ROUTER_GATEWAY_BASE_URL;
      for (const name of provider.credential?.environment || []) childEnv[name] ||= INTERNAL_KEY;
    }
  }
  const child = spawn(process.execPath, [path.join(root, "src", script)], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.testErrors = () => errors;
  return child;
}

async function waitFor(url, child, headers = {}) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Child exited early (${child.exitCode}): ${child.testErrors()}`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // The child has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${child.testErrors()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

// The namespace inventory the Codex client actually sends on routed requests
// (captured live): plain tools, collaboration, a reduced codex_app, and MCP
// namespaces -- including mcp__node_repl, the in-app browser / computer-use
// runtime, and a server whose namespace name contains the delimiter.
function routedRequestPayload(stream = true, model = "opencode-go/deepseek-v4-flash") {
  return {
    model,
    stream,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "call_hist",
        arguments: "{}",
      },
      { type: "function_call_output", call_id: "call_hist", output: "{}" },
    ],
    tools: [
      {
        type: "tool_search",
        execution: "client",
        description: "Search deferred tools.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      { type: "function", name: "exec_command" },
      { type: "function", name: "view_image" },
      {
        type: "namespace",
        name: "collaboration",
        tools: [
          { type: "function", name: "spawn_agent" },
          { type: "function", name: "wait_agent" },
        ],
      },
      {
        type: "namespace",
        name: "codex_app",
        tools: [
          { type: "function", name: "load_workspace_dependencies" },
          { type: "function", name: "navigate_to_codex_page" },
          { type: "function", name: "read_thread_terminal" },
          { type: "function", name: "create_thread" },
          { type: "function", name: "send_message_to_thread" },
        ],
      },
      {
        type: "namespace",
        name: "mcp__node_repl",
        tools: [
          { type: "function", name: "js" },
          { type: "function", name: "js_reset" },
        ],
      },
      {
        type: "namespace",
        name: "mcp__codex_apps__github",
        tools: [
          {
            type: "function",
            name: "fetch_issue",
            inputSchema: {
              type: "object",
              properties: {
                owner: { type: "string" },
                repo: { type: "string" },
                issue_number: { type: "integer", minimum: 1 },
              },
              required: ["owner", "repo", "issue_number"],
              additionalProperties: false,
            },
          },
        ],
      },
    ],
  };
}

function routedToolSearchHistoryPayload(
  stream = true,
  model = "opencode-go/deepseek-v4-flash",
) {
  const payload = routedRequestPayload(stream, model);
  payload.tools.push({
    type: "function",
    name: "mcp__calendar__create_event",
    description: "Current live schema.",
    parameters: {
      type: "object",
      properties: { live: { type: "boolean" } },
    },
  });
  payload.input.push(
    {
      type: "tool_search_call",
      call_id: "search-history-1",
      execution: "client",
      arguments: { query: "calendar", limit: 2 },
    },
    {
      type: "tool_search_call",
      call_id: "search-history-2",
      execution: "client",
      arguments: { query: "mail", limit: 1 },
    },
    {
      type: "tool_search_output",
      call_id: "search-history-1",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__calendar",
          description: "Calendar tools.",
          tools: [
            {
              type: "function",
              name: "create_event",
              parameters: {
                type: "object",
                properties: { stale: { type: "string" } },
              },
            },
            {
              type: "function",
              name: "delete_event",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    },
    {
      type: "tool_search_output",
      call_id: "search-history-2",
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "function",
          name: "list_messages",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
    },
  );
  return payload;
}

function sseEvent(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// The gateway answers with an SSE stream carrying function calls in the
// flattened form a chat-completions bridge would emit, plus one ordinary call.
function gatewaySseBody() {
  return [
    sseEvent({ type: "response.created" }),
    sseEvent({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_thread",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_explicit_thread",
        arguments: JSON.stringify({ model: "gpt-5.6-terra" }),
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__send_message_to_thread",
        call_id: "call_followup",
        arguments: JSON.stringify({ threadId: "thread_1", prompt: "continue" }),
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_cloud_thread",
        arguments: JSON.stringify({
          prompt: "cloud",
          target: { type: "chatgptWorkCloud" },
        }),
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "collaboration__spawn_agent",
        call_id: "call_agent",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec",
        arguments: "{}",
      },
    }),
    sseEvent({
      type: "response.output_item.done",
      item: {
         type: "tool_search_call",
         execution: "client",
         call_id: "call_search",
         arguments: { query: "calendar", limit: 2 },
      },
    }),
    sseEvent({ type: "response.completed", response: { output: [] } }),
    "data: [DONE]\n\n",
  ].join("");
}

function gatewayJsonBody() {
  return {
    id: "resp_json",
    output: [
      {
        type: "function_call",
        name: "mcp__node_repl__js",
        call_id: "call_browser",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_thread",
        arguments: "{}",
      },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_explicit_thread",
        arguments: JSON.stringify({ model: "gpt-5.6-terra" }),
      },
      {
        type: "function_call",
        name: "codex_app__send_message_to_thread",
        call_id: "call_followup",
        arguments: JSON.stringify({ threadId: "thread_1", prompt: "continue" }),
      },
      {
        type: "function_call",
        name: "codex_app__create_thread",
        call_id: "call_cloud_thread",
        arguments: JSON.stringify({
          prompt: "cloud",
          target: { type: "chatgptWorkCloud" },
        }),
      },
      {
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec",
        arguments: "{}",
      },
      {
        type: "tool_search_call",
        execution: "client",
        call_id: "call_search",
        arguments: { query: "calendar", limit: 2 },
      },
    ],
  };
}

function responsesProviderSseBody() {
  return [
    sseEvent({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "call_native_thread",
        arguments: JSON.stringify({ prompt: "hi", target: { type: "projectless" } }),
      },
    }),
    sseEvent({ type: "response.completed", response: { output: [] } }),
    "data: [DONE]\n\n",
  ].join("");
}

function responsesProviderJsonBody() {
  return {
    id: "resp_native_json",
    output: [
      {
        type: "function_call",
        name: "create_thread",
        namespace: "codex_app",
        call_id: "call_native_thread",
        arguments: JSON.stringify({ prompt: "hi", target: { type: "projectless" } }),
      },
    ],
  };
}

function responseItemsFromSse(body) {
  const items = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.item) items.push(event.item);
  }
  return items;
}

function functionCallsFromSse(body) {
  const calls = new Map();
  for (const item of responseItemsFromSse(body)) {
    if (item?.type === "function_call") calls.set(item.call_id, item);
  }
  return calls;
}

async function scenario(
  stream = true,
  {
    model = "zai-api/glm-5.2",
    sseBody = gatewaySseBody,
    jsonBody = gatewayJsonBody,
    requestPayload = routedRequestPayload,
  } = {},
) {
  const gatewayBodies = [];
  const gateway = await mockServer(async (request, response) => {
    if (request.url === "/v1/responses") {
      const gatewayBody = await bodyJson(request);
      gatewayBodies.push(gatewayBody);
      if (gatewayBody.stream === false) {
        json(response, 200, jsonBody());
        return;
      }
      const body = Buffer.from(sseBody(), "utf8");
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Content-Length": String(body.length),
      });
      response.end(body);
      return;
    }
    json(response, 404, { error: { message: `unexpected ${request.url}` } });
  });
  const routerPort = await openPort();
  const router = run("router.mjs", {
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
    CODEX_ROUTER_QUIET: "1",
  });
  try {
    await waitFor(`${routerBase(routerPort)}/models`, router);
    const response = await fetch(`${routerBase(routerPort)}/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer CODEX_CALLER_SECRET",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload(stream, model)),
    });
    assert.equal(response.status, 200, `router status ${response.status}`);
    const clientBody = await response.text();
    return { gatewayBodies, clientBody, router };
  } finally {
    await stopChild(router);
    await closeServer(gateway.server);
  }
}

test("routed Node request preserves namespace relay and restores calls to the client", async () => {
  const first = await scenario();
  const second = await scenario();
  // Determinism: two identical runs produce byte-identical outgoing and
  // incoming bodies.
  assert.equal(second.gatewayBodies.length, 1);
  assert.deepEqual(second.gatewayBodies, first.gatewayBodies);
  assert.equal(second.clientBody, first.clientBody);

  const outgoing = first.gatewayBodies[0];
  assert.equal(outgoing.model, "glm-5.2");
  const names = outgoing.tools.filter((tool) => tool?.type === "function").map((tool) => tool.name);

  // The direct Responses route keeps the native namespace and deferred-search
  // declarations intact; it does not use the removed gateway flattening layer.
  assert.ok(outgoing.tools.some((tool) => tool?.type === "namespace" && tool.name === "collaboration"));
  assert.ok(outgoing.tools.some((tool) => tool?.type === "namespace" && tool.name === "mcp__node_repl"));
  assert.ok(outgoing.tools.some((tool) => tool?.type === "namespace" && tool.name === "mcp__codex_apps__github"));
  assert.ok(names.includes("exec_command"), "plain tools untouched");
  const toolSearch = outgoing.tools.find((tool) => tool?.type === "tool_search");
  assert.ok(toolSearch, "native tool_search stays native");
  assert.deepEqual(toolSearch.parameters.required, ["query"]);
  const codexApp = outgoing.tools.find((tool) => tool?.type === "namespace" && tool.name === "codex_app");
  const createThread = codexApp?.tools.find((tool) => tool.name === "create_thread");
  assert.ok(createThread, "create_thread survives the direct relay");
  const fetchNamespace = outgoing.tools.find((tool) => tool?.type === "namespace" && tool.name === "mcp__codex_apps__github");
  const fetchIssue = fetchNamespace?.tools.find((tool) => tool.name === "fetch_issue");
  assert.deepEqual(fetchIssue?.inputSchema, {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      issue_number: { type: "integer", minimum: 1 },
    },
    required: ["owner", "repo", "issue_number"],
    additionalProperties: false,
  });

  // Stored namespaced calls stay in the native direct Responses shape.
  const historyCall = outgoing.input.find((item) => item?.type === "function_call");
  assert.equal(historyCall.name, "create_thread");
  assert.equal(historyCall.namespace, "codex_app");
  // Historical calls are evidence, not fresh outbound actions. Rewriting
  // their model would change the transcript the provider is meant to see.
  assert.deepEqual(JSON.parse(historyCall.arguments), {});

  // Function calls streaming back are restored to the client's native
  // namespace shape so the app dispatches them itself.
  const calls = functionCallsFromSse(first.clientBody);
  assert.deepEqual(
    { name: calls.get("call_browser").name, namespace: calls.get("call_browser").namespace },
    { name: "js", namespace: "mcp__node_repl" },
  );
  assert.deepEqual(
    { name: calls.get("call_thread").name, namespace: calls.get("call_thread").namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(calls.get("call_thread").arguments), {
    model: "zai-api/glm-5.2",
  });
  assert.deepEqual(JSON.parse(calls.get("call_explicit_thread").arguments), {
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(JSON.parse(calls.get("call_followup").arguments), {
    threadId: "thread_1",
    prompt: "continue",
  });
  assert.deepEqual(JSON.parse(calls.get("call_cloud_thread").arguments), {
    prompt: "cloud",
    target: { type: "chatgptWorkCloud" },
  });
  assert.deepEqual(
    { name: calls.get("call_agent").name, namespace: calls.get("call_agent").namespace },
    { name: "spawn_agent", namespace: "collaboration" },
  );
  // Ordinary calls pass through untouched -- no namespace invented.
  assert.equal(calls.get("call_exec").name, "exec_command");
  assert.equal(calls.get("call_exec").namespace, undefined);
  const searchCall = responseItemsFromSse(first.clientBody).find(
    (item) => item.call_id === "call_search",
  );
  assert.deepEqual(searchCall, {
    type: "tool_search_call",
    call_id: "call_search",
    execution: "client",
    arguments: { query: "calendar", limit: 2 },
  });
  // The router never executed any app tool: the gateway saw exactly one
  // request and the client saw exactly the relayed calls.
  assert.equal(first.gatewayBodies.length, 1);
});

test("non-streaming routed Node responses restore namespace calls before client dispatch", async () => {
  const result = await scenario(false);
  assert.equal(result.gatewayBodies.length, 1);
  assert.equal(result.gatewayBodies[0].stream, false);

  const client = JSON.parse(result.clientBody);
  assert.deepEqual(
    { name: client.output[0].name, namespace: client.output[0].namespace },
    { name: "js", namespace: "mcp__node_repl" },
  );
  assert.deepEqual(
    { name: client.output[1].name, namespace: client.output[1].namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(client.output[1].arguments), {
    model: "zai-api/glm-5.2",
  });
  assert.deepEqual(JSON.parse(client.output[2].arguments), {
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(
    { name: client.output[2].name, namespace: client.output[2].namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(client.output[3].arguments), {
    threadId: "thread_1",
    prompt: "continue",
  });
  assert.deepEqual(
    { name: client.output[3].name, namespace: client.output[3].namespace },
    { name: "send_message_to_thread", namespace: "codex_app" },
  );
  assert.deepEqual(JSON.parse(client.output[4].arguments), {
    prompt: "cloud",
    target: { type: "chatgptWorkCloud" },
  });
  assert.deepEqual(
    { name: client.output[4].name, namespace: client.output[4].namespace },
    { name: "create_thread", namespace: "codex_app" },
  );
  assert.equal(client.output[5].name, "exec_command");
  assert.equal(client.output[5].namespace, undefined);
  assert.deepEqual(client.output[6], {
    type: "tool_search_call",
    call_id: "call_search",
    execution: "client",
    arguments: { query: "calendar", limit: 2 },
  });
});

test("routed Node tool_search history declares discovered tools and restores their calls", async () => {
  const searchedCall = {
    type: "function_call",
    name: "delete_event",
    namespace: "mcp__calendar",
    call_id: "delete-1",
    arguments: JSON.stringify({ id: "evt-1" }),
  };
  const options = {
    requestPayload: routedToolSearchHistoryPayload,
    sseBody: () =>
      [
        sseEvent({ type: "response.output_item.done", item: searchedCall }),
        sseEvent({
          type: "response.completed",
          response: { id: "resp-search", output: [searchedCall] },
        }),
        "data: [DONE]\n\n",
      ].join(""),
    jsonBody: () => ({ id: "resp-search-json", output: [searchedCall] }),
  };

  for (const stream of [true, false]) {
    const result = await scenario(stream, options);
    const outgoing = result.gatewayBodies[0];
    const historyCall = outgoing.input.find(
      (item) => item.call_id === "search-history-1" && item.type === "tool_search_call",
    );
    assert.deepEqual(historyCall, {
      type: "tool_search_call",
      call_id: "search-history-1",
      execution: "client",
      arguments: { query: "calendar", limit: 2 },
    });
    assert.deepEqual(
      outgoing.input.find(
        (item) => item.call_id === "search-history-2" && item.type === "tool_search_call",
      ),
      {
        type: "tool_search_call",
        call_id: "search-history-2",
        execution: "client",
        arguments: { query: "mail", limit: 1 },
      },
    );
    const historyOutput = outgoing.input.find(
      (item) =>
        item.call_id === "search-history-1" && item.type === "tool_search_output",
    );
    assert.deepEqual(
      historyOutput.tools[0].tools.map((tool) => tool.name),
      ["create_event", "delete_event"],
    );
    const secondHistoryOutput = outgoing.input.find(
      (item) =>
        item.call_id === "search-history-2" && item.type === "tool_search_output",
    );
    assert.deepEqual(
      secondHistoryOutput.tools.map((tool) => tool.name),
      ["list_messages"],
    );
    assert.equal(
      outgoing.input.some(
        (item) => item.type === "tool_search_call" || item.type === "tool_search_output",
      ),
      true,
      "native search history stays on the direct Responses route",
    );
    assert.equal(
      outgoing.tools.filter((tool) => tool.name === "mcp__calendar__create_event").length,
      1,
      "live top-level schemas remain visible",
    );
    assert.equal(outgoing.tools.some((tool) => tool.name === "mcp__calendar__delete_event"), false);
    assert.equal(outgoing.tools.some((tool) => tool.name === "list_messages"), false);

    const clientCall = stream
      ? responseItemsFromSse(result.clientBody).find((item) => item.call_id === "delete-1")
      : JSON.parse(result.clientBody).output[0];
    assert.deepEqual(clientCall, {
      type: "function_call",
      name: "delete_event",
      namespace: "mcp__calendar",
      call_id: "delete-1",
      arguments: '{"id":"evt-1"}',
    });
  }
});

test("Node Responses providers inherit the model on fresh local thread calls", async () => {
  const options = {
    model: "zai-api/glm-5.2",
    sseBody: responsesProviderSseBody,
    jsonBody: responsesProviderJsonBody,
    requestPayload: routedToolSearchHistoryPayload,
  };
  const streamed = await scenario(true, options);
  assert.equal(streamed.gatewayBodies[0].model, "glm-5.2");
  assert.ok(
    streamed.gatewayBodies[0].tools.some((tool) => tool?.type === "namespace"),
    "Responses-native tools stay namespaced",
  );
  assert.ok(
    streamed.gatewayBodies[0].tools.some((tool) => tool?.type === "tool_search"),
    "Responses-native tool_search stays native",
  );
  assert.ok(
    streamed.gatewayBodies[0].input.some((item) => item?.type === "tool_search_call"),
    "Responses-native search history is not translated",
  );
  assert.equal(
    streamed.gatewayBodies[0].tools.some((tool) => tool?.name === "list_messages"),
    false,
    "native tool_search_output history remains authoritative without top-level injection",
  );
  const streamedCall = functionCallsFromSse(streamed.clientBody).get("call_native_thread");
  assert.deepEqual(JSON.parse(streamedCall.arguments), {
    prompt: "hi",
    target: { type: "projectless" },
    model: "zai-api/glm-5.2",
  });

  const nonStreaming = await scenario(false, options);
  const nonStreamingCall = JSON.parse(nonStreaming.clientBody).output[0];
  assert.deepEqual(JSON.parse(nonStreamingCall.arguments), {
    prompt: "hi",
    target: { type: "projectless" },
    model: "zai-api/glm-5.2",
  });
});
