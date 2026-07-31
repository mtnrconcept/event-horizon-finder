-- Expand public discovery beyond nightlife and music-only filters without
-- changing any existing RPC signature. Generic search facets are kept apart
-- from musical genres, while the legacy _genres parameter remains the compact
-- backwards-compatible transport for both indexed arrays.

set local lock_timeout = '10s';
set local statement_timeout = '5min';

alter table public.events
  add column if not exists search_facets text[] not null default '{}'::text[];

comment on column public.events.search_facets is
  'Automatically inferred non-musical discovery facets. Public discovery matches these alongside the legacy genres array.';

create or replace function public.infer_event_search_facets(
  _title text,
  _short_description text,
  _description text,
  _category_slug text,
  _genres text[],
  _age_restriction text default null
)
returns text[]
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_text text := lower(public.unaccent(concat_ws(
    ' ',
    coalesce(_title, ''),
    coalesce(_short_description, ''),
    coalesce(_description, ''),
    coalesce(_age_restriction, '')
  )));
  v_defaults text[] := case coalesce(_category_slug, '')
    when 'concerts' then array['music']::text[]
    when 'festivals' then array['festival', 'community']::text[]
    when 'expositions' then array['culture', 'exhibitions']::text[]
    when 'soirees' then array['nightlife']::text[]
    when 'theatre' then array['culture', 'theatre-shows']::text[]
    when 'famille' then array['family']::text[]
    when 'sports-outdoor' then array['sport']::text[]
    when 'heritage' then array['culture', 'heritage-tours']::text[]
    when 'gastronomy' then array['food']::text[]
    when 'activities' then array['learning']::text[]
    when 'conferences' then array['learning', 'conferences']::text[]
    when 'cinema' then array['culture', 'cinema-screenings']::text[]
    when 'leisure' then array['leisure']::text[]
    when 'other' then array['other']::text[]
    else '{}'::text[]
  end;
  v_matches text[];
begin
  if cardinality(coalesce(_genres, '{}'::text[])) > 0 then
    v_defaults := array_append(v_defaults, 'music');
  end if;

  with rules(facet, pattern) as (
    values
      -- Family
      ('family', 'famille|familial|family|children|kids|enfant|bambin|bambini|niñ|dzieci|kinder'),
      ('family-cinema', 'cinema|movie|family film|film famille|kinderkino|cine familiar|film per famiglie'),
      ('amusement-parks', 'amusement park|theme park|parc d attraction|fete foraine|funfair|lunapark|parque de atracciones'),
      ('parks-leisure', '(^|[^a-z])(parc|park|jardin|garden)([^a-z]|$)|aire de loisirs|recreation area'),
      ('family-events', 'famille|familial|family|children|kids|enfant|bambin|bambini|niñ|dzieci|kinder'),
      ('water-play', 'jeux d.?eau|water play|splash|aquapark|water park|piscine|pool|bad wodny'),
      ('zoo-aquarium', 'zoo|aquarium|aquario|tierpark|zoolog'),
      ('kids-shows', 'spectacle enfant|children.s show|kids show|teatro infantil|kindertheater|spettacolo per bambini'),
      ('family-workshops', 'atelier famille|atelier creatif|family workshop|kids workshop|atelier enfant|laboratorio per bambini'),
      ('educational-activities', 'educatif|educational|pedagog|apprendre|learning activity'),
      ('circus', 'cirque|circus|circo|zirkus|cyrk'),
      ('farms-animals', 'ferme|farm|animaux|animals|fattoria|granja|bauernhof'),
      ('playgrounds', 'aire de jeux|playground|spielplatz|parco giochi|plac zabaw'),
      ('family-science', 'science for kids|science enfant|planeta|observatoire|discovery centre'),

      -- Culture and heritage
      ('museums', 'musee|museum|museo|muzeum|galerie permanente'),
      ('historical-sites', 'site historique|historic site|monument|chateau|castle|palais|palace|ruines|archaeolog'),
      ('art', '(^|[^a-z])art([^a-z]|$)|beaux.arts|fine art|art contemporain|contemporary art|arts visuels|visual arts|galerie d art'),
      ('exhibitions', 'exposition|exhibition|mostra|ausstellung|wystawa|exposicion'),
      ('theatre-shows', 'theatre|theater|teatro|spectacle|performance sceni|spektakl'),
      ('dance', 'danse|dance|tanz|danza|taniec|ballet'),
      ('cinema-screenings', 'cinema|screening|projection|movie|film festival|kino|cine'),
      ('literature', 'litterature|literature|livre|book|lecture|reading|poesie|poetry|author'),
      ('architecture', 'architecture|architect|urbanisme|urbanism|baukunst'),
      ('photography', 'photograph|fotograf|photo exhibition|expo photo'),
      ('heritage-tours', 'patrimoine|heritage|guided tour|visite guidee|stadtfuhrung|visita guidata'),
      ('opera-lyric', 'opera|lyrique|lyric|operette|operetta'),

      -- Sport and outdoors
      ('football', 'football|soccer|futsal|calcio|fussball|pilka nozna'),
      ('running', 'running|course a pied|marathon|semi.marathon|trail run|jogging'),
      ('cycling', 'cycling|cyclisme|velo|bike|bicycle|ciclismo|fahrrad'),
      ('hiking', 'randonnee|hiking|trek|walk|balade|wanderung|senderismo'),
      ('water-sports', 'surf|kayak|canoe|voile|sailing|paddle|natation|swimming|diving'),
      ('winter-sports', 'ski|snowboard|raquette|winter sport|sports d hiver|patinage'),
      ('fitness', 'fitness|gym|crossfit|workout|musculation'),
      ('yoga', 'yoga|pilates'),
      ('racket-sports', 'tennis|badminton|squash|padel|pickleball|table tennis'),
      ('combat-sports', 'boxe|boxing|judo|karate|martial art|mma|wrestling|taekwondo'),
      ('motorsports', 'motorsport|rally|racing|grand prix|automobile|motorcycle|moto'),
      ('team-sports', 'basket|volley|handball|rugby|hockey|team sport'),
      ('golf', 'golf'),
      ('nature-excursions', 'nature|outdoor|plein air|forest|foret|mountain|montagne|lac|lake'),

      -- Food and drink
      ('markets', 'marche|market|mercato|markt|targ|feria gastronom'),
      ('gastronomy', 'gastronom|culinaire|culinary|cuisine|restaurant|chef'),
      ('tastings', 'degustation|tasting|verkostung|cata de|assaggio'),
      ('wine', '(^|[^a-z])(vin|wine|wein|vino)([^a-z]|$)|oenolog|winery|vignoble'),
      ('beer', 'biere|beer|bier|cerveza|birra|brewery|brasserie'),
      ('brunch', 'brunch'),
      ('cooking-workshops', 'atelier cuisine|cooking class|cours de cuisine|laboratorio di cucina'),
      ('street-food', 'street food|food truck'),
      ('food-festivals', 'food festival|festival gourmand|fete gastronom|sagra'),
      ('coffee-tea', '(^|[^a-z])(coffee|cafe|tea)([^a-z]|$)|salon de the|degustation de the|ceremonie du the|barista|roastery'),

      -- Learning, leisure and wellness
      ('workshops', 'atelier|workshop|masterclass|laboratorio|warsztat'),
      ('conferences', 'conference|congress|symposium|talk|lecture|colloque|convegno'),
      ('networking', 'networking|meetup|business meeting|rencontre pro'),
      ('technology', 'technology|technologie|tech |digital|numerique|coding|developer|intelligence artificielle|\mai\M'),
      ('career', 'career|carriere|emploi|job fair|recrutement|recruitment'),
      ('science', 'science|scientific|scientifique|research|recherche'),
      ('languages', 'language class|cours de langue|conversation club|linguist'),
      ('entrepreneurship', 'entrepreneur|startup|start-up|founder|innovation'),
      ('crafts', 'artisanat|craft|handmade|ceramique|pottery|couture'),
      ('board-games', 'board game|jeu de societe|jeux de societe|planszow'),
      ('video-games', 'video game|jeu video|gaming|esport|e-sport'),
      ('escape-games', 'escape game|escape room'),
      ('bowling', 'bowling'),
      ('comedy', 'humour|comedy|stand.up|cabaret comique'),
      ('fairs', 'foire|fair|funfair|fete foraine|salon grand public'),
      ('creative-hobbies', 'loisir creatif|creative hobby|do it yourself|\mdiy\M'),
      ('shopping', 'shopping|boutique|fashion market|mode et createurs'),
      ('karaoke', 'karaoke'),
      ('wellness', 'bien.etre|wellness|relaxation|self.care|benessere|bienestar'),
      ('meditation', 'meditation|mindfulness|pleine conscience'),
      ('spa', '(^|[^a-z])spa([^a-z]|$)|sauna|hammam|thermal'),
      ('mental-health', 'mental health|sante mentale|psycholog|burn.out|stress'),
      ('holistic', 'holistic|holistique|reiki|naturopath|sonotherapie'),
      ('dance-fitness', 'zumba|dance fitness|fitness dance'),
      ('nature-retreats', 'retreat|retraite nature|wellness weekend|sejour bien.etre'),

      -- Festivals, community and nightlife
      ('music', 'concert|live music|music festival|festival de musique|festival musical'),
      ('music-festivals', 'music festival|festival de musique|festival musical'),
      ('cultural-festivals', 'cultural festival|festival culturel|arts festival'),
      ('family-festivals', 'family festival|festival famille|festival familial'),
      ('local-fairs', 'fete locale|local fair|village festival|fete de village'),
      ('community-events', 'community event|manifestation locale|quartier|neighbourhood|neighborhood'),
      ('charity', 'charity|caritatif|solidarite|benefit|fundraiser|collecte'),
      ('traditions', 'tradition|folklore|folk festival|carnaval|carnival'),
      ('civic-spiritual', 'citoyen|civic|spiritual|spirituel|religious|religieux|messe|worship'),
      ('clubbing', 'clubbing|nightclub|discotheque|dancefloor|club night'),
      ('dj-sets', 'dj set|disc jockey|deejay'),
      ('bars-cocktails', 'cocktail|bar night|bar crawl|mixology'),
      ('afterwork', 'afterwork|after work'),
      ('rooftops', 'rooftop|roof top|terrasse panoramique'),
      ('student-parties', 'student party|soiree etudiante|university party|campus party'),
      ('lgbtq-nightlife', 'lgbt|lgbtq|queer|pride party'),
      ('themed-parties', 'themed party|soiree a theme|costume party|fancy dress'),
      ('boat-parties', 'boat party|soiree bateau|party cruise'),
      ('late-night', 'late night|afterparty|after party|jusqu.a l.aube'),
      ('pets', '(^|[^a-z])(pet|chien|dog|chat)([^a-z]|$)|cat show|animal de compagnie'),
      ('open-days', 'portes ouvertes|open day|open house'),
      ('public-services', 'information day|journee information|service public')
  )
  select coalesce(array_agg(rule.facet order by rule.facet), '{}'::text[])
  into v_matches
  from rules as rule
  where v_text ~ rule.pattern;

  select coalesce(array_agg(distinct facet order by facet), '{}'::text[])
  into v_matches
  from unnest(v_defaults || coalesce(v_matches, '{}'::text[])) as facet;

  return v_matches;
end;
$function$;

revoke all on function public.infer_event_search_facets(
  text, text, text, text, text[], text
) from public, anon, authenticated;
grant execute on function public.infer_event_search_facets(
  text, text, text, text, text[], text
) to authenticated, service_role;

create or replace function public.apply_inferred_event_search_facets()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_category_slug text;
begin
  select category.slug
  into v_category_slug
  from public.event_categories as category
  where category.id = new.category_id;

  new.search_facets := public.infer_event_search_facets(
    new.title,
    new.short_description,
    new.description,
    v_category_slug,
    new.genres,
    new.age_restriction
  );
  return new;
end;
$function$;

revoke all on function public.apply_inferred_event_search_facets()
  from public, anon, authenticated;
grant execute on function public.apply_inferred_event_search_facets()
  to service_role;

drop trigger if exists trg_events_01_infer_search_facets on public.events;
create trigger trg_events_01_infer_search_facets
before insert or update of title, short_description, description, category_id, genres, age_restriction
on public.events
for each row execute function public.apply_inferred_event_search_facets();

-- The following migration backfills only search_facets. Its temporary trigger
-- runs after the ordinary updated_at trigger and restores the existing
-- editorial timestamp. UPDATE OF is based on the explicit SET list, so normal
-- organizer edits that merely cause the inference trigger to run are not
-- affected while the two migrations are applied sequentially.
create or replace function private.preserve_event_updated_at_for_search_backfill()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  new.updated_at := old.updated_at;
  return new;
end;
$function$;

revoke all on function private.preserve_event_updated_at_for_search_backfill()
  from public, anon, authenticated;

drop trigger if exists zz_events_preserve_updated_at_search_backfill on public.events;
create trigger zz_events_preserve_updated_at_search_backfill
before update of search_facets on public.events
for each row execute function private.preserve_event_updated_at_for_search_backfill();

-- Build the empty-array GIN in this short DDL-only migration. Its lock is
-- released before the bounded backfill starts in the next migration.
create index if not exists events_search_facets_gin
  on public.events using gin (search_facets);

notify pgrst, 'reload schema';
