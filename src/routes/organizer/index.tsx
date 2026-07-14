import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Plus, Rss } from "lucide-react";

export const Route = createFileRoute("/organizer/")({
  head: () => ({ meta: [{ title: "Portail organisateur — EVENTA" }] }),
  component: OrganizerHome,
});

type OrgRow = { organizer_id: string; role: string; organizer: { name: string; slug: string; is_verified: boolean } };
type EventRow = { id: string; slug: string; title: string; status: string; is_demo: boolean };

function OrganizerHome() {
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");

  const loadOrganizerData = useCallback(async () => {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (!user) {
      navigate({ to: "/auth", search: { redirect: "/organizer" } });
      return;
    }
    if (userError) {
      toast.error(userError.message);
      return;
    }

    const { data: mems, error: membershipsError } = await supabase
      .from("organizer_members")
      .select("organizer_id, role, organizer:organizers(name,slug,is_verified)")
      .eq("user_id", user.id);
    if (membershipsError) {
      toast.error(membershipsError.message);
      return;
    }

    const memberships = (mems ?? []) as OrgRow[];
    setOrgs(memberships);
    const orgIds = memberships.map((membership) => membership.organizer_id);
    if (!orgIds.length) {
      setEvents([]);
      return;
    }

    const { data: evs, error: eventsError } = await supabase
      .from("events")
      .select("id,slug,title,status,is_demo")
      .in("organizer_id", orgIds)
      .order("updated_at", { ascending: false });
    if (eventsError) {
      toast.error(eventsError.message);
      return;
    }
    setEvents((evs ?? []) as EventRow[]);
  }, [navigate]);

  useEffect(() => {
    void loadOrganizerData();
  }, [loadOrganizerData]);

  const createOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || submitting) return;

    const slugRoot = trimmedName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "organisation";
    const slug = `${slugRoot}-${Math.random().toString(36).slice(2, 6)}`;

    setSubmitting(true);
    try {
      // Types are regenerated after the migration that introduces this RPC is applied.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("create_organizer", {
        _name: trimmedName,
        _slug: slug,
      });
      if (error) {
        toast.error(error.message);
        return;
      }

      toast.success("Organisation créée");
      setCreating(false);
      setName("");
      await loadOrganizerData();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Impossible de créer l'organisation");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 pt-8 md:px-6">
      <h1 className="mb-2 text-3xl font-bold">Portail organisateur</h1>
      <p className="mb-6 text-sm text-muted-foreground">Gère tes organisations et publie tes événements.</p>

      {orgs.length === 0 && !creating && (
        <div className="glass rounded-2xl p-6 text-center">
          <p className="mb-4">Tu ne fais partie d'aucune organisation.</p>
          <button onClick={() => setCreating(true)} className="btn-glow rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground">Créer une organisation</button>
        </div>
      )}

      {creating && (
        <form onSubmit={createOrg} className="glass mb-6 space-y-3 rounded-2xl p-4">
          <label className="text-xs font-medium">Nom de l'organisation</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <button type="submit" disabled={submitting} className="rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
              {submitting ? "Création…" : "Créer"}
            </button>
            <button type="button" onClick={() => setCreating(false)} className="rounded-full border px-4 py-2 text-sm">Annuler</button>
          </div>
        </form>
      )}

      {orgs.length > 0 && (
        <>
          <div className="mb-6 grid gap-3 md:grid-cols-2">
            {orgs.map((o) => (
              <div key={o.organizer_id} className="glass rounded-2xl p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{o.organizer.name}</p>
                    <p className="text-xs text-muted-foreground">Rôle : {o.role}{o.organizer.is_verified ? " · vérifié" : ""}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mb-6 flex justify-end">
            <Link to="/social" className="flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium hover:bg-accent">
              <Rss className="h-4 w-4" /> Publier dans le fil
            </Link>
          </div>

          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xl font-semibold">Événements</h2>
            <Link to="/organizer/new" className="flex items-center gap-1 rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground">
              <Plus className="h-4 w-4" /> Nouveau
            </Link>
          </div>
          <div className="glass overflow-hidden rounded-2xl">
            {events.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">Aucun événement pour l'instant.</p>
            ) : (
              <ul className="divide-y" style={{ borderColor: "var(--color-border)" }}>
                {events.map((e) => (
                  <li key={e.id} className="flex items-center justify-between p-4">
                    <div>
                      <p className="font-medium">{e.title}</p>
                      <p className="text-xs text-muted-foreground">Statut : {e.status}{e.is_demo ? " · démo" : ""}</p>
                    </div>
                    <Link to="/event/$slug" params={{ slug: e.slug }} className="text-sm text-primary">Voir</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
