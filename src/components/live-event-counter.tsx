import { useEffect, useRef, useState } from "react";
import { Radio } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useTranslation } from "@/lib/i18n";
import { normalizePublishedEventCount } from "@/lib/live-event-counter";
import {
  BRAND_ARRIVAL_COMPLETE_EVENT,
  hasBrandArrivalCompleted,
} from "@/lib/brand-arrival-events";

type CounterRow = {
  published_event_count?: number | string | null;
};

function useLivePublishedEventCount() {
  const [count, setCount] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const readCounter = async () => {
      // Generated types intentionally lag behind migrations during rolling
      // deployments, so this new relation stays cast at the query boundary.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from("public_event_counters")
        .select("published_event_count")
        .eq("singleton", true)
        .maybeSingle();
      if (!active) return false;
      if (error) {
        // Rolling-deploy fallback: show an exact value until the migration
        // creating the realtime singleton reaches this environment.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fallback = await (supabase as any)
          .from("events")
          .select("id", { count: "exact", head: true })
          .eq("is_demo", false)
          .in("status", ["published", "cancelled", "postponed", "sold_out"]);
        const fallbackCount = normalizePublishedEventCount(fallback.count);
        if (active && fallbackCount != null) setCount(fallbackCount);
        return false;
      }
      const nextCount = normalizePublishedEventCount(
        (data as CounterRow | null)?.published_event_count,
      );
      if (nextCount != null) setCount(nextCount);
      return nextCount != null;
    };

    const connect = async () => {
      const counterAvailable = await readCounter();
      if (!active || !counterAvailable) return;

      channel = supabase
        .channel("home-public-event-counter-v1")
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "public_event_counters",
            filter: "singleton=eq.true",
          },
          (payload) => {
            const nextCount = normalizePublishedEventCount(
              (payload.new as CounterRow | null)?.published_event_count,
            );
            if (active && nextCount != null) setCount(nextCount);
          },
        )
        .subscribe((status) => {
          if (!active) return;
          const isSubscribed = status === "SUBSCRIBED";
          setConnected(isSubscribed);
          // Re-read after each successful subscription to cover events that
          // arrived while the browser was offline or reconnecting.
          if (isSubscribed) void readCounter();
        });
    };

    void connect();
    return () => {
      active = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, []);

  return { count, connected };
}

const COUNTER_SPIN_DURATION_MS = 5_000;
const COUNTER_SPIN_INTERVAL_MS = 90;
const COUNTER_EARLIEST_STOP_MS = 3_200;
const COUNTER_LATEST_RANDOM_STOP_MS = 4_800;
const MIN_COUNTER_DIGITS = 6;

function toCounterDigits(value: number) {
  return String(value).padStart(MIN_COUNTER_DIGITS, "0").split("");
}

function createRandomStopTimes(length: number) {
  const finalDigitIndex = Math.floor(Math.random() * length);
  return Array.from({ length }, (_, index) =>
    index === finalDigitIndex
      ? COUNTER_SPIN_DURATION_MS
      : COUNTER_EARLIEST_STOP_MS +
        Math.random() * (COUNTER_LATEST_RANDOM_STOP_MS - COUNTER_EARLIEST_STOP_MS),
  );
}

function useBrandArrivalComplete() {
  const [complete, setComplete] = useState(hasBrandArrivalCompleted);

  useEffect(() => {
    const handleComplete = () => setComplete(true);
    window.addEventListener(BRAND_ARRIVAL_COMPLETE_EVENT, handleComplete);
    if (hasBrandArrivalCompleted()) handleComplete();

    return () => window.removeEventListener(BRAND_ARRIVAL_COMPLETE_EVENT, handleComplete);
  }, []);

  return complete;
}

function useIntroAnimatedDigits(target: number | null, canStart: boolean) {
  const [displayDigits, setDisplayDigits] = useState<string[] | null>(null);
  const latestTargetDigitsRef = useRef<string[] | null>(
    target == null ? null : toCounterDigits(target),
  );
  const introCompleteRef = useRef(false);
  const hasTarget = target != null;

  latestTargetDigitsRef.current = target == null ? null : toCounterDigits(target);

  useEffect(() => {
    if (!canStart || !hasTarget) return;

    const initialTargetDigits = latestTargetDigitsRef.current;
    if (!initialTargetDigits) return;

    const stopTimes = createRandomStopTimes(initialTargetDigits.length);
    const startedAt = window.performance.now();
    setDisplayDigits(Array.from({ length: initialTargetDigits.length }, () => "0"));

    const intervalId = window.setInterval(() => {
      const elapsed = window.performance.now() - startedAt;
      const latestTargetDigits = latestTargetDigitsRef.current ?? initialTargetDigits;

      setDisplayDigits((currentDigits) =>
        latestTargetDigits.map((targetDigit, index) => {
          if (elapsed >= (stopTimes[index] ?? COUNTER_SPIN_DURATION_MS)) {
            return targetDigit;
          }

          const currentDigit = Number(currentDigits?.[index] ?? "0");
          const randomOffset = 1 + Math.floor(Math.random() * 9);
          return String((currentDigit + randomOffset) % 10);
        }),
      );
    }, COUNTER_SPIN_INTERVAL_MS);

    const completionTimeoutId = window.setTimeout(() => {
      window.clearInterval(intervalId);
      introCompleteRef.current = true;
      setDisplayDigits(latestTargetDigitsRef.current ?? initialTargetDigits);
    }, COUNTER_SPIN_DURATION_MS);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(completionTimeoutId);
    };
  }, [canStart, hasTarget]);

  useEffect(() => {
    if (target != null && introCompleteRef.current) {
      setDisplayDigits(toCounterDigits(target));
    }
  }, [target]);

  return displayDigits;
}

function AirportDigit({ value, previous }: { value: string; previous: string }) {
  const changed = value !== previous;
  return (
    <span className="airport-counter__cell" aria-hidden="true">
      <span className="airport-counter__digit">{value}</span>
      {changed && (
        <span key={`${previous}-${value}`} className="airport-counter__transition">
          <span className="airport-counter__flap airport-counter__flap--out">{previous}</span>
          <span className="airport-counter__flap airport-counter__flap--in">{value}</span>
        </span>
      )}
    </span>
  );
}

export function LiveEventCounter() {
  const { t, formatNumber } = useTranslation();
  const { count, connected } = useLivePublishedEventCount();
  const brandArrivalComplete = useBrandArrivalComplete();
  const animatedDigits = useIntroAnimatedDigits(count, brandArrivalComplete);
  const digits = animatedDigits ?? Array.from({ length: MIN_COUNTER_DIGITS }, () => "–");
  const previousDigitsRef = useRef(digits);

  useEffect(() => {
    previousDigitsRef.current = digits;
  }, [digits]);

  return (
    <div
      className="airport-counter glass col-span-2 rounded-2xl p-3 md:p-4 lg:col-span-1"
      role="status"
      aria-live="polite"
      aria-label={
        count == null
          ? t("home.liveCounterLoading")
          : t("home.liveCounterAria", { count: formatNumber(count) })
      }
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-primary">
          <Radio className="h-3.5 w-3.5" /> {t("home.liveCounter")}
        </span>
        <span className="inline-flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.16em] text-muted-foreground">
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153)]" : "bg-amber-400"}`}
          />
          {connected ? t("home.live") : t("home.syncing")}
        </span>
      </div>
      <div
        className="airport-counter__board"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${digits.length}, minmax(0, 1fr))` }}
      >
        {digits.split("").map((digit, index) => (
          <AirportDigit
            key={index}
            value={digit}
            previous={previousDigitsRef.current[index] ?? "0"}
          />
        ))}
      </div>
      <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {t("home.eventsOnline")}
      </p>
    </div>
  );
}
