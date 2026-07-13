import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/")({
  head: () => ({ meta: [{ title: "Administration — EVENTA" }] }),
  component: AdminHome,
});

type Stats = { events: number; pending: number; reports: number; ingestion: number };

function AdminHome() {
  const navigate = useNavigate();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [pending, setPending] = useState<{ id: string; title: string; slug: string; status: string }[]>([]);

  useEffect(() => { (async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { navigate({ to: "/auth" }); return; }
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", user.id);
    const ok = (roles ?? []).some((r) => r.role === "admin" || r.role === "moderator");
    setAllowed(ok); if (!ok) return;

    const [{ count: cEvents }, { count: cPending }, { count: cReports }, { count: cIng }] = await Promise.all([
      supabase.from("events").select("*", { count: "exact", head: true }),
      supabase.from("events").select("*", { count: "exact", head: true }).eq("status", "pending_review"),
      supabase.from("event_reports").select("*", { count: "exact", head: true }).eq("status", "open"),
      supabase.from("ingestion_jobs").select("*", { count: "exact", head: true }),
    ]);
    setStats({ events: cEvents ?? 0, pending: cPending ?? 0, reports: cReports ?? 0, ingestion: cIng ?? 0 });

    const { data: p } = await supabase.from("events").select("id,title,slug,status").eq("status", "pending_review").order("created_at", { ascending: false }).limit(20);
    setPending((p ?? []) as { id: string; title: string; slug: string; status: string }[]);
  })(); }, [navigate]);

  const publish = async (id: string) => {
    const { error } = await supabase.from("events").update({ status: "published", publication_status: "published", published_at: new Date().toISOString() }).eq("id", id);
    if (error) return toast.error(error.message);
    setPending((p) => p.filter((e) => e.id !== id));
    toast.success("Publié");
  };

  if (allowed === false) return <div className="p-10 text-center text-muted-foreground">Accès réservé aux modérateurs et administrateurs.</div>;

  return (
    <div className="mx-auto max-w-5xl px-4 pt-8 md:px-6">
      <h1 className="mb-6 text-3xl font-bold">Administration</h1>
      {stats && (
        <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: "Événements", v: stats.events },
            { label: "À vérifier", v: stats.pending },
            { label: "Signalements", v: stats.reports },
            { label: "Importations", v: stats.ingestion },
          ].map((s) => (
            <div key={s.label} className="glass rounded-2xl p-4">
              <p className="text-xs uppercase text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-2xl font-bold">{s.v}</p>
            </div>
          ))}
        </div>
      )}
      <h2 className="mb-3 text-xl font-semibold">Événements à vérifier</h2>
      <div className="glass overflow-hidden rounded-2xl">
        {pending.length === 0 ? <p className="p-6 text-sm text-muted-foreground">Rien en attente.</p> :
          <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
            {pending.map((e) => (
              <li key={e.id} className="flex items-center justify-between p-4">
                <p className="font-medium">{e.title}</p>
                <button onClick={() => publish(e.id)} className="rounded-full bg-primary px-4 py-1.5 text-xs text-primary-foreground">Publier</button>
              </li>
            ))}
          </ul>}
      </div>
    </div>
  );
}
