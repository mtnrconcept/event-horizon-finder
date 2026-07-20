const HOUR_MS = 3_600_000;

export function failureRetryDelayMs(message: string, syncFrequency: string | null): number {
  const weekly = syncFrequency === "weekly";

  // These failures generally require a catalog/configuration change. Retrying
  // them every 30 minutes only hammers a missing or deliberately blocked URL.
  if (
    /direct_http_(?:401|403|404|410)\b|direct_off_domain_url|direct_response_too_large|invalid peer certificate|failed to lookup address information/i.test(
      message,
    )
  ) {
    return (weekly ? 7 * 24 : 24) * HOUR_MS;
  }

  // Network pressure and upstream outages can recover without intervention,
  // but still deserve substantially more breathing room than the scheduler.
  if (/direct_timeout|direct_http_(?:429|5\d\d)\b|error sending request/i.test(message)) {
    return (weekly ? 24 : 2) * HOUR_MS;
  }

  return (weekly ? 6 : 0.5) * HOUR_MS;
}
