import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Plus } from "lucide-react";

export const Route = createFileRoute("/organizer/")({
  head: () => ({ meta: [{ title: "Portail organisateur — EVENTA" }] }),
  component: OrganizerHome,
});

type OrgRow = { organizer_id: string; role: string; organizer: { name: string; slug: string; is_verified: boolean } };
type EventRow = { id: string; slug: string; title: string; status: string; is_demo: boolean };

function OrganizerHome() {
  const navigate = useNavigate();
  const [uid, setUid] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => { (async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { navigate({ to: "/auth" }); return; }
    setUid(user.id);
    const { data: mems } = await supabase.from("organizer_members").select("organizer_id, role, organizer:organizers(name,slug,is_verified)").eq("user_id", user.id);
    setOrgs((mems ?? []) as OrgRow[]);
    const orgIds = (mems ?? []).map((m) => m.organizer_id);
    if (orgIds.length) {
      const { data: evs } = await supabase.from("events").select("id,slug,title,status,is_demo").in("organizer_id", orgIds).order("updated_at", { ascending: false });
      setEvents((evs ?? []) as EventRow[]);
    }
  })(); }, [navigate]);

  const createOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uid || !name.trim()) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Math.random().toString(36).slice(2, 6);
    const { data, error } = await supabase.from("organizers").insert({ slug, name, verification_level: "unverified" }).select().single();
    if (error) return toast.error(error.message);
    await supabase.from("organizer_members").insert({ organizer_id: data.id, user_id: uid, role: "owner" });
    // Give organizer role
    await supabase.from("user_roles").insert({ user_id: uid, role: "organizer" }).select();
    toast.success("Organisation créée");
    setCreating(false); setName("");
    location.reload();
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
            <button type="submit" className="rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground">Créer</button>
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
