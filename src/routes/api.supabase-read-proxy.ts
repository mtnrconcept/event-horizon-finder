import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { applyAppCors, handleAppCorsPreflight } from "@/lib/app-cors.server";

async function handle(request: Request): Promise<Response> {
  const { handleSupabaseReadProxy } = await import("@/lib/supabase-read-proxy.server");
  return applyAppCors(request, await handleSupabaseReadProxy(request));
}

export const Route = createFileRoute("/api/supabase-read-proxy")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      HEAD: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
      OPTIONS: ({ request }) => handleAppCorsPreflight(request),
    },
  },
});
