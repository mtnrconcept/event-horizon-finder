import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SocialMedia } from "@/lib/social-queries";

export function SocialMediaGrid({ media }: { media: SocialMedia[] }) {
  if (media.length === 0) return null;

  return (
    <div
      className={cn(
        "grid overflow-hidden border-y bg-muted/40",
        media.length === 1 ? "grid-cols-1" : "grid-cols-2 gap-px bg-border",
      )}
    >
      {media.map((item, index) => {
        const wideFirst = media.length === 3 && index === 0;
        const frameClass = cn(
          "relative overflow-hidden bg-muted",
          media.length === 1 && "aspect-video max-h-[38rem]",
          media.length === 2 && "aspect-[4/5]",
          media.length === 3 && (wideFirst ? "col-span-2 aspect-video" : "aspect-square"),
          media.length >= 4 && "aspect-square",
        );

        if (item.kind === "video") {
          return (
            <div key={item.id} className={frameClass}>
              <video
                src={item.public_url}
                controls
                playsInline
                preload="metadata"
                aria-label={item.alt_text ?? "Vidéo de la publication"}
                className="h-full w-full bg-black object-contain"
              />
              <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/55 p-1.5 text-white">
                <Play className="h-3.5 w-3.5 fill-current" />
              </div>
            </div>
          );
        }

        return (
          <div key={item.id} className={frameClass}>
            <img
              src={item.public_url}
              alt={item.alt_text ?? "Photo de la publication"}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 hover:scale-[1.02]"
            />
          </div>
        );
      })}
    </div>
  );
}
