import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useTranslation } from "@/lib/i18n";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Réinitialiser le mot de passe — Global Party" }] }),
  component: ResetPassword,
});

function ResetPassword() {
  const { tr } = useTranslation();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Supabase parses the recovery token from the URL hash automatically.
    supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setReady(true);
    });
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) return toast.error(error.message);
    toast.success(tr("Mot de passe mis à jour."));
    navigate({ to: "/" });
  };

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-md items-center px-4">
      <form onSubmit={submit} className="glass w-full space-y-4 rounded-2xl p-6">
        <h1 className="text-2xl font-bold">{tr("Nouveau mot de passe")}</h1>
        {!ready && (
          <p className="text-xs text-muted-foreground">
            {tr("En attente du lien de récupération…")}
          </p>
        )}
        <input
          type="password"
          minLength={6}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={tr("Nouveau mot de passe")}
          className="w-full rounded-lg border bg-transparent px-3 py-2.5 text-sm"
        />
        <button
          type="submit"
          disabled={!ready}
          className="btn-glow w-full rounded-full bg-primary py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {tr("Mettre à jour")}
        </button>
      </form>
    </div>
  );
}
