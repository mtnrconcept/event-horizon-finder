import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Calendar, Download, Trash2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/agenda")({
  head: () => ({ meta: [{ title: "Mon agenda — Global Party" }] }),
  component: Agenda,
});

type Item = {
  id: string;
  event: { id: string; slug: string; title: string; status: string } | null;
  occurrence: {
    starts_at: string;
    ends_at: string | null;
    timezone: string;
    latitude: number | null;
    longitude: number | null;
  } | null;
};

function toIcs(items: Item[]) {
  const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const events = items
    .filter((i) => i.event && i.occurrence)
    .map((i) => {
      const s =
        new Date(i.occurrence!.starts_at).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      const e =
        new Date(
          i.occurrence!.ends_at ??
            new Date(new Date(i.occurrence!.starts_at).getTime() + 2 * 3600 * 1000).toISOString(),
        )
          .toISOString()
          .replace(/[-:]/g, "")
          .split(".")[0] + "Z";
      return [
        "BEGIN:VEVENT",
        `UID:${i.id}@eventa`,
        `DTSTAMP:${now}`,
        `DTSTART:${s}`,
        `DTEND:${e}`,
        `SUMMARY:${(i.event!.title || "").replace(/\n/g, " ")}`,
        "END:VEVENT",
      ].join("\r\n");
    })
    .join("\r\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Global Party//FR",
    events,
    "END:VCALENDAR",
  ].join("\r\n");
}

function Agenda() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const load = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSignedIn(false);
      return;
    }
    setSignedIn(true);
    const { data } = await supabase
      .from("calendar_items")
      .select(
        "id, event:events(id,slug,title,status), occurrence:event_occurrences(starts_at,ends_at,timezone,latitude,longitude)",
      )
      .eq("user_id", user.id)
      .order("created_at");
    setItems((data ?? []) as Item[]);
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (id: string) => {
    await supabase.from("calendar_items").delete().eq("id", id);
    load();
  };

  const download = () => {
    if (!items) return;
    const blob = new Blob([toIcs(items)], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "global-party.ics";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Agenda exporté");
  };

  if (signedIn === false) {
    return (
      <div className="mx-auto max-w-md px-4 pt-16 text-center">
        <Calendar className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h1 className="text-2xl font-bold">Ton agenda</h1>
        <p className="mt-2 text-muted-foreground">Connecte-toi pour construire ton programme.</p>
        <Link
          to="/auth"
          className="btn-glow mt-6 inline-flex rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground"
        >
          Se connecter
        </Link>
      </div>
    );
  }

  const sorted = [...(items ?? [])].sort((a, b) =>
    (a.occurrence?.starts_at ?? "").localeCompare(b.occurrence?.starts_at ?? ""),
  );

  return (
    <div className="mx-auto max-w-3xl px-4 pt-8 md:px-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold">Agenda</h1>
        <button
          onClick={download}
          className="flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          <Download className="h-4 w-4" /> Exporter .ics
        </button>
      </div>
      {!items ? (
        <p className="text-muted-foreground">Chargement…</p>
      ) : sorted.length === 0 ? (
        <p className="text-muted-foreground">
          Ton agenda est vide. Ajoute un événement depuis sa fiche.
        </p>
      ) : (
        <ul className="space-y-3">
          {sorted.map((i) => (
            <li key={i.id} className="glass flex items-center gap-3 rounded-xl p-3">
              <div className="flex-1">
                <p className="font-medium">{i.event?.title ?? "Événement"}</p>
                <p className="text-xs text-muted-foreground">
                  {i.occurrence
                    ? new Intl.DateTimeFormat("fr-FR", {
                        timeZone: i.occurrence.timezone,
                        dateStyle: "medium",
                        timeStyle: "short",
                      }).format(new Date(i.occurrence.starts_at))
                    : ""}
                </p>
                {i.event?.status === "cancelled" && (
                  <span className="mt-1 inline-block rounded-full bg-destructive px-2 py-0.5 text-[10px] text-destructive-foreground">
                    Annulé
                  </span>
                )}
              </div>
              {i.event && (
                <Link
                  to="/event/$slug"
                  params={{ slug: i.event.slug }}
                  className="text-xs text-primary"
                >
                  Voir
                </Link>
              )}
              <button
                onClick={() => remove(i.id)}
                aria-label="Retirer"
                className="rounded-full p-2 hover:bg-accent"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
