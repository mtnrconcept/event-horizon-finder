import { Link, useRouterState } from "@tanstack/react-router";
import { Calendar, Compass, Heart, Map as MapIcon, Rss, User } from "lucide-react";

const mobileItems = [
  { to: "/", label: "Découvrir", icon: Compass },
  { to: "/map", label: "Carte", icon: MapIcon },
  { to: "/agenda", label: "Agenda", icon: Calendar },
  { to: "/social", label: "Fil", icon: Rss },
  { to: "/profile", label: "Profil", icon: User },
] as const;

const desktopItems = [
  { to: "/", label: "Découvrir", icon: Compass },
  { to: "/map", label: "Carte", icon: MapIcon },
  { to: "/social", label: "Fil", icon: Rss },
  { to: "/agenda", label: "Agenda", icon: Calendar },
  { to: "/favorites", label: "Favoris", icon: Heart },
  { to: "/profile", label: "Profil", icon: User },
] as const;

export function MobileNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav
      aria-label="Navigation principale"
      className="glass fixed bottom-0 left-0 right-0 z-40 flex items-stretch justify-around border-t px-1 pb-[env(safe-area-inset-bottom)] pt-1.5 md:hidden"
    >
      {mobileItems.map(({ to, label, icon: Icon }) => {
        const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
        return (
          <Link
            key={to}
            to={to}
            className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-2 py-1.5 text-[10px] font-medium transition-colors"
            style={{ color: active ? "var(--color-primary)" : "var(--color-muted-foreground)" }}
          >
            <Icon className="h-5 w-5" strokeWidth={active ? 2.4 : 1.8} />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function DesktopHeader() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <header className="glass sticky top-0 z-40 hidden border-b md:block">
      <div className="mx-auto flex max-w-7xl items-center gap-8 px-6 py-3">
        <Link to="/" className="text-xl font-bold tracking-tight">
          <span className="text-gradient">EVENTA</span>
        </Link>
        <nav className="flex items-center gap-1">
          {desktopItems.map(({ to, label, icon: Icon }) => {
            const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
            return (
              <Link
                key={to}
                to={to}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
                style={{ color: active ? "var(--color-primary)" : "var(--color-foreground)" }}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
