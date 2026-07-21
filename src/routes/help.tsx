/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Cookie,
  FileQuestion,
  HelpCircle,
  LifeBuoy,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Megaphone,
  MessageCircle,
  Rocket,
  Search,
  Send,
  Shield,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useTranslation } from "@/lib/i18n";

const helpDb = supabase as unknown as SupabaseClient<any>;

type HelpCategory = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
};

type HelpArticle = {
  id: string;
  category_id: string | null;
  slug: string;
  title: string;
  excerpt: string | null;
  keywords: string[];
  is_featured: boolean;
};

const FALLBACK_CATEGORIES: HelpCategory[] = [
  { id: "start", slug: "getting-started", title: "Bien démarrer", description: "Créer son compte et personnaliser son expérience.", icon: "rocket", sort_order: 10 },
  { id: "events", slug: "events", title: "Événements", description: "Découvrir, enregistrer, partager et organiser des sorties.", icon: "calendar", sort_order: 20 },
  { id: "social", slug: "social", title: "Réseau social", description: "Publications, commentaires, abonnements et sécurité.", icon: "users", sort_order: 30 },
  { id: "privacy", slug: "privacy", title: "Confidentialité et sécurité", description: "Contrôler ses données, sa visibilité et ses connexions.", icon: "shield", sort_order: 40 },
  { id: "organizers", slug: "organizers", title: "Organisateurs", description: "Publier des événements et animer sa communauté.", icon: "megaphone", sort_order: 50 },
];

const QUICK_LINKS = [
  { title: "Gérer mes paramètres", description: "Confidentialité, notifications et connexions", to: "/settings" as const, icon: CircleUserRound },
  { title: "Questions fréquentes", description: "Réponses rapides classées par thème", to: "/faq" as const, icon: FileQuestion },
  { title: "Sécuriser mon compte", description: "Sessions, mot de passe et accès suspects", to: "/settings" as const, search: { section: "security" }, icon: LockKeyhole },
  { title: "Comprendre les cookies", description: "Catégories et réglages facultatifs", to: "/cookies" as const, icon: Cookie },
];

export const Route = createFileRoute("/help")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Centre d’aide — Global Party" },
      { name: "description", content: "Guides, FAQ et assistance pour utiliser Global Party en toute sécurité." },
    ],
  }),
  component: HelpCenterPage,
});

function HelpCenterPage() {
  const { tr } = useTranslation();
  const search = Route.useSearch();
  const [query, setQuery] = useState(search.q ?? "");
  const [categories, setCategories] = useState<HelpCategory[]>(FALLBACK_CATEGORIES);
  const [articles, setArticles] = useState<HelpArticle[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [category, setCategory] = useState("general");
  const [priority, setPriority] = useState("normal");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTicket, setSentTicket] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [{ data: authData }, categoryResult, articleResult] = await Promise.all([
        helpDb.auth.getUser(),
        helpDb.from("help_categories").select("id,slug,title,description,icon,sort_order").eq("is_published", true).order("sort_order"),
        helpDb.from("help_articles").select("id,category_id,slug,title,excerpt,keywords,is_featured").eq("is_published", true).eq("locale", "fr").order("is_featured", { ascending: false }).limit(100),
      ]);
      if (!active) return;
      setUserId(authData.user?.id ?? null);
      if (!categoryResult.error && categoryResult.data?.length) setCategories(categoryResult.data as HelpCategory[]);
      if (!articleResult.error) setArticles((articleResult.data ?? []) as HelpArticle[]);
      setLoading(false);
    })();
    const { data } = helpDb.auth.onAuthStateChange((_event, session) => setUserId(session?.user?.id ?? null));
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);

  const matches = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return articles.filter((article) => article.is_featured).slice(0, 8);
    return articles.filter((article) => `${article.title} ${article.excerpt ?? ""} ${(article.keywords ?? []).join(" ")}`.toLocaleLowerCase().includes(term)).slice(0, 20);
  }, [articles, query]);

  const openSupport = () => {
    if (!userId) {
      toast.error(tr("Connecte-toi pour créer et suivre une demande."));
      return;
    }
    setFormOpen(true);
    setSentTicket(null);
  };

  const sendTicket = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userId || sending) return;
    const cleanSubject = subject.trim().slice(0, 160);
    const cleanMessage = message.trim().slice(0, 5_000);
    if (cleanSubject.length < 5 || cleanMessage.length < 20) {
      toast.error(tr("Décris la demande avec un objet et au moins 20 caractères."));
      return;
    }
    setSending(true);
    const { data, error } = await helpDb.from("support_tickets").insert({
      user_id: userId,
      category,
      priority,
      subject: cleanSubject,
      message: cleanMessage,
    }).select("id").single();
    setSending(false);
    if (error) {
      console.error("[help] support ticket failed", error);
      toast.error(tr("La demande n’a pas pu être envoyée."));
      return;
    }
    setSentTicket(String(data.id).slice(0, 8).toUpperCase());
    setSubject("");
    setMessage("");
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-7 md:px-6 md:pt-10">
      <header className="relative overflow-hidden rounded-[2.2rem] border px-5 py-10 text-center sm:px-10 sm:py-16">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_15%_10%,oklch(0.68_0.22_295_/_0.3),transparent_35%),radial-gradient(circle_at_88%_22%,oklch(0.72_0.18_35_/_0.2),transparent_30%),linear-gradient(145deg,oklch(0.19_0.03_265_/_0.97),oklch(0.12_0.03_265_/_0.95))]" />
        <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-bold text-primary"><LifeBuoy className="h-3.5 w-3.5" /> {tr("Aide et assistance")}</div>
        <h1 className="mt-4 text-4xl font-black sm:text-6xl">{tr("Comment pouvons-nous t’aider ?")}</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base">{tr("Recherche un guide, consulte la FAQ ou crée une demande suivie depuis ton compte.")}</p>
        <label className="relative mx-auto mt-7 block max-w-2xl text-left">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(event) => setQuery(event.target.value.slice(0, 180))} placeholder={tr("Ex. publier un événement, compte privé, supprimer mes données…")} className="field-control min-h-14 w-full rounded-full pl-12 pr-12 text-base shadow-xl" />
          {query && <button type="button" onClick={() => setQuery("")} aria-label={tr("Effacer la recherche")} className="absolute right-3 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full hover:bg-accent"><X className="h-4 w-4" /></button>}
        </label>
      </header>

      {query && (
        <section className="mt-6">
          <h2 className="text-lg font-black">{tr("Résultats")}</h2>
          {loading ? <div className="mt-3 h-24 animate-pulse rounded-2xl bg-accent" /> : matches.length ? <div className="mt-3 grid gap-3 sm:grid-cols-2">{matches.map((article) => <article key={article.id} className="glass rounded-2xl p-4"><div className="flex items-start gap-3"><BookOpen className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><div><h3 className="font-bold">{tr(article.title)}</h3>{article.excerpt && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{tr(article.excerpt)}</p>}<Link to="/help" search={{ q: article.title }} className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-primary">{tr("Lire le guide")}<ChevronRight className="h-3.5 w-3.5" /></Link></div></div></article>)}</div> : <div className="mt-3 rounded-2xl border p-5 text-center"><HelpCircle className="mx-auto h-8 w-8 text-primary" /><p className="mt-2 font-bold">{tr("Aucun guide ne correspond exactement")}</p><p className="mt-1 text-sm text-muted-foreground">{tr("La FAQ ou l’équipe d’aide peut prendre le relais.")}</p></div>}
        </section>
      )}

      <section className="mt-7">
        <div className="mb-4 flex items-end justify-between gap-4"><div><h2 className="text-2xl font-black">{tr("Explorer par thème")}</h2><p className="mt-1 text-sm text-muted-foreground">{tr("Des parcours courts pour résoudre les demandes les plus courantes.")}</p></div><Link to="/faq" className="hidden rounded-full border px-4 py-2 text-sm font-semibold hover:bg-accent sm:inline-flex">{tr("Voir toute la FAQ")}</Link></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{categories.map((item) => { const Icon = iconFor(item.icon); return <button key={item.id} type="button" onClick={() => setQuery(item.title)} className="glass group flex min-h-40 flex-col items-start rounded-3xl p-5 text-left transition hover:-translate-y-0.5 hover:border-primary/40"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-primary/12 text-primary"><Icon className="h-5 w-5" /></div><h3 className="mt-4 font-black">{tr(item.title)}</h3>{item.description && <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{tr(item.description)}</p>}<span className="mt-auto pt-4 text-xs font-bold text-primary">{tr("Explorer")} →</span></button>; })}</div>
      </section>

      <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{QUICK_LINKS.map((item) => <Link key={item.title} to={item.to} search={"search" in item ? item.search : undefined} className="flex items-start gap-3 rounded-2xl border p-4 hover:border-primary/50"><item.icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" /><span><span className="block font-bold">{tr(item.title)}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{tr(item.description)}</span></span></Link>)}</section>

      <section className="mt-8 overflow-hidden rounded-[2rem] border border-primary/25 bg-primary/5 p-6 sm:p-8">
        <div className="flex flex-col items-center justify-between gap-5 text-center sm:flex-row sm:text-left">
          <div className="flex max-w-2xl items-start gap-4"><div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground"><MessageCircle className="h-6 w-6" /></div><div><h2 className="text-xl font-black">{tr("Une situation nécessite un suivi ?")}</h2><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{tr("Crée une demande liée à ton compte. Elle est enregistrée avec sa catégorie et sa priorité, sans exposer tes informations dans le fil public.")}</p></div></div>
          <button type="button" onClick={openSupport} className="btn-glow shrink-0 rounded-full bg-primary px-6 py-3 text-sm font-bold text-primary-foreground">{userId ? tr("Créer une demande") : tr("Se connecter pour contacter l’aide")}</button>
        </div>
      </section>

      <footer className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground"><Link to="/terms" className="hover:text-foreground">{tr("Conditions d’utilisation")}</Link><Link to="/privacy" className="hover:text-foreground">{tr("Confidentialité")}</Link><Link to="/cookies" className="hover:text-foreground">{tr("Cookies")}</Link><Link to="/faq" className="hover:text-foreground">{tr("FAQ")}</Link></footer>

      {formOpen && (
        <div className="fixed inset-0 z-[80] grid place-items-end bg-black/70 p-0 backdrop-blur-sm sm:place-items-center sm:p-4" role="dialog" aria-modal="true">
          <div className="max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl border bg-background shadow-2xl sm:max-w-xl sm:rounded-3xl">
            <header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/95 px-5 py-4 backdrop-blur"><div><h2 className="text-lg font-black">{tr("Contacter le centre d’aide")}</h2><p className="text-xs text-muted-foreground">{tr("N’inclus jamais de mot de passe, de clé ou de données bancaires.")}</p></div><button type="button" onClick={() => setFormOpen(false)} className="grid h-10 w-10 place-items-center rounded-full hover:bg-accent"><X className="h-5 w-5" /></button></header>
            {sentTicket ? <div className="p-8 text-center"><CheckCircle2 className="mx-auto h-14 w-14 text-emerald-500" /><h3 className="mt-4 text-xl font-black">{tr("Demande enregistrée")}</h3><p className="mt-2 text-sm text-muted-foreground">{tr("Référence")} : <strong className="text-foreground">{sentTicket}</strong></p><button type="button" onClick={() => setFormOpen(false)} className="mt-6 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground">{tr("Fermer")}</button></div> : <form onSubmit={sendTicket} className="space-y-4 p-5"><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-semibold"><span className="mb-1.5 block">{tr("Catégorie")}</span><select value={category} onChange={(event) => setCategory(event.target.value)} className="field-control min-h-11 w-full"><option value="general">{tr("Question générale")}</option><option value="account">{tr("Compte et connexion")}</option><option value="events">{tr("Événement")}</option><option value="social">{tr("Réseau social")}</option><option value="privacy">{tr("Confidentialité")}</option><option value="billing">{tr("Paiement ou facturation")}</option><option value="security">{tr("Sécurité")}</option></select></label><label className="text-sm font-semibold"><span className="mb-1.5 block">{tr("Priorité")}</span><select value={priority} onChange={(event) => setPriority(event.target.value)} className="field-control min-h-11 w-full"><option value="low">{tr("Faible")}</option><option value="normal">{tr("Normale")}</option><option value="high">{tr("Élevée")}</option><option value="urgent">{tr("Urgente — sécurité ou accès bloqué")}</option></select></label></div><label className="text-sm font-semibold"><span className="mb-1.5 block">{tr("Objet")}</span><input value={subject} onChange={(event) => setSubject(event.target.value.slice(0,160))} className="field-control min-h-11 w-full" placeholder={tr("Résume le problème")} /></label><label className="text-sm font-semibold"><span className="mb-1.5 block">{tr("Description")}</span><textarea value={message} onChange={(event) => setMessage(event.target.value.slice(0,5000))} rows={7} className="field-control w-full resize-y" placeholder={tr("Décris les étapes, le résultat attendu et ce qui s’est réellement produit.")} /><span className="mt-1 block text-right text-[11px] text-muted-foreground">{message.length}/5 000</span></label><button type="submit" disabled={sending} className="btn-glow flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-primary font-bold text-primary-foreground disabled:opacity-50">{sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}{sending ? tr("Envoi…") : tr("Envoyer la demande")}</button></form>}
          </div>
        </div>
      )}
    </div>
  );
}

function iconFor(value: string | null) {
  const map: Record<string, typeof Rocket> = { rocket: Rocket, calendar: CalendarDays, users: Users, shield: Shield, megaphone: Megaphone };
  return map[value ?? ""] ?? HelpCircle;
}
