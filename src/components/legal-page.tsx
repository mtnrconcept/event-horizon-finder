import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowUp, CalendarDays, FileText, ShieldCheck } from "lucide-react";
import { useMemo } from "react";
import type { LegalDocument } from "@/lib/legal-content";
import { useTranslation } from "@/lib/i18n";

export function LegalPage({ document }: { document: LegalDocument }) {
  const { tr } = useTranslation();
  const links = useMemo(
    () => document.sections.map((section) => ({ id: section.id, title: section.title })),
    [document.sections],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-7 md:px-6 md:pt-10">
      <header className="relative overflow-hidden rounded-[2rem] border p-6 sm:p-9">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_10%_10%,oklch(0.68_0.22_295_/_0.26),transparent_34%),radial-gradient(circle_at_90%_10%,oklch(0.72_0.18_35_/_0.16),transparent_32%),linear-gradient(145deg,oklch(0.19_0.03_265_/_0.97),oklch(0.12_0.03_265_/_0.95))]" />
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
          <ShieldCheck className="h-3.5 w-3.5" /> {tr("Information juridique")}
        </div>
        <h1 className="mt-4 max-w-4xl text-3xl font-black tracking-tight sm:text-5xl">
          {tr(document.title)}
        </h1>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          {tr(document.summary)}
        </p>
        <div className="mt-5 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5">
            <CalendarDays className="h-3.5 w-3.5" /> {tr("Date d’effet")} : {document.effectiveDate}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5">
            <FileText className="h-3.5 w-3.5" /> {tr("Version")} : {document.version}
          </span>
        </div>
      </header>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="glass sticky top-24 hidden max-h-[calc(100vh-7rem)] overflow-y-auto rounded-3xl p-4 lg:block">
          <p className="px-2 pb-3 text-xs font-black uppercase tracking-wider text-muted-foreground">
            {tr("Sommaire")}
          </p>
          <nav aria-label={tr("Sommaire du document")} className="space-y-1">
            {links.map((link) => (
              <a
                key={link.id}
                href={`#${link.id}`}
                className="block rounded-xl px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                {tr(link.title)}
              </a>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          <div className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div>
              <p className="font-bold text-foreground">
                {tr("Validation juridique requise avant lancement commercial")}
              </p>
              <p className="mt-1 leading-relaxed text-muted-foreground">
                {tr(document.reviewNotice)}
              </p>
            </div>
          </div>

          <div className="glass rounded-3xl px-5 py-2 sm:px-8">
            {document.sections.map((section) => (
              <section
                key={section.id}
                id={section.id}
                className="scroll-mt-28 border-b py-7 last:border-b-0"
              >
                <h2 className="text-xl font-black sm:text-2xl">{tr(section.title)}</h2>
                {section.paragraphs?.map((paragraph, index) => (
                  <p
                    key={index}
                    className="mt-4 text-sm leading-7 text-muted-foreground sm:text-[15px]"
                  >
                    {tr(paragraph)}
                  </p>
                ))}
                {section.bullets && (
                  <ul className="mt-4 space-y-3">
                    {section.bullets.map((item, index) => (
                      <li
                        key={index}
                        className="flex gap-3 text-sm leading-7 text-muted-foreground sm:text-[15px]"
                      >
                        <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        <span>{tr(item)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4">
            <div>
              <p className="font-bold">{tr("Une question sur ce document ?")}</p>
              <p className="text-xs text-muted-foreground">
                {tr("Le centre d’aide centralise les demandes et leur suivi.")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/help"
                className="rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground"
              >
                {tr("Centre d’aide")}
              </Link>
              <a
                href="#top"
                className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold hover:bg-accent"
              >
                <ArrowUp className="h-4 w-4" /> {tr("Haut de page")}
              </a>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
