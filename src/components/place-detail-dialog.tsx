import type { ReactNode } from "react";
import {
  Accessibility,
  Clock3,
  ExternalLink,
  Globe2,
  Info,
  Landmark,
  MapPin,
  Navigation,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { safeExternalUrl } from "@/lib/map-event-details";
import {
  placeCategoryColor,
  placeCategoryLabel,
  placeIsAccessible,
  placeIsFree,
  type PlaceOfInterest,
} from "@/lib/place-discovery";
import { useTranslation } from "@/lib/i18n";

function DetailSection({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Landmark;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-surface p-4 sm:p-5">
      <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-wide">
        <Icon className="h-4 w-4 text-primary" /> {title}
      </h3>
      <div className="mt-3 text-sm leading-6 text-foreground/85">{children}</div>
    </section>
  );
}

export function PlaceDetailDialog({
  open,
  place,
  onOpenChange,
}: {
  open: boolean;
  place: PlaceOfInterest | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { tr } = useTranslation();
  const categoryColor = place ? placeCategoryColor(place.category) : "#0f766e";
  const website = safeExternalUrl(place?.website ?? null);
  const sourceUrl = safeExternalUrl(place?.source_url ?? null);
  const itineraryUrl = place
    ? `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=17/${place.latitude}/${place.longitude}`
    : null;
  const accessible = place ? placeIsAccessible(place) : false;
  const free = place ? placeIsFree(place) : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={tr("Fermer la fiche")}
        className="map-event-dialog grid h-[min(94dvh,54rem)] max-w-4xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-3xl border-border bg-background p-0 shadow-2xl"
      >
        {place ? (
          <>
            <div
              className="relative h-[min(13rem,25dvh)] shrink-0 overflow-hidden"
              style={{
                background: `linear-gradient(145deg, ${categoryColor}55, ${categoryColor})`,
              }}
            >
              <div className="absolute inset-0 grid place-items-center text-white/85">
                <Landmark className="h-16 w-16" aria-hidden="true" />
              </div>
              {place.image_url && (
                <img
                  src={place.image_url}
                  alt=""
                  loading="eager"
                  referrerPolicy="no-referrer"
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/15 to-black/10" />
            </div>

            <div className="min-h-0 overflow-y-auto overscroll-contain p-4 pt-3 sm:p-6 sm:pt-3">
              <DialogDescription className="sr-only">
                {tr("Informations complètes du lieu sélectionné")}
              </DialogDescription>
              <div className="flex flex-wrap items-center gap-2 pr-10">
                <Badge className="border-transparent bg-primary/15 text-primary">
                  {tr("Lieu à visiter")}
                </Badge>
                <Badge variant="outline">{placeCategoryLabel(place.category)}</Badge>
                {free && <Badge>{tr("Gratuit")}</Badge>}
                {accessible && (
                  <Badge variant="outline" className="gap-1">
                    <Accessibility className="h-3 w-3" /> {tr("Accessible")}
                  </Badge>
                )}
              </div>

              <DialogTitle className="mt-3 pr-8 text-2xl font-black leading-tight sm:text-3xl">
                {place.name}
              </DialogTitle>
              {place.description && (
                <p className="mt-3 whitespace-pre-line text-sm leading-6 text-muted-foreground sm:text-base">
                  {place.description}
                </p>
              )}

              <div className="mt-5 flex flex-wrap gap-2">
                {itineraryUrl && (
                  <a
                    href={itineraryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-black text-primary-foreground"
                  >
                    <Navigation className="h-4 w-4" /> {tr("Itinéraire")}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {website && (
                  <a
                    href={website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-11 items-center gap-2 rounded-xl border bg-surface px-4 py-2 text-sm font-black hover:border-primary"
                  >
                    <Globe2 className="h-4 w-4" /> {tr("Site officiel")}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>

              <div className="mt-6 grid gap-3 md:grid-cols-2">
                <DetailSection icon={MapPin} title={tr("Adresse et localisation")}>
                  <div className="grid gap-2">
                    <p className="font-black">{place.address ?? tr("Adresse non renseignée")}</p>
                    <p className="text-xs text-muted-foreground">
                      {place.latitude.toFixed(5)}, {place.longitude.toFixed(5)}
                    </p>
                  </div>
                </DetailSection>

                <DetailSection icon={Clock3} title={tr("Horaires et accès")}>
                  <dl className="grid gap-2">
                    <div>
                      <dt className="text-xs font-black uppercase text-muted-foreground">
                        {tr("Horaires")}
                      </dt>
                      <dd className="mt-1">
                        {place.opening_hours ?? tr("À vérifier sur place")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-black uppercase text-muted-foreground">
                        {tr("Tarif")}
                      </dt>
                      <dd className="mt-1">
                        {free ? tr("Gratuit") : place.fee ?? tr("Non renseigné")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-black uppercase text-muted-foreground">
                        {tr("Fauteuil roulant")}
                      </dt>
                      <dd className="mt-1">{place.wheelchair ?? tr("Non renseigné")}</dd>
                    </div>
                  </dl>
                </DetailSection>

                <DetailSection icon={Info} title={tr("Informations sur le lieu")}>
                  <dl className="grid gap-2">
                    <div>
                      <dt className="text-xs font-black uppercase text-muted-foreground">
                        {tr("Catégorie")}
                      </dt>
                      <dd className="mt-1">{placeCategoryLabel(place.category)}</dd>
                    </div>
                    {place.subcategory && (
                      <div>
                        <dt className="text-xs font-black uppercase text-muted-foreground">
                          {tr("Sous-catégorie")}
                        </dt>
                        <dd className="mt-1">{place.subcategory.replaceAll("_", " ")}</dd>
                      </div>
                    )}
                  </dl>
                </DetailSection>

                <DetailSection icon={Globe2} title={tr("Origine des informations")}>
                  <div className="grid gap-2">
                    <p className="text-muted-foreground">
                      {tr(
                        "Données géographiques issues d’OpenStreetMap et des informations publiques du lieu.",
                      )}
                    </p>
                    {sourceUrl && (
                      <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-black text-primary hover:underline"
                      >
                        {tr("Voir la source")} <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </DetailSection>
              </div>
            </div>
          </>
        ) : (
          <div className="grid min-h-64 place-items-center p-8 text-center">
            <DialogTitle>{tr("Lieu sélectionné")}</DialogTitle>
            <DialogDescription>
              {tr("Les informations de ce lieu sont indisponibles.")}
            </DialogDescription>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
