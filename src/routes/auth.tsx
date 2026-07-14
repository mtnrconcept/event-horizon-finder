import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type AuthSearch = {
  redirect?: string;
};

const redirectBase = "https://eventa.local";

function safeInternalRedirect(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return undefined;
  }

  try {
    const base = new URL(redirectBase);
    const target = new URL(value, base);
    if (target.origin !== base.origin || target.pathname === "/auth") return undefined;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}

export const Route = createFileRoute("/auth")({
  validateSearch: (search: Record<string, unknown>): AuthSearch => ({
    redirect: safeInternalRedirect(search.redirect),
  }),
  head: () => ({ meta: [{ title: "Connexion — EVENTA" }] }),
  component: Auth,
});

function Auth() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const destination = redirect ?? "/";

  const returnToDestination = () => {
    if (destination === "/") {
      navigate({ to: "/" });
      return;
    }
    window.location.assign(destination);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email, password,
          options: { emailRedirectTo: new URL(destination, window.location.origin).toString() },
        });
        if (error) throw error;
        toast.success("Compte créé. Vérifie ton e-mail si demandé.");
        returnToDestination();
      } else if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        returnToDestination();
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
        if (error) throw error;
        toast.success("E-mail de réinitialisation envoyé.");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally { setLoading(false); }
  };

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-md items-center px-4">
      <div className="glass w-full rounded-2xl p-6 md:p-8">
        <h1 className="text-2xl font-bold">
          {mode === "signin" ? "Bienvenue" : mode === "signup" ? "Créer un compte" : "Mot de passe oublié"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "signin" ? "Connecte-toi pour retrouver ton agenda et tes favoris." :
           mode === "signup" ? "Rejoins EVENTA et découvre ce qui se passe autour de toi." :
           "Reçois un lien pour réinitialiser ton mot de passe."}
        </p>
        <form onSubmit={submit} className="mt-6 space-y-3">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="E-mail"
                 className="w-full rounded-lg border bg-transparent px-3 py-2.5 text-sm outline-none focus:border-primary" />
          {mode !== "reset" && (
            <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mot de passe (min. 6 caractères)"
                   className="w-full rounded-lg border bg-transparent px-3 py-2.5 text-sm outline-none focus:border-primary" />
          )}
          <button type="submit" disabled={loading} className="btn-glow w-full rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {loading ? "…" : mode === "signin" ? "Se connecter" : mode === "signup" ? "Créer un compte" : "Envoyer le lien"}
          </button>
        </form>
        <div className="mt-4 flex justify-between text-xs">
          <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")} className="text-muted-foreground hover:text-foreground">
            {mode === "signin" ? "Créer un compte" : "J'ai déjà un compte"}
          </button>
          {mode !== "reset" && <button onClick={() => setMode("reset")} className="text-muted-foreground hover:text-foreground">Mot de passe oublié</button>}
        </div>
      </div>
    </div>
  );
}
