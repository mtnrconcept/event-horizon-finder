import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal-page";
import { COOKIES_DOCUMENT } from "@/lib/legal-content";

export const Route = createFileRoute("/cookies")({
  head: () => ({
    meta: [
      { title: "Politique de cookies — Global Party" },
      { name: "description", content: COOKIES_DOCUMENT.summary },
    ],
  }),
  component: () => <LegalPage document={COOKIES_DOCUMENT} />,
});
