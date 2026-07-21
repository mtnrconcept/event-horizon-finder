import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal-page";
import { TERMS_DOCUMENT } from "@/lib/legal-content";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Conditions générales d’utilisation — Global Party" },
      { name: "description", content: TERMS_DOCUMENT.summary },
    ],
  }),
  component: () => <LegalPage document={TERMS_DOCUMENT} />,
});
