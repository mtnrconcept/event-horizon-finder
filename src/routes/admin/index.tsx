import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Activity, CheckCircle2, Database, TriangleAlert } from "lucide-react";

export const Route = createFileRoute("/admin/")({
  head: () => ({ meta: [{ title: "Administration — EVENTA" }] }),
  component: AdminHome,
});

type Stats = { events: number; pending: number; reports: number; ingestion: number };
type SourceRow = {
  id: string;
  name: string;
  status: string | null;
  last_sync_at: string | null;
  next_sync_at: string | null;
};
type JobRow = {
  id: string;
  status: string;
  pages_success: number | null;
  pages_failed: number | null;
  events_created: number | null;
  events_updated: number | null;
  finished_at: string | null;
};

function AdminHome() {
  const navigate = useNavigate();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [pending, setPending] = useState<
    { id: string; title: string; slug: string; status: string }[]
  >([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        navigate({ to: "/auth" });
        return;
      }
      const { data: roles } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      const ok = (roles ?? []).some((r) => r.role === "admin" || r.role === "moderator");
      setAllowed(ok);
      if (!ok) return;

      const [{ count: cEvents }, { count: cPending }, { count: cReports }, { count: cIng }] =
        await Promise.all([
          supabase.from("events").select("*", { count: "exact", head: true }),
          supabase
            .from("events")
            .select("*", { count: "exact", head: true })
            .eq("status", "pending_review"),
          supabase
            .from("event_reports")
            .select("*", { count: "exact", head: true })
            .eq("status", "open"),
          supabase.from("ingestion_jobs").select("*", { count: "exact", head: true }),
        ]);
      setStats({
        events: cEvents ?? 0,
        pending: cPending ?? 0,
        reports: cReports ?? 0,
        ingestion: cIng ?? 0,
      });

      const { data: p } = await supabase
        .from("events")
        .select("id,title,slug,status")
        .eq("status", "pending_review")
        .order("created_at", { ascending: false })
        .limit(20);
      setPending((p ?? []) as { id: string; title: string; slug: string; status: string }[]);

      const [{ data: sourceRows }, { data: jobRows }] = await Promise.all([
        supabase
          .from("data_sources")
          .select("id,name,status,last_sync_at,next_sync_at")
          .order("name")
          .limit(50),
        supabase
          .from("ingestion_jobs")
          .select("id,status,pages_success,pages_failed,events_created,events_updated,finished_at")
          .order("created_at", { ascending: false })
          .limit(8),
      ]);
      setSources((sourceRows ?? []) as SourceRow[]);
      setJobs((jobRows ?? []) as JobRow[]);
    })();
  }, [navigate]);

  const publish = async (id: string) => {
    const { error } = await supabase
      .from("events")
      .update({
        status: "published",
        publication_status: "published",
        published_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) return toast.error(error.message);
    setPending((p) => p.filter((e) => e.id !== id));
    toast.success("Publié");
  };

  if (allowed === false)
    return (
      <div className="p-10 text-center text-muted-foreground">
        Accès réservé aux modérateurs et administrateurs.
      </div>
    );

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
      <div className="mb-8 grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="glass rounded-2xl p-4">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="flex items-center gap-2 font-semibold">
                <Activity className="h-4 w-4 text-primary" /> Santé des importations
              </p>
              <p className="text-xs text-muted-foreground">
                Les 8 derniers lots du catalogue régional
              </p>
            </div>
            <span className="rounded-full border px-2.5 py-1 text-xs">{jobs.length} lots</span>
          </div>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune synchronisation enregistrée.</p>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => {
                const healthy = job.status === "completed" && !job.pages_failed;
                return (
                  <div
                    key={job.id}
                    className="flex items-center gap-3 rounded-xl bg-surface/50 p-3 text-sm"
                  >
                    {healthy ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <TriangleAlert className="h-4 w-4 text-amber-500" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{job.status.replaceAll("_", " ")}</p>
                      <p className="text-xs text-muted-foreground">
                        {job.pages_success ?? 0} pages · +{job.events_created ?? 0} créés ·{" "}
                        {job.events_updated ?? 0} actualisés
                      </p>
                    </div>
                    <time className="text-[11px] text-muted-foreground">
                      {job.finished_at
                        ? new Intl.DateTimeFormat("fr-CH", {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          }).format(new Date(job.finished_at))
                        : "en cours"}
                    </time>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="glass rounded-2xl p-4">
          <div className="mb-4">
            <p className="flex items-center gap-2 font-semibold">
              <Database className="h-4 w-4 text-primary" /> Sources actives
            </p>
            <p className="text-xs text-muted-foreground">
              {sources.length} agendas officiels et partenaires
            </p>
          </div>
          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {sources.map((source) => (
              <div
                key={source.id}
                className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{source.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {source.last_sync_at
                      ? `Sync ${new Intl.DateTimeFormat("fr-CH", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(source.last_sync_at))}`
                      : "Première synchronisation à venir"}
                  </p>
                </div>
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-emerald-500"
                  aria-label={source.status ?? "active"}
                />
              </div>
            ))}
          </div>
        </section>
      </div>
      <h2 className="mb-3 text-xl font-semibold">Événements à vérifier</h2>
      <div className="glass overflow-hidden rounded-2xl">
        {pending.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">Rien en attente.</p>
        ) : (
          <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
            {pending.map((e) => (
              <li key={e.id} className="flex items-center justify-between p-4">
                <p className="font-medium">{e.title}</p>
                <button
                  onClick={() => publish(e.id)}
                  className="rounded-full bg-primary px-4 py-1.5 text-xs text-primary-foreground"
                >
                  Publier
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
