import { useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { getEventArtworkUrl, getGeneratedEventArtworkUrl } from "@/lib/event-artwork";

type EventArtworkImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  eventId: string;
  sourceUrl?: string | null;
  fallback?: ReactNode;
};

/**
 * Keeps a real event image when one exists, then falls back to Global Party's
 * data-driven poster if the source image is absent or no longer available.
 */
export function EventArtworkImage({
  eventId,
  sourceUrl,
  fallback = null,
  ...imageProps
}: EventArtworkImageProps) {
  const generatedUrl = getGeneratedEventArtworkUrl(eventId);
  const preferredUrl = getEventArtworkUrl(eventId, sourceUrl);
  const [failure, setFailure] = useState<{ eventId: string; urls: string[] } | null>(null);
  const failedUrls = failure?.eventId === eventId ? failure.urls : [];
  const currentUrl = [preferredUrl, generatedUrl].find((candidate): candidate is string =>
    Boolean(candidate && !failedUrls.includes(candidate)),
  );

  if (!currentUrl) return <>{fallback}</>;

  return (
    <img
      {...imageProps}
      src={currentUrl}
      onError={() => {
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
