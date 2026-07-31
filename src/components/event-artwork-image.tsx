import { useState, type ImgHTMLAttributes, type ReactNode } from "react";
import {
  getLocalEventArtworkUrl,
  getSafeEventArtworkSourceUrl,
  hasFailedEventArtworkUrl,
  rememberFailedEventArtworkUrl,
} from "@/lib/event-artwork";

type EventArtworkImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  eventId: string;
  sourceUrl?: string | null;
  fallback?: ReactNode;
};

/**
 * Keeps a real event image when one exists, then falls back without another
 * network request. Failed origins are remembered globally so a broken image
 * referenced by many cards is not downloaded over and over.
 */
export function EventArtworkImage({
  eventId,
  sourceUrl,
  fallback = null,
  ...imageProps
}: EventArtworkImageProps) {
  const preferredUrl = getSafeEventArtworkSourceUrl(sourceUrl);
  const localUrl = fallback === null ? getLocalEventArtworkUrl(eventId) : null;
  const [failure, setFailure] = useState<{ eventId: string; urls: string[] } | null>(null);
  const failedUrls = failure?.eventId === eventId ? failure.urls : [];
  const currentUrl = [preferredUrl, localUrl].find((candidate): candidate is string =>
    Boolean(candidate && !failedUrls.includes(candidate) && !hasFailedEventArtworkUrl(candidate)),
  );

  if (!currentUrl) return <>{fallback}</>;

  return (
    <img
      {...imageProps}
      src={currentUrl}
      onError={() => {
        rememberFailedEventArtworkUrl(currentUrl);
        setFailure((current) => ({
          eventId,
          urls:
            current?.eventId === eventId
              ? Array.from(new Set([...current.urls, currentUrl]))
              : [currentUrl],
        }));
      }}
    />
  );
}
