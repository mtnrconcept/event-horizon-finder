import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Accessibility,
  CalendarCheck2,
  Clock3,
  ExternalLink,
  Globe2,
  Images,
  Info,
  Landmark,
  LoaderCircle,
  MapPin,
  Navigation,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { safeExternalUrl } from "@/lib/map-event-details";
import { placeDisplayDescription } from "@/lib/place-description";
import {
  fetchPlaceDetail,
  placeCategoryColor,
  placeCategoryLabel,
  placeIsAccessible,
  placeIsFree,
  type PlaceOfInterest,
} from "@/lib/place-discovery";
import { useTranslation } from "@/lib/i18n";

function DetailSection({ icon: Icon, title, children }: { icon: typeof Landmark; title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border bg-surface p-4 sm:p-5">
      <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wide">
        <Icon className="h-4 w-4 text-primary" /> {title}
      </h3>
      <div className="mt-3 text-sm leading-6 text-foreground/85">{children}</div>
    </section>
  );
}

export function PlaceDetailDialog({ open, place, onOpenChange }: { open: boolean; place: PlaceOfInterest | null; onOpenChange: (open: boolean) => void }) {
  const { tr } = useTranslation();
  const [resolvedPlace, setResolvedPlace] = useState<PlaceOfInterest | null>(place);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    setResolvedPlace(place);
    if (!open || !place?.id) return;
    const controller = new AbortController();
    setDetailLoading(true);
    void fetchPlaceDetail(place.id, controller.signal)
      .then((detail) => {
        if (detail) setResolvedPlace(detail);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [open, place]);

  const current = resolvedPlace ?? place;
  const categoryColor = current ? placeCategoryColor(current.category) : "#0f766e";
  const website = safeExternalUrl(current?.website ?? null);
  const bookingUrl = safeExternalUrl(current?.booking_url ?? null);
  const sourceUrl = safeExternalUrl(current?.source_url ?? null);
  const itineraryUrl = current
    ? `https://www.openstreetmap.org/?mlat=${current.latitude}&mlon=${current.longitude}#map=17/${current.latitude}/${current.longitude}`
    : null;
  const accessible = current ? placeIsAccessible(current) : false;
  const free = current ? placeIsFree(current) : false;
  const description = current ? placeDisplayDescription(current) : null;
  const photos = useMemo(() => {
    if (!current) return [];
    return [...new Set([...(current.image_urls ?? []), current.image_url].filter((value): value is string => Boolean(value)))].slice(0, 12);
  }, [current]);
  const sources = useMemo(() => {
    if (!current) return [];
    const rich = current.content_sources ?? [];
    const fallback = (current.source_urls ?? []).map((url, index) => ({ label: `${tr("Source")} ${index + 1}`, url, provider: null }));
    const merged = [...rich, ...fallback];
    const seen = new Set<string>();
    return merged.filter((source) => {
      const url = safeExternalUrl(source.url);
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }, [current, tr]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tr("Fermer la fiche")} className="map-event-dialog grid h-[min(94dvh,58rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-3xl border-border bg-background p-0 shadow-2xl">
        {current ? (
          <>
            <div className="relative h-[min(15rem,28dvh)] shrink-0 overflow-hidden" style={{ background: `linear-gradient(145deg, ${categoryColor}55, ${categoryColor})` }}>
              <div className="absolute inset-0 grid place-items-center text-white/85"><Landmark className="h-16 w-16" aria-hidden="true" /></div>
              {photos[0] && <img src={photos[0]} alt={current.name} loading="eager" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" />}
              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/15 to-black/10" />
              {detailLoading && <div className="absolute right-14 top-4 rounded-full bg-black/60 p-2 text-white"><LoaderCircle className="h-4 w-4 animate-spin" /></div>}
            </div>

            <div className="min-h-0 overflow-y-auto overscroll-contain p-4 pt-3 sm:p-6 sm:pt-3">
              <DialogDescription className="sr-only">{tr("Informations complètes du lieu sélectionné")}</DialogDescription>
              <div className="flex flex-wrap items-center gap-2 pr-10">
                <Badge className="border-transparent bg-primary/15 text-primary">{tr("Lieu à visiter")}</Badge>
                <Badge variant="outline">{placeCategoryLabel(current.category)}</Badge>
                {free && <Badge>{tr("Gratuit")}</Badge>}
                {accessible && <Badge variant="outline" className="gap-1"><Accessibility className="h-3 w-3" /> {tr("Accessible")}</Badge>}
              </div>

              <DialogTitle className="mt-3 pr-8 text-2xl font-black leading-tight sm:text-3xl">{current.name}</DialogTitle>
              <p className="mt-3 whitespace-pre-line text-sm leading-6 text-muted-foreground sm:text-base">{description}</p>

              <div className="mt-5 flex flex-wrap gap-2">
                {bookingUrl && <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-secondary px-4 py-2 text-sm font-black text-secondary-foreground"><CalendarCheck2 className="h-4 w-4" /> {tr("Réserver")} <ExternalLink className="h-3.5 w-3.5" /></a>}
                {itineraryUrl && <a href={itineraryUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-black text-primary-foreground"><Navigation className="h-4 w-4" /> {tr("Itinéraire")} <ExternalLink className="h-3.5 w-3.5" /></a>}
                {website && <a href={website} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-2 rounded-xl border bg-surface px-4 py-2 text-sm font-black hover:border-primary"><Globe2 className="h-4 w-4" /> {tr("Site officiel")} <ExternalLink className="h-3.5 w-3.5" /></a>}
              </div>

              {photos.length > 1 && (
                <DetailSection icon={Images} title={tr("Photos du lieu")}>
                  <div className="no-scrollbar flex snap-x gap-3 overflow-x-auto pb-1">
                    {photos.map((photo, index) => <a key={photo} href={photo} target="_blank" rel="noopener noreferrer" className="block w-52 shrink-0 snap-start overflow-hidden rounded-xl border"><img src={photo} alt={`${current.name} — ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" className="h-32 w-full object-cover" /></a>)}
                  </div>
                </DetailSection>
              )}

              <div className="mt-6 grid gap-3 md:grid-cols-2">
                <DetailSection icon={MapPin} title={tr("Adresse et localisation")}><div className="grid gap-2"><p className="font-black">{current.address ?? tr("Adresse non renseignée")}</p><p className="text-xs text-muted-foreground">{current.latitude.toFixed(5)}, {current.longitude.toFixed(5)}</p></div></DetailSection>
                <DetailSection icon={Clock3} title={tr("Horaires et accès")}><dl className="grid gap-2"><div><dt className="text-xs font-black uppercase text-muted-foreground">{tr("Horaires")}</dt><dd className="mt-1">{current.opening_hours ?? tr("À vérifier sur place")}</dd></div><div><dt className="text-xs font-black uppercase text-muted-foreground">{tr("Tarif")}</dt><dd className="mt-1">{free ? tr("Gratuit") : (current.fee ?? tr("Non renseigné"))}</dd></div><div><dt className="text-xs font-black uppercase text-muted-foreground">{tr("Fauteuil roulant")}</dt><dd className="mt-1">{current.wheelchair ?? tr("Non renseigné")}</dd></div></dl></DetailSection>
                <DetailSection icon={Info} title={tr("Informations sur le lieu")}><dl className="grid gap-2"><div><dt className="text-xs font-black uppercase text-muted-foreground">{tr("Catégorie")}</dt><dd className="mt-1">{placeCategoryLabel(current.category)}</dd></div>{current.subcategory && <div><dt className="text-xs font-black uppercase text-muted-foreground">{tr("Sous-catégorie")}</dt><dd className="mt-1">{current.subcategory.replaceAll("_", " ")}</dd></div>}</dl></DetailSection>
                <DetailSection icon={Globe2} title={tr("Origine des informations")}>
                  <div className="grid gap-2">
                    <p className="text-muted-foreground">{tr("Informations regroupées depuis OpenStreetMap, des sites officiels, des guides touristiques et des sources publiques attribuées.")}</p>
                    {sources.map((source) => { const url = safeExternalUrl(source.url); return url ? <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-black text-primary hover:underline">{source.label} <ExternalLink className="h-3.5 w-3.5" /></a> : null; })}
                    {sourceUrl && !sources.some((source) => safeExternalUrl(source.url) === sourceUrl) && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-black text-primary hover:underline">{tr("Voir la source cartographique")} <ExternalLink className="h-3.5 w-3.5" /></a>}
                  </div>
                </DetailSection>
              </div>
            </div>
          </>
        ) : (
          <div className="grid min-h-64 place-items-center p-8 text-center"><DialogTitle>{tr("Lieu sélectionné")}</DialogTitle><DialogDescription>{tr("Les informations de ce lieu sont indisponibles.")}</DialogDescription></div>
        )}
      </DialogContent>
    </Dialog>
  );
}