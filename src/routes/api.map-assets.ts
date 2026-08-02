import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

async function handle(request: Request): Promise<Response> {
  const { handleMapAssetProxy } = await import("@/lib/map-asset-proxy.server");
  return handleMapAssetProxy(request);
}

export const Route = createFileRoute("/api/map-assets")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      HEAD: ({ request }) => handle(request),
    },
  },
});
