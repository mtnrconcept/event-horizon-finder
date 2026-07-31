import { MUSIC_GENRES } from "./event-filters.ts";
import type { AppLocale } from "./i18n.tsx";
import { translateGenre } from "./taxonomy-translations.ts";

type LocalizedSearchLabel = Partial<Record<AppLocale, string>> & { fr: string; en: string };

export type SearchSubcategoryKind = "facet" | "genre";

export interface SearchSubcategory {
  slug: string;
  icon: string;
  kind: SearchSubcategoryKind;
  labels: LocalizedSearchLabel;
  filterValues: readonly string[];
}

export interface SearchCategory {
  slug: string;
  icon: string;
  color: string;
  labels: LocalizedSearchLabel;
  eventCategorySlugs: readonly string[];
  defaultFacetValues: readonly string[];
  subcategories: readonly SearchSubcategory[];
}

function labels(
  fr: string,
  en: string,
  translations: Partial<Record<Exclude<AppLocale, "fr" | "en">, string>> = {},
): LocalizedSearchLabel {
  return { fr, en, ...translations };
}

function facet(slug: string, fr: string, en: string, icon: string): SearchSubcategory {
  return { slug, icon, kind: "facet", labels: labels(fr, en), filterValues: [slug] };
}

const MUSIC_SUBCATEGORIES: readonly SearchSubcategory[] = MUSIC_GENRES.map(([slug, label]) => ({
  slug,
  icon: "♪",
  kind: "genre" as const,
  labels: labels(label, label),
  filterValues: slug === "electro" ? ["electro", "electronic"] : [slug],
}));

export const SEARCH_CATEGORIES: readonly SearchCategory[] = [
  {
    slug: "family",
    icon: "👪",
    color: "#f59e0b",
    labels: labels("Famille", "Family", {
      pl: "Rodzina",
      it: "Famiglia",
      ru: "Для семьи",
      es: "Familia",
    }),
    eventCategorySlugs: ["famille", "cinema", "leisure", "activities", "sports-outdoor"],
    defaultFacetValues: ["family"],
    subcategories: [
      facet("family-cinema", "Cinéma en famille", "Family cinema", "🎬"),
      facet("amusement-parks", "Parcs d’attractions", "Amusement parks", "🎢"),
      facet("parks-leisure", "Parcs et loisirs", "Parks and recreation", "🌳"),
      facet("family-events", "Manifestations familiales", "Family events", "🎈"),
      facet("water-play", "Jeux d’eau", "Water play", "💦"),
      facet("zoo-aquarium", "Zoos et aquariums", "Zoos and aquariums", "🦁"),
      facet("kids-shows", "Spectacles pour enfants", "Children's shows", "🎭"),
      facet("family-workshops", "Ateliers créatifs", "Creative workshops", "🎨"),
      facet("educational-activities", "Activités éducatives", "Educational activities", "🧠"),
      facet("circus", "Cirque", "Circus", "🎪"),
      facet("farms-animals", "Fermes et animaux", "Farms and animals", "🐑"),
      facet("playgrounds", "Aires de jeux", "Playgrounds", "🛝"),
      facet("family-science", "Sciences et découvertes", "Science and discovery", "🔭"),
    ],
  },
  {
    slug: "culture",
    icon: "🏛️",
    color: "#8b5cf6",
    labels: labels("Culture & patrimoine", "Culture & heritage", {
      pl: "Kultura i dziedzictwo",
      it: "Cultura e patrimonio",
      ru: "Культура и наследие",
      es: "Cultura y patrimonio",
    }),
    eventCategorySlugs: ["expositions", "theatre", "heritage", "cinema"],
    defaultFacetValues: [],
    subcategories: [
      facet("museums", "Musées", "Museums", "🏛️"),
      facet("historical-sites", "Sites historiques", "Historical sites", "🏰"),
      facet("art", "Art", "Art", "🎨"),
      facet("exhibitions", "Expositions", "Exhibitions", "🖼️"),
      facet("theatre-shows", "Théâtre et spectacles", "Theatre and shows", "🎭"),
      facet("dance", "Danse", "Dance", "💃"),
      facet("cinema-screenings", "Cinéma et projections", "Cinema and screenings", "🎬"),
      facet("literature", "Littérature et lecture", "Literature and reading", "📚"),
      facet("architecture", "Architecture", "Architecture", "🏙️"),
      facet("photography", "Photographie", "Photography", "📷"),
      facet("heritage-tours", "Visites patrimoniales", "Heritage tours", "🗺️"),
      facet("opera-lyric", "Opéra et art lyrique", "Opera and lyric arts", "🎼"),
    ],
  },
  {
    slug: "music",
    icon: "🎵",
    color: "#ec4899",
    labels: labels("Musique & concerts", "Music & concerts", {
      pl: "Muzyka i koncerty",
      it: "Musica e concerti",
      ru: "Музыка и концерты",
      es: "Música y conciertos",
    }),
    eventCategorySlugs: ["concerts", "festivals", "soirees"],
    defaultFacetValues: ["music"],
    subcategories: MUSIC_SUBCATEGORIES,
  },
  {
    slug: "sports-outdoors",
    icon: "🏃",
    color: "#22c55e",
    labels: labels("Sport & plein air", "Sports & outdoors", {
      pl: "Sport i plener",
      it: "Sport e attività all’aperto",
      ru: "Спорт и отдых",
      es: "Deporte y aire libre",
    }),
    eventCategorySlugs: ["sports-outdoor"],
    defaultFacetValues: [],
    subcategories: [
      facet("football", "Football", "Football", "⚽"),
      facet("running", "Course à pied", "Running", "🏃"),
      facet("cycling", "Vélo et cyclisme", "Cycling", "🚲"),
      facet("hiking", "Randonnée", "Hiking", "🥾"),
      facet("water-sports", "Sports nautiques", "Water sports", "🏄"),
      facet("winter-sports", "Sports d’hiver", "Winter sports", "⛷️"),
      facet("fitness", "Fitness", "Fitness", "🏋️"),
      facet("yoga", "Yoga", "Yoga", "🧘"),
      facet("racket-sports", "Sports de raquette", "Racket sports", "🎾"),
      facet("combat-sports", "Sports de combat", "Combat sports", "🥋"),
      facet("motorsports", "Sports mécaniques", "Motorsports", "🏎️"),
      facet("team-sports", "Sports collectifs", "Team sports", "🏀"),
      facet("golf", "Golf", "Golf", "⛳"),
      facet("nature-excursions", "Excursions nature", "Nature excursions", "🌲"),
    ],
  },
  {
    slug: "food-drink",
    icon: "🍴",
    color: "#f97316",
    labels: labels("Gastronomie & boissons", "Food & drink", {
      pl: "Jedzenie i napoje",
      it: "Gastronomia e bevande",
      ru: "Еда и напитки",
      es: "Gastronomía y bebidas",
    }),
    eventCategorySlugs: ["gastronomy"],
    defaultFacetValues: [],
    subcategories: [
      facet("markets", "Marchés", "Markets", "🧺"),
      facet("gastronomy", "Gastronomie", "Gastronomy", "🍽️"),
      facet("tastings", "Dégustations", "Tastings", "🥄"),
      facet("wine", "Vin et œnologie", "Wine", "🍷"),
      facet("beer", "Bière et brasseries", "Beer and breweries", "🍺"),
      facet("brunch", "Brunch", "Brunch", "🥐"),
      facet("cooking-workshops", "Ateliers cuisine", "Cooking workshops", "👩‍🍳"),
      facet("street-food", "Street food", "Street food", "🌮"),
      facet("food-festivals", "Festivals gourmands", "Food festivals", "🎪"),
      facet("coffee-tea", "Café et thé", "Coffee and tea", "☕"),
    ],
  },
  {
    slug: "learning",
    icon: "💡",
    color: "#0ea5e9",
    labels: labels("Ateliers, savoirs & rencontres", "Workshops, learning & meetups", {
      pl: "Warsztaty, nauka i spotkania",
      it: "Laboratori, formazione e incontri",
      ru: "Мастер-классы, знания и встречи",
      es: "Talleres, aprendizaje y encuentros",
    }),
    eventCategorySlugs: ["activities", "conferences"],
    defaultFacetValues: [],
    subcategories: [
      facet("workshops", "Ateliers", "Workshops", "🛠️"),
      facet("conferences", "Conférences", "Conferences", "🎤"),
      facet("networking", "Networking", "Networking", "🤝"),
      facet("technology", "Technologie", "Technology", "💻"),
      facet("career", "Carrière et emploi", "Career and jobs", "💼"),
      facet("science", "Sciences", "Science", "🔬"),
      facet("languages", "Langues", "Languages", "🗣️"),
      facet("entrepreneurship", "Entrepreneuriat", "Entrepreneurship", "🚀"),
      facet("crafts", "Artisanat", "Crafts", "🧵"),
    ],
  },
  {
    slug: "leisure",
    icon: "🎯",
    color: "#14b8a6",
    labels: labels("Jeux & loisirs", "Games & leisure", {
      pl: "Gry i rozrywka",
      it: "Giochi e tempo libero",
      ru: "Игры и досуг",
      es: "Juegos y ocio",
    }),
    eventCategorySlugs: ["leisure", "activities"],
    defaultFacetValues: ["leisure"],
    subcategories: [
      facet("board-games", "Jeux de société", "Board games", "🎲"),
      facet("video-games", "Jeux vidéo et e-sport", "Video games and esports", "🎮"),
      facet("escape-games", "Escape games", "Escape games", "🔐"),
      facet("bowling", "Bowling", "Bowling", "🎳"),
      facet("comedy", "Humour", "Comedy", "😂"),
      facet("fairs", "Foires et fêtes foraines", "Fairs and funfairs", "🎡"),
      facet("creative-hobbies", "Loisirs créatifs", "Creative hobbies", "✂️"),
      facet("shopping", "Shopping et salons", "Shopping and shows", "🛍️"),
      facet("karaoke", "Karaoké", "Karaoke", "🎤"),
    ],
  },
  {
    slug: "wellness",
    icon: "🧘",
    color: "#10b981",
    labels: labels("Bien-être", "Wellness", {
      pl: "Dobre samopoczucie",
      it: "Benessere",
      ru: "Благополучие",
      es: "Bienestar",
    }),
    eventCategorySlugs: ["activities", "leisure", "sports-outdoor"],
    defaultFacetValues: ["wellness"],
    subcategories: [
      facet("meditation", "Méditation", "Meditation", "🕯️"),
      facet("spa", "Spa et détente", "Spa and relaxation", "♨️"),
      facet("mental-health", "Santé mentale", "Mental health", "💚"),
      facet("holistic", "Pratiques holistiques", "Holistic practices", "🌿"),
      facet("dance-fitness", "Danse et remise en forme", "Dance fitness", "💃"),
      facet("nature-retreats", "Retraites nature", "Nature retreats", "🏕️"),
    ],
  },
  {
    slug: "community",
    icon: "🎪",
    color: "#eab308",
    labels: labels("Festivals & vie locale", "Festivals & community", {
      pl: "Festiwale i życie lokalne",
      it: "Festival e vita locale",
      ru: "Фестивали и местная жизнь",
      es: "Festivales y vida local",
    }),
    eventCategorySlugs: ["festivals", "other"],
    defaultFacetValues: ["community"],
    subcategories: [
      facet("music-festivals", "Festivals de musique", "Music festivals", "🎵"),
      facet("cultural-festivals", "Festivals culturels", "Cultural festivals", "🎭"),
      facet("family-festivals", "Festivals familiaux", "Family festivals", "👪"),
      facet("local-fairs", "Fêtes et foires locales", "Local fairs", "🎠"),
      facet("community-events", "Manifestations locales", "Community events", "📍"),
      facet("charity", "Solidarité et caritatif", "Charity", "❤️"),
      facet("traditions", "Traditions et folklore", "Traditions and folklore", "🪗"),
      facet("civic-spiritual", "Vie citoyenne et spirituelle", "Civic and spiritual life", "🕊️"),
    ],
  },
  {
    slug: "nightlife",
    icon: "🌙",
    color: "#a855f7",
    labels: labels("Vie nocturne", "Nightlife", {
      pl: "Życie nocne",
      it: "Vita notturna",
      ru: "Ночная жизнь",
      es: "Vida nocturna",
    }),
    eventCategorySlugs: ["soirees"],
    defaultFacetValues: [],
    subcategories: [
      facet("clubbing", "Clubbing", "Clubbing", "🪩"),
      facet("dj-sets", "DJ sets", "DJ sets", "🎧"),
      facet("bars-cocktails", "Bars et cocktails", "Bars and cocktails", "🍸"),
      facet("afterwork", "Afterwork", "Afterwork", "🥂"),
      facet("rooftops", "Rooftops", "Rooftops", "🌆"),
      facet("student-parties", "Soirées étudiantes", "Student parties", "🎓"),
      facet("lgbtq-nightlife", "Soirées LGBTQ+", "LGBTQ+ nightlife", "🏳️‍🌈"),
      facet("themed-parties", "Soirées à thème", "Themed parties", "🎭"),
      facet("boat-parties", "Soirées en bateau", "Boat parties", "⛵"),
      facet("late-night", "Late night", "Late night", "🌃"),
    ],
  },
  {
    slug: "other",
    icon: "✨",
    color: "#64748b",
    labels: labels("Autres événements", "Other events", {
      pl: "Inne wydarzenia",
      it: "Altri eventi",
      ru: "Другие события",
      es: "Otros eventos",
    }),
    eventCategorySlugs: ["other"],
    defaultFacetValues: [],
    subcategories: [
      facet("pets", "Animaux de compagnie", "Pets", "🐾"),
      facet("open-days", "Portes ouvertes", "Open days", "🚪"),
      facet("public-services", "Services et information", "Services and information", "ℹ️"),
    ],
  },
] as const;

const SEARCH_CATEGORY_BY_SLUG = new Map(
  SEARCH_CATEGORIES.map((category) => [category.slug, category]),
);

export function searchCategoryLabel(locale: AppLocale, category: SearchCategory) {
  return category.labels[locale] ?? category.labels.en ?? category.labels.fr;
}

export function searchSubcategoryLabel(locale: AppLocale, subcategory: SearchSubcategory) {
  if (subcategory.kind === "genre") {
    return translateGenre(locale, subcategory.slug, subcategory.labels.fr);
  }
  return subcategory.labels[locale] ?? subcategory.labels.en ?? subcategory.labels.fr;
}

export function getSearchCategory(slug: string) {
  return SEARCH_CATEGORY_BY_SLUG.get(slug) ?? null;
}

export function resolveSearchTaxonomyFilters(
  selectedCategorySlugs: Iterable<string>,
  selected: { genres: readonly string[]; subcategories: readonly string[] },
) {
  const categorySlugs = new Set<string>();
  const filterValues = new Set<string>();
  const selectedGenres = new Set(selected.genres);
  const selectedSubcategories = new Set(selected.subcategories);

  for (const categorySlug of selectedCategorySlugs) {
    const category = getSearchCategory(categorySlug);
    if (!category) continue;
    category.eventCategorySlugs.forEach((slug) => categorySlugs.add(slug));

    const selectedChildren = category.subcategories.filter((subcategory) =>
      subcategory.kind === "genre"
        ? selectedGenres.has(subcategory.slug)
        : selectedSubcategories.has(subcategory.slug),
    );
    const values = selectedChildren.length
      ? selectedChildren.flatMap((subcategory) => [...subcategory.filterValues])
      : category.defaultFacetValues;
    values.forEach((value) => filterValues.add(value));
  }

  return {
    eventCategorySlugs: categorySlugs.size ? [...categorySlugs] : null,
    filterValues: filterValues.size ? [...filterValues] : null,
  };
}

export function pruneSearchSelections(
  selectedCategorySlugs: Iterable<string>,
  selected: { genres: readonly string[]; subcategories: readonly string[] },
) {
  const allowedGenres = new Set<string>();
  const allowedSubcategories = new Set<string>();
  for (const categorySlug of selectedCategorySlugs) {
    const category = getSearchCategory(categorySlug);
    category?.subcategories.forEach((subcategory) => {
      if (subcategory.kind === "genre") allowedGenres.add(subcategory.slug);
      else allowedSubcategories.add(subcategory.slug);
    });
  }
  return {
    genres: selected.genres.filter((slug) => allowedGenres.has(slug)),
    subcategories: selected.subcategories.filter((slug) => allowedSubcategories.has(slug)),
  };
}
