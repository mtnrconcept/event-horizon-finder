import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal-page";
import { PRIVACY_DOCUMENT } from "@/lib/legal-content";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Politique de confidentialité — Global Party" },
      { name: "description", content: PRIVACY_DOCUMENT.summary },
    ],
  }),
  component: () => <LegalPage document={PRIVACY_DOCUMENT} />,
});
