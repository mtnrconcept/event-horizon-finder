import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/organizer/new")({
  head: () => ({ meta: [{ title: "Nouvel événement — EVENTA" }] }),
  component: NewEvent,
});

function NewEvent() {
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [venues, setVenues] = useState<{ id: string; name: string }[]>([]);
  const [cats, setCats] = useState<{ id: string; name_fr: string }[]>([]);
  const [form, setForm] = useState({
    title: "", short_description: "", description: "",
    organizer_id: "", venue_id: "", category_id: "",
    starts_at: "", ends_at: "", timezone: "Europe/Paris",
    is_free: false, official_url: "",
  });

  useEffect(() => { (async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { navigate({ to: "/auth" }); return; }
    const [{ data: mems }, { data: v }, { data: c }] = await Promise.all([
      supabase.from("organizer_members").select("organizer:organizers(id,name)").eq("user_id", user.id),
      supabase.from("venues").select("id,name").order("name").limit(500),
      supabase.from("event_categories").select("id,name_fr").order("sort_order"),
    ]);
    setOrgs((mems ?? []).map((m) => m.organizer!).filter(Boolean) as { id: string; name: string }[]);
    setVenues((v ?? []) as { id: string; name: string }[]);
    setCats((c ?? []) as { id: string; name_fr: string }[]);
  })(); }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { data: { user } } = await supabase.auth.getUser(); if (!user) return;
    const slug = form.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Math.random().toString(36).slice(2, 6);
    const { data: ev, error } = await supabase.from("events").insert({
      slug, title: form.title, short_description: form.short_description || null, description: form.description || null,
      organizer_id: form.organizer_id || null, venue_id: form.venue_id || null, category_id: form.category_id || null,
      status: "pending_review", publication_status: "pending", is_free: form.is_free, official_url: form.official_url || null,
      created_by: user.id,
    }).select().single();
    if (error) return toast.error(error.message);
    if (form.starts_at) {
      await supabase.from("event_occurrences").insert({
        event_id: ev.id, starts_at: new Date(form.starts_at).toISOString(),
        ends_at: form.ends_at ? new Date(form.ends_at).toISOString() : null, timezone: form.timezone,
      });
    }
    toast.success("Événement créé (en attente de vérification)");
    navigate({ to: "/organizer" });
  };

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="mx-auto max-w-2xl px-4 pt-8 md:px-6">
      <h1 className="mb-6 text-3xl font-bold">Nouvel événement</h1>
      <form onSubmit={submit} className="glass space-y-4 rounded-2xl p-6">
        <div>
          <label className="text-xs font-medium">Titre *</label>
          <input required value={form.title} onChange={(e) => set("title", e.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="text-xs font-medium">Organisation</label>
            <select value={form.organizer_id} onChange={(e) => set("organizer_id", e.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm">
              <option value="">—</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium">Catégorie</label>
            <select value={form.category_id} onChange={(e) => set("category_id", e.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm">
              <option value="">—</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name_fr}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium">Lieu</label>
            <select value={form.venue_id} onChange={(e) => set("venue_id", e.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm">
              <option value="">—</option>
              {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium">Fuseau (IANA)</label>
            <input value={form.timezone} onChange={(e) => set("timezone", e.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium">Début *</label>
            <input type="datetime-local" required value={form.starts_at} onChange={(e) => set("starts_at", e.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium">Fin</label>
            <input type="datetime-local" value={form.ends_at} onChange={(e) => set("ends_at", e.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium">Description courte</label>
          <input value={form.short_description} onChange={(e) => set("short_description", e.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium">Description complète</label>
          <textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={5} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="text-xs font-medium">Lien officiel</label>
          <input type="url" value={form.official_url} onChange={(e) => set("official_url", e.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.is_free} onChange={(e) => set("is_free", e.target.checked)} /> Événement gratuit
        </label>
        <button type="submit" className="btn-glow w-full rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground">Créer (en attente de vérification)</button>
      </form>
    </div>
  );
}
