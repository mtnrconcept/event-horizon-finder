import { Link, useRouterState } from "@tanstack/react-router";
import {
  Calendar,
  CircleHelp,
  Compass,
  Heart,
  Map as MapIcon,
  Rss,
  Settings,
  User,
} from "lucide-react";
import { BrandLogo } from "@/components/brand/brand-logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { useTranslation, type TranslationKey } from "@/lib/i18n";

const mobileItems = [
  { to: "/", labelKey: "nav.discover", icon: Compass },
  { to: "/map", labelKey: "nav.map", icon: MapIcon },
  { to: "/agenda", labelKey: "nav.agenda", icon: Calendar },
  { to: "/social", labelKey: "nav.feed", icon: Rss },
  { to: "/profile", labelKey: "nav.profile", icon: User },
] as const;

const desktopItems = [
  { to: "/", labelKey: "nav.discover", icon: Compass },
  { to: "/map", labelKey: "nav.map", icon: MapIcon },
  { to: "/social", labelKey: "nav.feed", icon: Rss },
  { to: "/agenda", labelKey: "nav.agenda", icon: Calendar },
  { to: "/favorites", labelKey: "nav.favorites", icon: Heart },
  { to: "/profile", labelKey: "nav.profile", icon: User },
] as const;

export function MobileNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("nav.main")}
      className="glass fixed bottom-0 left-0 right-0 z-40 flex items-stretch justify-around border-t px-1 pb-[env(safe-area-inset-bottom)] pt-1.5 md:hidden"
    >
      {mobileItems.map(({ to, labelKey, icon: Icon }) => {
        const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
        return (
          <Link
            key={to}
            to={to}
            className="flex min-h-11 min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-[10px] font-medium transition-colors"
            style={{ color: active ? "var(--color-primary)" : "var(--color-muted-foreground)" }}
          >
            <Icon className="h-5 w-5" strokeWidth={active ? 2.4 : 1.8} />
            <span className="truncate">{t(labelKey as TranslationKey)}</span>
          </Link>
        );
      })}
      <div className="flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1">
        <LanguageSwitcher compact />
        <span className="text-[10px] font-medium text-muted-foreground">{t("nav.language")}</span>
      </div>
    </nav>
  );
}

export function DesktopHeader() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { t, tr } = useTranslation();
  return (
    <header className="glass sticky top-0 z-40 hidden border-b md:block">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-6 py-2.5 lg:gap-8">
        <Link
          to="/"
          aria-label={t("brand.home")}
          className="group flex shrink-0 items-center gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span className="relative grid h-11 w-12 place-items-center overflow-visible">
            <span className="absolute inset-1 rounded-full bg-primary/15 opacity-0 blur-lg transition-opacity group-hover:opacity-100" />
            <BrandLogo variant="mark" className="relative h-10 w-11" />
          </span>
          <span className="hidden leading-none lg:block">
            <span className="block text-sm font-black tracking-[0.18em] text-foreground">
              GLOBAL PARTY
            </span>
            <span className="mt-1 block text-[8px] font-semibold uppercase tracking-[0.27em] text-muted-foreground">
              Clubbing &amp; Festivals
            </span>
          </span>
        </Link>
        <nav className="flex min-w-0 items-center gap-1">
          {desktopItems.map(({ to, labelKey, icon: Icon }) => {
            const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
                style={{ color: active ? "var(--color-primary)" : "var(--color-foreground)" }}
              >
                <Icon className="h-4 w-4" />
                {t(labelKey as TranslationKey)}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1">
          <Link
            to="/help"
            aria-label={tr("Centre d’aide")}
            title={tr("Centre d’aide")}
            className={`grid h-10 w-10 place-items-center rounded-full transition hover:bg-accent ${pathname.startsWith("/help") || pathname.startsWith("/faq") ? "text-primary" : "text-muted-foreground"}`}
          >
            <CircleHelp className="h-5 w-5" />
          </Link>
          <Link
            to="/settings"
            aria-label={tr("Paramètres")}
            title={tr("Paramètres")}
            className={`grid h-10 w-10 place-items-center rounded-full transition hover:bg-accent ${pathname.startsWith("/settings") ? "text-primary" : "text-muted-foreground"}`}
          >
            <Settings className="h-5 w-5" />
          </Link>
          <LanguageSwitcher />
        </div>
      </div>
    </header>
  );
}
