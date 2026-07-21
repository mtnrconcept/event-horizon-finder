import { Link } from "@tanstack/react-router";
import { Cookie, FileText, HelpCircle, Settings, ShieldCheck, Sparkles } from "lucide-react";
import { BrandLogo } from "@/components/brand/brand-logo";
import { useTranslation } from "@/lib/i18n";

const footerGroups = [
  {
    title: "Global Party",
    links: [
      { to: "/", label: "Découvrir" },
      { to: "/map", label: "Carte" },
      { to: "/social", label: "Fil d’actualité" },
      { to: "/organizer", label: "Espace organisateur" },
    ],
  },
  {
    title: "Aide",
    links: [
      { to: "/help", label: "Centre d’aide" },
      { to: "/faq", label: "Questions fréquentes" },
      { to: "/settings", label: "Paramètres" },
      { to: "/settings", label: "Sécurité du compte", search: { section: "security" } },
    ],
  },
  {
    title: "Informations légales",
    links: [
      { to: "/terms", label: "Conditions d’utilisation" },
      { to: "/privacy", label: "Politique de confidentialité" },
      { to: "/cookies", label: "Politique de cookies" },
      { to: "/settings", label: "Choix de confidentialité", search: { section: "cookies" } },
    ],
  },
] as const;

export function AppFooter() {
  const { tr } = useTranslation();
  return (
    <footer className="border-t bg-background/70 backdrop-blur">
      <div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 sm:grid-cols-2 md:px-6 lg:grid-cols-[1.2fr_repeat(3,1fr)]">
        <div>
          <Link to="/" className="inline-flex items-center gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <BrandLogo variant="mark" className="h-11 w-12" />
            <span>
              <span className="block text-sm font-black tracking-[0.16em]">GLOBAL PARTY</span>
              <span className="mt-1 block text-[9px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Clubbing &amp; Festivals</span>
            </span>
          </Link>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {tr("Découvre les événements, partage tes sorties et garde le contrôle de tes données depuis un seul espace.")}
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-primary" /> {tr("Confidentialité contrôlable")}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-muted-foreground"><Sparkles className="h-3.5 w-3.5 text-primary" /> {tr("Communauté en direct")}</span>
          </div>
        </div>

        {footerGroups.map((group) => (
          <div key={group.title}>
            <h2 className="text-sm font-black">{tr(group.title)}</h2>
            <nav className="mt-4 space-y-2.5" aria-label={tr(group.title)}>
              {group.links.map((link) => (
                <Link
                  key={`${link.to}-${link.label}`}
                  to={link.to}
                  search={"search" in link ? link.search : undefined}
                  className="block text-sm text-muted-foreground transition hover:text-foreground"
                >
                  {tr(link.label)}
                </Link>
              ))}
            </nav>
          </div>
        ))}
      </div>
      <div className="border-t">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-4 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between md:px-6">
          <p>© {new Date().getFullYear()} Global Party. {tr("Tous droits réservés.")}</p>
          <div className="flex flex-wrap gap-4">
            <Link to="/help" className="inline-flex items-center gap-1.5 hover:text-foreground"><HelpCircle className="h-3.5 w-3.5" /> {tr("Aide")}</Link>
            <Link to="/settings" className="inline-flex items-center gap-1.5 hover:text-foreground"><Settings className="h-3.5 w-3.5" /> {tr("Paramètres")}</Link>
            <Link to="/privacy" className="inline-flex items-center gap-1.5 hover:text-foreground"><FileText className="h-3.5 w-3.5" /> {tr("Confidentialité")}</Link>
            <Link to="/cookies" className="inline-flex items-center gap-1.5 hover:text-foreground"><Cookie className="h-3.5 w-3.5" /> {tr("Cookies")}</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
