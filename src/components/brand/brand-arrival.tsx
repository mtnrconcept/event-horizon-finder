import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, VolumeX, X } from "lucide-react";
import "./brand-arrival.css";

const INTRO_STARTUP_TIMEOUT_MS = 6_000;
const INTRO_PLAYBACK_TIMEOUT_MS = 11_500;
const INTRO_EXIT_DURATION_MS = 280;
const INTRO_STORAGE_KEY = "global-party.brand-arrival-video-v1-seen";

type NavigatorWithConnection = Navigator & {
  connection?: {
    saveData?: boolean;
  };
};

export function BrandArrival() {
  const [visible, setVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const soundButtonRef = useRef<HTMLButtonElement>(null);
  const skipButtonRef = useRef<HTMLButtonElement>(null);
  const exitTimeoutRef = useRef<number | undefined>(undefined);
  const watchdogTimeoutRef = useRef<number | undefined>(undefined);

  const dismiss = useCallback(() => {
    window.clearTimeout(exitTimeoutRef.current);
    window.clearTimeout(watchdogTimeoutRef.current);
    setIsLeaving(true);
    exitTimeoutRef.current = window.setTimeout(() => {
      setVisible(false);
    }, INTRO_EXIT_DURATION_MS);
  }, []);

  const armPlaybackWatchdog = useCallback(() => {
    window.clearTimeout(watchdogTimeoutRef.current);
    watchdogTimeoutRef.current = window.setTimeout(dismiss, INTRO_PLAYBACK_TIMEOUT_MS);
  }, [dismiss]);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const saveData = (window.navigator as NavigatorWithConnection).connection?.saveData === true;

    try {
      if (window.sessionStorage.getItem(INTRO_STORAGE_KEY)) {
        return;
      }
      window.sessionStorage.setItem(INTRO_STORAGE_KEY, "1");
    } catch {
      // Storage can be unavailable in privacy-focused browsing modes. The
      // intro still works and simply replays on the next full page load.
    }

    if (reducedMotion || saveData) return;

    setVisible(true);

    return () => window.clearTimeout(exitTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!visible) return;

    const previousBodyOverflow = document.body.style.overflow;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    watchdogTimeoutRef.current = window.setTimeout(dismiss, INTRO_STARTUP_TIMEOUT_MS);
    document.body.style.overflow = "hidden";
    skipButtonRef.current?.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }

      if (event.key !== "Tab") return;

      const firstControl = soundButtonRef.current;
      const lastControl = skipButtonRef.current;
      if (!firstControl || !lastControl) return;

      if (event.shiftKey && document.activeElement === firstControl) {
        event.preventDefault();
        lastControl.focus();
      } else if (!event.shiftKey && document.activeElement === lastControl) {
        event.preventDefault();
        firstControl.focus();
      }
    };
    const handleMotionPreference = (event: MediaQueryListEvent) => {
      if (event.matches) dismiss();
    };

    window.addEventListener("keydown", handleKeyDown);
    motionPreference.addEventListener("change", handleMotionPreference);

    return () => {
      window.clearTimeout(watchdogTimeoutRef.current);
      document.body.style.overflow = previousBodyOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      motionPreference.removeEventListener("change", handleMotionPreference);
    };
  }, [dismiss, visible]);

  if (!visible) return null;

  return (
    <section
      className={`brand-arrival${isLeaving ? " brand-arrival--leaving" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Introduction Global Party"
    >
      <div className="brand-arrival__stage">
        <video
          ref={videoRef}
          className="brand-arrival__video"
          autoPlay
          muted={isMuted}
          playsInline
          preload="auto"
          poster="/brand/global-party-intro-poster.jpg"
          disablePictureInPicture
          controlsList="nodownload noplaybackrate noremoteplayback"
          aria-hidden="true"
          onCanPlay={(event) => {
            const playback = event.currentTarget.play();
            if (playback) void playback.catch(dismiss);
          }}
          onPlaying={armPlaybackWatchdog}
          onEnded={dismiss}
          onError={dismiss}
        >
          <source src="/brand/global-party-intro.mp4" type="video/mp4" />
        </video>
      </div>

      <div className="brand-arrival__controls">
        <button
          ref={soundButtonRef}
          type="button"
          className="brand-arrival__control"
          aria-label={isMuted ? "Activer le son" : "Couper le son"}
          aria-pressed={!isMuted}
          onClick={() => {
            const video = videoRef.current;
            if (!video) return;

            const nextMuted = !video.muted;
            video.muted = nextMuted;
            setIsMuted(nextMuted);

            if (video.paused) void video.play().catch(dismiss);
          }}
        >
          {isMuted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
          <span>{isMuted ? "Son" : "Son activé"}</span>
        </button>
        <button
          ref={skipButtonRef}
          type="button"
          className="brand-arrival__control brand-arrival__skip"
          onClick={dismiss}
        >
          <span>Passer</span>
          <X aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
