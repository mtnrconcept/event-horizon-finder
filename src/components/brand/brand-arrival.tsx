import { useEffect, useState } from "react";
import { BrandLogo } from "@/components/brand/brand-logo";
import "./brand-arrival.css";

const INTRO_FALLBACK_DURATION_MS = 2_100;
const INTRO_STORAGE_KEY = "global-party.brand-arrival-seen";

export function BrandArrival() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(INTRO_STORAGE_KEY)) {
        setVisible(false);
        return;
      }
      window.sessionStorage.setItem(INTRO_STORAGE_KEY, "1");
    } catch {
      // Storage can be unavailable in privacy-focused browsing modes. The
      // intro still works and simply replays on the next full page load.
    }

    const dismiss = () => setVisible(false);
    const timeout = window.setTimeout(dismiss, INTRO_FALLBACK_DURATION_MS);

    window.addEventListener("pointerdown", dismiss, { once: true, passive: true });
    window.addEventListener("keydown", dismiss, { once: true });

    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      className="brand-arrival"
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setVisible(false);
      }}
    >
      <div className="brand-arrival__aurora" />
      <div className="brand-arrival__stage">
        <div className="brand-arrival__halo" />
        <BrandLogo variant="lockup" className="brand-arrival__logo" />
        <div className="brand-arrival__trace-crop">
          <div className="brand-arrival__trace-mask" />
        </div>
        <div className="brand-arrival__floor" />
      </div>
    </div>
  );
}
