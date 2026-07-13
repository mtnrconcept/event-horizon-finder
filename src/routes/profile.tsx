import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { User, LogOut, Shield, Settings } from "lucide-react";

export const Route = createFileRoute("/profile")({
  head: () => ({ meta: [{ title: "Mon profil — EVENTA" }] }),
  component: Profile,
});

function Profile() {
  const navigate = useNavigate();
  const [session, setSession] = useState<{ email?: string; id: string } | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setSession(null); return; }
      setSession({ email: user.email, id: user.id });
      const { data: p } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
      setDisplayName(p?.display_name ?? "");
      const { data: r } = await supabase.from("user_roles").select("role").eq("user_id", user.id);
      setRoles((r ?? []).map((x) => x.role));
    })();
  }, []);

  const saveName = async () => {
    if (!session) return;
    await supabase.from("profiles").update({ display_name: displayName }).eq("id", session.id);
  };

  const signOut = async () => { await supabase.auth.signOut(); navigate({ to: "/auth" }); };

  if (!session) {
    return (
      <div className="mx-auto max-w-md px-4 pt-16 text-center">
        <User className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Ton profil</h1>
        <p className="mt-2 text-muted-foreground">Crée un compte ou connecte-toi.</p>
        <Link to="/auth" className="btn-glow mt-6 inline-flex rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground">
          Se connecter
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 pt-8 md:px-6">
      <h1 className="mb-6 text-3xl font-bold">Profil</h1>
      <div className="glass mb-4 rounded-2xl p-6">
        <p className="text-xs uppercase text-muted-foreground">Compte</p>
        <p className="mt-1 font-medium">{session.email}</p>
        <div className="mt-4">
          <label className="text-xs font-medium">Nom affiché</label>
          <div className="mt-1 flex gap-2">
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="flex-1 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary" />
            <button onClick={saveName} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Enregistrer</button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {roles.map((r) => (
            <span key={r} className="rounded-full border px-3 py-1 text-xs" style={{ borderColor: "var(--color-primary)", color: "var(--color-primary)" }}>{r}</span>
          ))}
        </div>
      </div>
      <div className="glass mb-4 space-y-2 rounded-2xl p-4">
        <Link to="/organizer" className="flex items-center gap-3 rounded-lg p-3 hover:bg-accent">
          <Settings className="h-5 w-5" /> Portail organisateur
        </Link>
        {(roles.includes("admin") || roles.includes("moderator")) && (
          <Link to="/admin" className="flex items-center gap-3 rounded-lg p-3 hover:bg-accent">
            <Shield className="h-5 w-5" /> Administration
          </Link>
        )}
      </div>
      <button onClick={signOut} className="flex w-full items-center justify-center gap-2 rounded-full border py-3 text-sm font-medium hover:bg-accent">
        <LogOut className="h-4 w-4" /> Se déconnecter
      </button>
    </div>
  );
}
