import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Volume2, VolumeX, X } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import "./brand-arrival.css";

const INTRO_PLAYBACK_TIMEOUT_MS = 25_000;
const INTRO_EXIT_DURATION_MS = 280;

type NavigatorWithConnection = Navigator & {
  connection?: {
    saveData?: boolean;
  };
};

export function BrandArrival() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
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

    if (reducedMotion || saveData) return;

    setVisible(true);

    return () => window.clearTimeout(exitTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!visible) return;

    const previousBodyOverflow = document.body.style.overflow;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    document.body.style.overflow = "hidden";
    startButtonRef.current?.focus({ preventScroll: true });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }

      if (event.key !== "Tab") return;

      const firstControl = hasStarted ? soundButtonRef.current : startButtonRef.current;
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
  }, [dismiss, hasStarted, visible]);

  useEffect(() => {
    if (hasStarted) soundButtonRef.current?.focus({ preventScroll: true });
  }, [hasStarted]);

  const startWithSound = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    window.clearTimeout(watchdogTimeoutRef.current);
    video.currentTime = 0;
    video.muted = false;
    video.volume = 1;
    setIsMuted(false);
    setPlaybackError(false);

    try {
      await video.play();
      setHasStarted(true);
    } catch {
      setPlaybackError(true);
    }
  }, []);

  if (!visible) return null;

  return (
    <section
      className={`brand-arrival${isLeaving ? " brand-arrival--leaving" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("intro.label")}
    >
      <div className="brand-arrival__stage">
        <video
          ref={videoRef}
          className="brand-arrival__video"
          muted={isMuted}
          playsInline
          preload="auto"
          poster="/brand/global-party-intro-poster.jpg"
          disablePictureInPicture
          controlsList="nodownload noplaybackrate noremoteplayback"
          aria-hidden="true"
          onPlaying={armPlaybackWatchdog}
          onEnded={dismiss}
          onError={dismiss}
        >
          <source src="/brand/global-party-intro.mp4" type="video/mp4" />
        </video>
      </div>

      {!hasStarted && (
        <div className="brand-arrival__launch">
          <div className="brand-arrival__launch-glow" aria-hidden="true" />
          <p className="brand-arrival__launch-eyebrow">{t("intro.eyebrow")}</p>
          <p className="brand-arrival__launch-title">{t("intro.title")}</p>
          <button
            ref={startButtonRef}
            type="button"
            className="brand-arrival__launch-button"
            onClick={() => void startWithSound()}
          >
            <Play aria-hidden="true" fill="currentColor" />
            <span>{t("intro.launch")}</span>
          </button>
          <p className="brand-arrival__launch-hint">
            {playbackError ? t("intro.retry") : t("intro.hint")}
          </p>
        </div>
      )}

      <div className="brand-arrival__controls">
        {hasStarted && (
          <button
            ref={soundButtonRef}
            type="button"
            className="brand-arrival__control"
            aria-label={isMuted ? t("intro.enableSound") : t("intro.disableSound")}
            aria-pressed={!isMuted}
            onClick={() => {
              const video = videoRef.current;
              if (!video) return;

              const nextMuted = !video.muted;
              video.muted = nextMuted;
              setIsMuted(nextMuted);
            }}
          >
            {isMuted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
            <span>{isMuted ? t("intro.sound") : t("intro.soundOn")}</span>
          </button>
        )}
        <button
          ref={skipButtonRef}
          type="button"
          className="brand-arrival__control brand-arrival__skip"
          onClick={dismiss}
        >
          <span>{t("intro.skip")}</span>
          <X aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
