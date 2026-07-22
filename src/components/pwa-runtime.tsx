import { useEffect } from "react";
import { toast } from "sonner";

export function PwaRuntime() {
  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    let reloading = false;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

        const announceUpdate = (worker: ServiceWorker) => {
          worker.addEventListener("statechange", () => {
            if (worker.state !== "installed" || !navigator.serviceWorker.controller) return;
            toast.info("Une nouvelle version de Global Party est disponible.", {
              duration: 12_000,
              action: {
                label: "Mettre à jour",
                onClick: () => worker.postMessage({ type: "SKIP_WAITING" }),
              },
            });
          });
        };

        if (registration.waiting) {
          toast.info("Une nouvelle version de Global Party est disponible.", {
            duration: 12_000,
            action: {
              label: "Mettre à jour",
              onClick: () => registration.waiting?.postMessage({ type: "SKIP_WAITING" }),
            },
          });
        }

        registration.addEventListener("updatefound", () => {
          if (registration.installing) announceUpdate(registration.installing);
        });
      } catch (error) {
        console.warn("[pwa] service worker registration failed", error);
      }
    };

    const handleControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);

    const timer = window.setTimeout(() => void register(), 1_500);
    return () => {
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
    };
  }, []);

  return null;
}
