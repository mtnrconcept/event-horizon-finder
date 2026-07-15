import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { handleMcpRequest } from "@/lib/mcp-server";

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      GET: ({ request }) => handleMcpRequest(request),
      POST: ({ request }) => handleMcpRequest(request),
      OPTIONS: ({ request }) => handleMcpRequest(request),
    },
  },
});
