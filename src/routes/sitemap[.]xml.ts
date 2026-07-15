import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const requestOrigin = new URL(request.url).origin;
        const configuredOrigin = process.env.SITE_URL?.trim().replace(/\/$/, "");
        const baseUrl = configuredOrigin || requestOrigin;
        const entries: { path: string; changefreq?: string; priority?: string }[] = [
          { path: "/", changefreq: "hourly", priority: "1.0" },
          { path: "/map", changefreq: "daily", priority: "0.8" },
          { path: "/agenda", changefreq: "weekly", priority: "0.4" },
        ];
        const { data: events } = await supabase
          .from("events")
          .select("slug,updated_at")
          .eq("status", "published")
          .limit(5000);
        (events ?? []).forEach((e) =>
          entries.push({ path: `/event/${e.slug}`, changefreq: "daily", priority: "0.7" }),
        );

        const urls = entries.map(
          (e) =>
            `  <url><loc>${baseUrl}${e.path}</loc>${e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : ""}${e.priority ? `<priority>${e.priority}</priority>` : ""}</url>`,
        );
        const xml = [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
          ...urls,
          `</urlset>`,
        ].join("\n");
        return new Response(xml, {
          headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
        });
      },
    },
  },
});
