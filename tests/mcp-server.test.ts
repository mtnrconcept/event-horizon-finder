import assert from "node:assert/strict";
import test from "node:test";

import { handleMcpRequest, TOOLS, WIDGET_MIME_TYPE, WIDGET_URI } from "../src/lib/mcp-server.ts";

function rpcRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://eventa.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("MCP exposes the complete read-only ChatGPT tool surface", () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name),
    ["search", "fetch", "discover_events", "upcoming_events", "search_help"],
  );

  for (const tool of TOOLS) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
    assert.deepEqual(tool.securitySchemes, [{ type: "noauth" }]);
  }

  for (const name of ["search", "fetch", "discover_events", "upcoming_events"] as const) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.equal(tool._meta["openai/outputTemplate"], WIDGET_URI);
    assert.equal(tool._meta.ui.resourceUri, WIDGET_URI);
  }
});

test("MCP initialize negotiates a supported protocol and advertises resources", async () => {
  const response = await handleMcpRequest(
    rpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    result: {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: { tools: unknown; resources: unknown };
    };
  };
  assert.equal(payload.result.protocolVersion, "2024-11-05");
  assert.equal(payload.result.serverInfo.name, "global-party");
  assert.equal(payload.result.serverInfo.version, "2.0.0");
  assert.ok(payload.result.capabilities.tools);
  assert.ok(payload.result.capabilities.resources);
});

test("MCP tools/list returns descriptors with ChatGPT metadata", async () => {
  const response = await handleMcpRequest(
    rpcRequest({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { result: { tools: typeof TOOLS } };
  assert.deepEqual(
    payload.result.tools.map((tool) => tool.name),
    ["search", "fetch", "discover_events", "upcoming_events", "search_help"],
  );
  assert.equal(
    payload.result.tools[0]._meta["openai/toolInvocation/invoking"],
    "Recherche des événements…",
  );
});

test("MCP lists and reads the self-contained event widget", async () => {
  const listResponse = await handleMcpRequest(
    rpcRequest({ jsonrpc: "2.0", id: "resources", method: "resources/list" }),
  );
  const listPayload = (await listResponse.json()) as {
    result: { resources: Array<{ uri: string; mimeType: string }> };
  };
  assert.equal(listPayload.result.resources.length, 1);
  assert.equal(listPayload.result.resources[0].uri, WIDGET_URI);
  assert.equal(listPayload.result.resources[0].mimeType, WIDGET_MIME_TYPE);

  const readResponse = await handleMcpRequest(
    rpcRequest({
      jsonrpc: "2.0",
      id: "read",
      method: "resources/read",
      params: { uri: WIDGET_URI },
    }),
  );
  const readPayload = (await readResponse.json()) as {
    result: {
      contents: Array<{
        uri: string;
        mimeType: string;
        text: string;
        _meta: { ui: { prefersBorder: boolean; csp: unknown } };
      }>;
    };
  };
  const resource = readPayload.result.contents[0];
  assert.equal(resource.uri, WIDGET_URI);
  assert.equal(resource.mimeType, WIDGET_MIME_TYPE);
  assert.match(resource.text, /Global Party/);
  assert.match(resource.text, /ui\/notifications\/tool-result/);
  assert.equal(resource._meta.ui.prefersBorder, true);
  assert.ok(resource._meta.ui.csp);
});

test("MCP health endpoint is available with GET and HEAD", async () => {
  const getResponse = await handleMcpRequest(
    new Request("https://eventa.example/mcp", { method: "GET" }),
  );
  assert.equal(getResponse.status, 200);
  const payload = (await getResponse.json()) as {
    status: string;
    version: string;
    tools: string[];
    widget: string;
  };
  assert.equal(payload.status, "ok");
  assert.equal(payload.version, "2.0.0");
  assert.deepEqual(
    payload.tools,
    TOOLS.map((tool) => tool.name),
  );
  assert.equal(payload.widget, WIDGET_URI);

  const headResponse = await handleMcpRequest(
    new Request("https://eventa.example/mcp", { method: "HEAD" }),
  );
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), "");
});

test("MCP rejects malformed and oversized requests", async () => {
  const malformed = await handleMcpRequest(rpcRequest("{not-json"));
  assert.equal(malformed.status, 400);
  const malformedPayload = (await malformed.json()) as { error: { code: number } };
  assert.equal(malformedPayload.error.code, -32700);

  const oversized = await handleMcpRequest(
    new Request("https://eventa.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "1048577",
      },
      body: "{}",
    }),
  );
  assert.equal(oversized.status, 413);
});

test("MCP notifications are accepted without a response body", async () => {
  const response = await handleMcpRequest(
    rpcRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});

test("MCP supports JSON-RPC batches and preserves notification semantics", async () => {
  const response = await handleMcpRequest(
    rpcRequest([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
    ]),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as Array<{ id: number }>;
  assert.deepEqual(
    payload.map((item) => item.id),
    [1, 2],
  );
});
