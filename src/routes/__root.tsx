import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { MobileNav, DesktopHeader } from "@/components/nav";
import { ClientConsentBanner } from "@/components/client-consent-banner";
import { ClientJourneyTracker } from "@/components/client-journey-tracker";
import { BrandArrival } from "@/components/brand/brand-arrival";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-gradient text-7xl font-bold">404</h1>
        <p className="mt-4 text-muted-foreground">Cette page n'existe pas.</p>
        <a
          href="/"
          className="btn-glow mt-6 inline-flex rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground"
        >
          Retour à la découverte
        </a>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "root" });
  }, [error]);
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Une erreur s'est produite</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-4 rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          Réessayer
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "theme-color", content: "#1a1830" },
      { title: "Global Party — Découvre les événements autour de toi" },
      {
        name: "description",
        content:
          "Concerts, soirées, festivals, expositions et bien plus. Trouve les meilleurs événements ce soir, ce week-end ou près de toi.",
      },
      { property: "og:title", content: "Global Party — Découvre les événements autour de toi" },
      {
        property: "og:description",
        content: "Découvre en un instant ce qui se passe autour de toi.",
      },
      { property: "og:type", content: "website" },
      {
        property: "og:image",
        content: "https://event-horizon-finder.vercel.app/brand/global-party-logo.png",
      },
      { name: "twitter:card", content: "summary_large_image" },
      {
        name: "twitter:image",
        content: "https://event-horizon-finder.vercel.app/brand/global-party-logo.png",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      {
        rel: "preload",
        href: "/brand/global-party-logo.png",
        as: "image",
        type: "image/png",
      },
      {
        rel: "preload",
        href: "/brand/global-party-intro-poster.jpg",
        as: "image",
        type: "image/jpeg",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "icon", href: "/brand/global-party-logo.png", type: "image/png" },
      // Vercel-protected previews require credentials for manifest requests.
      // Without this, the browser follows the SSO redirect as an anonymous
      // cross-origin fetch and reports a misleading CORS error.
      { rel: "manifest", href: "/manifest.webmanifest", crossOrigin: "use-credentials" },
      { rel: "apple-touch-icon", href: "/brand/global-party-logo.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const isMapRoute = useRouterState({ select: (state) => state.location.pathname === "/map" });
  return (
    <QueryClientProvider client={queryClient}>
      <BrandArrival />
      <ClientJourneyTracker />
      <DesktopHeader />
      <main className={isMapRoute ? "pb-0 md:pb-8" : "pb-24 md:pb-8"}>
        <Outlet />
      </main>
      <MobileNav />
      <ClientConsentBanner />
      <Toaster position="top-center" theme="dark" />
    </QueryClientProvider>
  );
}
