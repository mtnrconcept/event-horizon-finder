import { Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

export function OnlineStatus() {
  const [online, setOnline] = useState(true);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let hideTimer: number | null = null;
    const update = () => {
      const nextOnline = navigator.onLine;
      setOnline(nextOnline);
      setVisible(true);
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      if (nextOnline) hideTimer = window.setTimeout(() => setVisible(false), 3_000);
    };

    setOnline(navigator.onLine);
    setVisible(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      if (hideTimer !== null) window.clearTimeout(hideTimer);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-[calc(5.1rem+env(safe-area-inset-bottom))] left-1/2 z-[70] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border px-4 py-2 text-xs font-bold shadow-2xl backdrop-blur md:bottom-4 ${
        online
          ? "border-emerald-400/30 bg-emerald-400/15 text-emerald-300"
          : "border-amber-400/35 bg-background/95 text-amber-300"
      }`}
    >
      {online ? <Wifi className="h-4 w-4 shrink-0" /> : <WifiOff className="h-4 w-4 shrink-0" />}
      <span className="truncate">
        {online
          ? "Connexion rétablie"
          : "Mode hors ligne — certaines données peuvent être indisponibles"}
      </span>
    </div>
  );
}
