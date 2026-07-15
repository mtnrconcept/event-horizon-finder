import assert from "node:assert/strict";
import test from "node:test";

import { handleMcpRequest, TOOLS } from "../src/lib/mcp-server.ts";

test("MCP exposes standard read-only search and fetch tools", () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, ["search", "fetch", "discover_events"]);

  for (const name of ["search", "fetch"] as const) {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
  }
});

test("MCP initialize negotiates a supported protocol version", async () => {
  const response = await handleMcpRequest(
    new Request("https://eventa.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    }),
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    result: { protocolVersion: string; serverInfo: { name: string } };
  };
  assert.equal(payload.result.protocolVersion, "2024-11-05");
  assert.equal(payload.result.serverInfo.name, "eventa");
});

test("MCP tools/list returns the complete descriptor surface", async () => {
  const response = await handleMcpRequest(
    new Request("https://eventa.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
    }),
  );
  const payload = (await response.json()) as { result: { tools: typeof TOOLS } };
  assert.deepEqual(
    payload.result.tools.map((tool) => tool.name),
    ["search", "fetch", "discover_events"],
  );
});

test("MCP notifications are accepted without a response body", async () => {
  const response = await handleMcpRequest(
    new Request("https://eventa.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }),
  );
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
});
