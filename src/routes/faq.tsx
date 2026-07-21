/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronDown, HelpCircle, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useTranslation } from "@/lib/i18n";

const faqDb = supabase as unknown as SupabaseClient<any>;

type FaqItem = {
  id: string;
  category: string;
  question: string;
  answer_markdown: string;
  sort_order: number;
};

const FALLBACK_FAQ: FaqItem[] = [
  { id: "account", category: "Compte", question: "Comment modifier mes préférences ?", answer_markdown: "Ouvre **Paramètres** depuis ton profil. Les sections sont enregistrées uniquement lorsque tu appuies sur le bouton d’enregistrement.", sort_order: 10 },
  { id: "event", category: "Événements", question: "Comment enregistrer un événement ?", answer_markdown: "Appuie sur le cœur d’une fiche. L’événement apparaît dans **Favoris** et peut être ajouté à ton agenda.", sort_order: 20 },
  { id: "social", category: "Réseau social", question: "Qui peut voir mes publications ?", answer_markdown: "Chaque publication peut être publique, réservée à tes abonnés ou privée. Les blocages et mises en sourdine sont appliqués au fil.", sort_order: 30 },
  { id: "report", category: "Sécurité", question: "Comment signaler un contenu ?", answer_markdown: "Utilise le menu de la publication ou du commentaire, choisis un motif et ajoute les précisions utiles. Le signalement reste confidentiel.", sort_order: 40 },
  { id: "data", category: "Données", question: "Comment exporter ou supprimer mes données ?", answer_markdown: "La section **Paramètres > Données et compte** permet de créer une demande suivie. Une vérification d’identité peut être nécessaire pour protéger le compte.", sort_order: 50 },
  { id: "cookies", category: "Cookies", question: "Puis-je refuser les cookies non essentiels ?", answer_markdown: "Oui. L’analyse, la personnalisation et la publicité sont facultatives et modifiables à tout moment.", sort_order: 60 },
];

export const Route = createFileRoute("/faq")({
  head: () => ({
    meta: [
      { title: "FAQ — Global Party" },
      { name: "description", content: "Réponses aux questions fréquentes sur Global Party, les événements, le réseau social, la sécurité et les données." },
    ],
  }),
  component: FaqPage,
});

function FaqPage() {
  const { tr } = useTranslation();
  const [items, setItems] = useState<FaqItem[]>(FALLBACK_FAQ);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("Toutes");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await faqDb
        .from("faq_items")
        .select("id,category,question,answer_markdown,sort_order")
        .eq("is_published", true)
        .eq("locale", "fr")
        .order("sort_order", { ascending: true });
      if (!active) return;
      if (!error && data?.length) setItems(data as FaqItem[]);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const categories = useMemo(() => ["Toutes", ...new Set(items.map((item) => item.category))], [items]);
  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (category !== "Toutes" && item.category !== category) return false;
      if (!term) return true;
      return `${item.question} ${item.answer_markdown} ${item.category}`.toLocaleLowerCase().includes(term);
    });
  }, [category, items, query]);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-7 md:px-6 md:pt-10">
      <header className="relative overflow-hidden rounded-[2rem] border px-5 py-9 text-center sm:px-10 sm:py-14">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_10%,oklch(0.68_0.22_295_/_0.28),transparent_35%),radial-gradient(circle_at_85%_20%,oklch(0.72_0.18_35_/_0.18),transparent_30%),linear-gradient(145deg,oklch(0.19_0.03_265_/_0.97),oklch(0.12_0.03_265_/_0.95))]" />
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-bold text-primary"><Sparkles className="h-3.5 w-3.5" /> {tr("Réponses rapides")}</div>
        <h1 className="mt-4 text-4xl font-black sm:text-6xl">{tr("Questions fréquentes")}</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base">{tr("Trouve immédiatement une réponse, puis contacte le centre d’aide lorsque ta situation nécessite un suivi.")}</p>
        <label className="relative mx-auto mt-7 block max-w-2xl text-left">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(event) => setQuery(event.target.value.slice(0, 160))} placeholder={tr("Rechercher une question, un mot ou une fonctionnalité")} className="field-control min-h-14 w-full rounded-full pl-12 pr-12 text-base shadow-xl" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label={tr("Effacer la recherche")} className="absolute right-3 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full hover:bg-accent"><X className="h-4 w-4" /></button>}
        </label>
      </header>

      <div className="no-scrollbar mt-6 flex gap-2 overflow-x-auto pb-2">
        {categories.map((item) => <button key={item} type="button" onClick={() => setCategory(item)} className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold ${category === item ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent"}`}>{tr(item)}</button>)}
      </div>

      <main className="mt-4">
        {loading ? <div className="space-y-3">{[0,1,2,3].map((item) => <div key={item} className="glass h-20 animate-pulse rounded-2xl" />)}</div> : results.length ? <div className="space-y-3">{results.map((item) => <details key={item.id} className="glass group rounded-2xl border border-border/60 open:border-primary/30"><summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 sm:px-5"><HelpCircle className="h-5 w-5 shrink-0 text-primary" /><span className="min-w-0 flex-1 font-bold">{tr(item.question)}</span><ChevronDown className="h-5 w-5 shrink-0 transition group-open:rotate-180" /></summary><div className="border-t px-4 py-4 text-sm leading-7 text-muted-foreground sm:px-5">{renderSimpleMarkdown(tr(item.answer_markdown))}</div></details>)}</div> : <div className="glass rounded-3xl px-5 py-14 text-center"><Search className="mx-auto h-10 w-10 text-primary" /><h2 className="mt-4 text-xl font-black">{tr("Aucune réponse correspondante")}</h2><p className="mt-2 text-sm text-muted-foreground">{tr("Essaie un autre mot ou envoie une demande au centre d’aide.")}</p><button type="button" onClick={() => { setQuery(""); setCategory("Toutes"); }} className="mt-5 rounded-full border px-5 py-2.5 text-sm font-semibold hover:bg-accent">{tr("Réinitialiser")}</button></div>}
      </main>

      <section className="mt-7 flex flex-col items-center justify-between gap-4 rounded-3xl border border-primary/25 bg-primary/5 p-6 text-center sm:flex-row sm:text-left">
        <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-primary" /><div><h2 className="font-black">{tr("Tu n’as pas trouvé ta réponse ?")}</h2><p className="mt-1 text-sm text-muted-foreground">{tr("Crée une demande suivie avec la catégorie et le niveau de priorité appropriés.")}</p></div></div>
        <Link to="/help" className="shrink-0 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground">{tr("Contacter l’aide")}</Link>
      </section>
    </div>
  );
}

function renderSimpleMarkdown(value: string) {
  const parts = value.split(/(\*\*[^*]+\*\*)/g);
  return <p>{parts.map((part, index) => part.startsWith("**") && part.endsWith("**") ? <strong key={index} className="text-foreground">{part.slice(2,-2)}</strong> : <span key={index}>{part}</span>)}</p>;
}
