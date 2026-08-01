import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import {
  BadgeCheck,
  CalendarDays,
  ExternalLink,
  Globe2,
  Images,
  Info,
  MapPin,
  Navigation,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VenueEventList } from "@/components/venue-event-list";
import { safeExternalUrl } from "@/lib/map-event-details";
import { useTranslation } from "@/lib/i18n";
import { fetchVenueDetail, type VenueDetail } from "@/lib/venue-detail";

// @ts-ignore Route type is generated during the production build.
export const Route = createFileRoute("/venue/$slug")({
  loader: async ({ params }): Promise<VenueDetail> => {
    const venue = await fetchVenueDetail(params.slug);
    if (!venue) throw notFound();
    return venue;
  },
  head: ({ loaderData }) => {
    const venue = loaderData as VenueDetail | undefined;
    if (!venue) {
      return {
        meta: [
          { title: "Lieu introuvable — Global Party" },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const image =
      venue.cover_image_url ??
      venue.media.find((media) => media.media_type === "image")?.url ??
      null;
    return {
      meta: [
        { title: `${venue.name} — Global Party` },
        {
          name: "description",
          content:
            venue.description ??
            `${venue.name}, événements et informations pratiques sur Global Party.`,
        },
        { property: "og:title", content: venue.name },
        { property: "og:description", content: venue.description ?? "" },
        ...(image ? ([{ property: "og:image", content: image }] as const) : []),
      ],
    };
  },
  notFoundComponent: VenueNotFound,
  component: VenueDetailPage,
});

function VenueNotFound() {
  const { tr } = useTranslation();
  return (
    <div className="mx-auto max-w-xl p-10 text-center">
      <h1 className="text-2xl font-black">{tr("Lieu introuvable")}</h1>
      <Link to="/map" className="mt-4 inline-flex font-black text-primary hover:underline">
        {tr("Retour à la carte")}
      </Link>
    </div>
  );
}

function VenueDetailPage() {
  const venue = Route.useLoaderData() as VenueDetail;
  const { tr } = useTranslation();
  const website = safeExternalUrl(venue.website);
  const itinerary =
    venue.latitude != null && venue.longitude != null
      ? `https://www.openstreetmap.org/?mlat=${venue.latitude}&mlon=${venue.longitude}#map=17/${venue.latitude}/${venue.longitude}`
      : null;
  const photos = [
    ...new Set(
      [
        venue.cover_image_url,
        ...venue.media
          .filter((media) => media.media_type === "image")
          .sort((left, right) => Number(right.is_primary) - Number(left.is_primary))
          .map((media) => media.url),
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  const heroImage = photos[0] ?? null;
  const location = [venue.address, venue.postal_code, venue.city.name].filter(Boolean).join(" · ");

  return (
    <div className="mx-auto max-w-6xl pb-28">
      <div className="relative h-[min(28rem,48dvh)] overflow-hidden bg-[linear-gradient(135deg,var(--color-accent),var(--color-primary))]">
        <div className="absolute inset-0 grid place-items-center text-primary-foreground/70">
          <MapPin className="h-20 w-20" />
        </div>
        {heroImage && (
          <img
            src={heroImage}
            alt={venue.name}
            loading="eager"
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/25 to-black/20" />
      </div>

      <div className="px-4 sm:px-6 lg:px-8">
        <div className="relative -mt-16 rounded-3xl border bg-background/95 p-5 shadow-2xl backdrop-blur sm:p-7">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="border-transparent bg-primary/15 text-primary">{tr("Lieu")}</Badge>
            {venue.is_verified && (
              <Badge variant="outline" className="gap-1">
                <BadgeCheck className="h-3.5 w-3.5" /> {tr("Vérifié")}
              </Badge>
            )}
            <Badge variant="outline" className="gap-1">
              <CalendarDays className="h-3.5 w-3.5" />
              {tr("{count} événements à venir", { count: venue.upcoming_events.length })}
            </Badge>
          </div>

          <h1 className="mt-3 text-3xl font-black leading-tight sm:text-5xl">{venue.name}</h1>
          {location && (
            <p className="mt-2 flex items-start gap-2 text-sm text-muted-foreground sm:text-base">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> {location}
            </p>
          )}

          <div className="mt-5 flex flex-wrap gap-2">
            {itinerary && (
              <a
                href={itinerary}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-black text-primary-foreground"
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
                className="inline-flex min-h-11 items-center gap-2 rounded-xl border bg-surface px-4 text-sm font-black hover:border-primary"
              >
                <Globe2 className="h-4 w-4" /> {tr("Site officiel")}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>

        <Tabs defaultValue="upcoming" className="mt-6">
          <TabsList className="no-scrollbar h-auto w-full justify-start overflow-x-auto rounded-2xl p-1.5">
            <TabsTrigger value="upcoming" className="min-h-10 gap-1.5">
              <CalendarDays className="h-4 w-4" /> {tr("À venir")} ({venue.upcoming_events.length})
            </TabsTrigger>
            <TabsTrigger value="about" className="min-h-10 gap-1.5">
              <Info className="h-4 w-4" /> {tr("À propos")}
            </TabsTrigger>
            <TabsTrigger value="past" className="min-h-10 gap-1.5">
              <CalendarDays className="h-4 w-4" /> {tr("Passés")} ({venue.past_events.length})
            </TabsTrigger>
            <TabsTrigger value="photos" className="min-h-10 gap-1.5">
              <Images className="h-4 w-4" /> {tr("Photos")} ({photos.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="upcoming" className="mt-5">
            <VenueEventList
              events={venue.upcoming_events}
              emptyLabel={tr("Aucun événement à venir n’est encore référencé pour ce lieu.")}
            />
          </TabsContent>

          <TabsContent value="about" className="mt-5">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
              <section className="rounded-3xl border bg-surface p-5 sm:p-7">
                <h2 className="text-xl font-black">{tr("Présentation du lieu")}</h2>
                <p className="mt-3 whitespace-pre-line text-sm leading-7 text-muted-foreground sm:text-base">
                  {venue.description ?? tr("Description en cours d’enrichissement.")}
                </p>
              </section>

              <aside className="grid gap-4">
                <section className="rounded-3xl border bg-surface p-5">
                  <h2 className="flex items-center gap-2 font-black">
                    <MapPin className="h-4 w-4 text-primary" /> {tr("Informations pratiques")}
                  </h2>
                  <dl className="mt-3 grid gap-3 text-sm">
                    <div>
                      <dt className="text-xs font-black uppercase text-muted-foreground">
                        {tr("Adresse")}
                      </dt>
                      <dd className="mt-1">{location || tr("Adresse non renseignée")}</dd>
                    </div>
                    {venue.capacity != null && (
                      <div>
                        <dt className="flex items-center gap-1 text-xs font-black uppercase text-muted-foreground">
                          <Users className="h-3.5 w-3.5" /> {tr("Capacité")}
                        </dt>
                        <dd className="mt-1">{venue.capacity.toLocaleString("fr-CH")}</dd>
                      </div>
                    )}
                  </dl>
                </section>

                <section className="rounded-3xl border bg-surface p-5">
                  <h2 className="flex items-center gap-2 font-black">
                    <Globe2 className="h-4 w-4 text-primary" /> {tr("Sources")}
                  </h2>
                  <div className="mt-3 grid gap-2 text-sm">
                    {venue.sources.map((source) => {
                      const url = safeExternalUrl(source.source_url);
                      return url ? (
                        <a
                          key={source.id}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-black text-primary hover:underline"
                        >
                          {source.source_name ?? source.domain}
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : null;
                    })}
                    {!venue.sources.length && (
                      <p className="text-muted-foreground">
                        {tr("Sources en cours de vérification.")}
                      </p>
                    )}
                  </div>
                </section>
              </aside>
            </div>
          </TabsContent>

          <TabsContent value="past" className="mt-5">
            <VenueEventList
              events={venue.past_events}
              emptyLabel={tr("Aucun événement passé n’est encore référencé pour ce lieu.")}
            />
          </TabsContent>

          <TabsContent value="photos" className="mt-5">
            {photos.length ? (
              <div className="columns-1 gap-4 sm:columns-2 lg:columns-3">
                {photos.map((photo) => {
                  const media = venue.media.find((item) => item.url === photo);
                  return (
                    <figure
                      key={photo}
                      className="mb-4 break-inside-avoid overflow-hidden rounded-2xl border bg-surface"
                    >
                      <a href={photo} target="_blank" rel="noopener noreferrer">
                        <img
                          src={photo}
                          alt={venue.name}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="h-auto w-full object-cover"
                        />
                      </a>
                      {(media?.attribution || media?.license || media?.source_url) && (
                        <figcaption className="p-3 text-xs leading-5 text-muted-foreground">
                          {[media.attribution, media.license].filter(Boolean).join(" · ")}
                          {media.source_url && (
                            <a
                              href={media.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="ml-1 font-black text-primary hover:underline"
                            >
                              {tr("Source")}
                            </a>
                          )}
                        </figcaption>
                      )}
                    </figure>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed p-8 text-center text-muted-foreground">
                {tr("Aucune photo réutilisable n’a encore été trouvée pour ce lieu.")}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <div className="mt-8 text-sm">
          <Link to="/map" className="font-black text-primary hover:underline">
            ← {tr("Retour à la carte")}
          </Link>
        </div>
      </div>
    </div>
  );
}
