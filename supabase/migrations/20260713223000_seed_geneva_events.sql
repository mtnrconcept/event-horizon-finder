-- Seed a broad Geneva catalog so the discovery feed and map are useful immediately.
-- Data is demo/import content and can be replaced by ingestion jobs later.
DO $$
DECLARE
  v_ch_id uuid;
  v_ge_id uuid;
  v_cat_concert uuid;
  v_cat_festival uuid;
  v_cat_expo uuid;
  v_cat_nightlife uuid;
  v_cat_theatre uuid;
  v_cat_family uuid;
  v_org_id uuid;
  v_source_id uuid;
  v_venue_id uuid;
  v_event_id uuid;
  rec record;
BEGIN
  INSERT INTO public.countries (code, name)
  VALUES ('CH', 'Switzerland')
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_ch_id;

  INSERT INTO public.cities (country_id, slug, name, timezone, latitude, longitude, is_demo)
  VALUES (v_ch_id, 'geneve', 'Genève', 'Europe/Zurich', 46.2044, 6.1432, true)
  ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name,
    timezone = EXCLUDED.timezone,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    country_id = EXCLUDED.country_id
  RETURNING id INTO v_ge_id;

  INSERT INTO public.event_categories (slug, name_fr, name_en, icon, sort_order) VALUES
    ('concerts', 'Concerts', 'Concerts', '🎸', 10),
    ('festivals', 'Festivals', 'Festivals', '🎪', 20),
    ('expositions', 'Expositions', 'Exhibitions', '🖼️', 30),
    ('soirees', 'Soirées', 'Nightlife', '🌙', 40),
    ('theatre', 'Théâtre', 'Theatre', '🎭', 50),
    ('famille', 'Famille', 'Family', '👨‍👩‍👧‍👦', 60)
  ON CONFLICT (slug) DO UPDATE SET name_fr = EXCLUDED.name_fr, name_en = EXCLUDED.name_en, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order;

  SELECT id INTO v_cat_concert FROM public.event_categories WHERE slug = 'concerts';
  SELECT id INTO v_cat_festival FROM public.event_categories WHERE slug = 'festivals';
  SELECT id INTO v_cat_expo FROM public.event_categories WHERE slug = 'expositions';
  SELECT id INTO v_cat_nightlife FROM public.event_categories WHERE slug = 'soirees';
  SELECT id INTO v_cat_theatre FROM public.event_categories WHERE slug = 'theatre';
  SELECT id INTO v_cat_family FROM public.event_categories WHERE slug = 'famille';

  INSERT INTO public.organizers (slug, name, description, website, is_verified, verification_level, is_demo)
  VALUES ('geneve-demo-agenda', 'Agenda Genève — import démo', 'Sélection importée de sorties genevoises pour alimenter EVENTA.', 'https://www.geneve.ch/', true, 'partner', true)
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, website = EXCLUDED.website, is_verified = true, verification_level = 'partner'
  RETURNING id INTO v_org_id;

  INSERT INTO public.source_domains (domain, is_authorized, notes)
  VALUES ('geneve.ch', true, 'Source publique utilisée pour initialiser des événements de démonstration à Genève.')
  ON CONFLICT (domain) DO UPDATE SET is_authorized = true, notes = EXCLUDED.notes;

  SELECT ds.id INTO v_source_id
  FROM public.data_sources ds
  WHERE ds.organizer_id = v_org_id
    AND ds.name = 'Agenda culturel Genève'
    AND ds.base_url = 'https://www.geneve.ch/'
    AND ds.domain = 'geneve.ch'
  LIMIT 1;

  IF v_source_id IS NULL THEN
    INSERT INTO public.data_sources (organizer_id, name, source_type, base_url, domain, is_authorized, is_verified, sync_frequency, status, legal_basis)
    VALUES (v_org_id, 'Agenda culturel Genève', 'import', 'https://www.geneve.ch/', 'geneve.ch', true, true, 'daily', 'active', 'Données de démonstration; remplacement prévu par ingestion officielle.')
    RETURNING id INTO v_source_id;
  ELSE
    UPDATE public.data_sources ds
    SET source_type = 'import',
        is_authorized = true,
        is_verified = true,
        sync_frequency = 'daily',
        status = 'active',
        legal_basis = 'Données de démonstration; remplacement prévu par ingestion officielle.'
    WHERE ds.id = v_source_id;
  END IF;

  FOR rec IN SELECT * FROM (VALUES
    ('victoria-hall-geneve','Victoria Hall','Rue du Général-Dufour 14',46.2018,6.1414,'https://www.ville-ge.ch/culture/victoria_hall/'),
    ('batiment-des-forces-motrices','Bâtiment des Forces Motrices','Place des Volontaires 2',46.2056,6.1370,'https://www.bfm.ch/'),
    ('alhambra-geneve','Alhambra Genève','Rue de la Rôtisserie 10',46.2029,6.1462,'https://alhambra-geneve.ch/'),
    ('usine-geneve','L’Usine','Place des Volontaires 4',46.2059,6.1365,'https://www.usine.ch/'),
    ('mamco-geneve','MAMCO','Rue des Vieux-Grenadiers 10',46.1983,6.1352,'https://www.mamco.ch/'),
    ('musee-art-histoire-geneve','Musée d’art et d’histoire','Rue Charles-Galland 2',46.1992,6.1513,'https://www.mahmah.ch/'),
    ('parc-bastions','Parc des Bastions','Promenade des Bastions 1',46.2002,6.1433,'https://www.geneve.ch/'),
    ('parc-la-grange','Parc La Grange','Quai Gustave-Ador',46.2094,6.1669,'https://www.geneve.ch/'),
    ('theatre-carouge','Théâtre de Carouge','Rue Ancienne 37',46.1845,6.1393,'https://theatredecarouge.ch/'),
    ('grutli-geneve','Maison des arts du Grütli','Rue du Général-Dufour 16',46.2016,6.1408,'https://www.grutli.ch/')
  ) AS v(slug,name,address,lat,lon,website) LOOP
    INSERT INTO public.venues (slug, name, address, city_id, country_id, latitude, longitude, website, is_verified, is_demo)
    VALUES (rec.slug, rec.name, rec.address, v_ge_id, v_ch_id, rec.lat, rec.lon, rec.website, true, true)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, city_id = EXCLUDED.city_id, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, website = EXCLUDED.website, is_verified = true;
  END LOOP;

  FOR rec IN SELECT * FROM (VALUES
    ('orchestre-au-victoria-hall','Grand concert symphonique au Victoria Hall','Une soirée classique accessible avec orchestre, solistes invités et grandes pages romantiques.','concerts','victoria-hall-geneve',7,20,false,45),
    ('jazz-sur-le-rhone','Jazz sur le Rhône','Jam session chaleureuse entre standards, groove moderne et découvertes locales.','concerts','batiment-des-forces-motrices',9,21,false,28),
    ('indie-rock-a-lusine','Indie rock à L’Usine','Plateau de groupes émergents, guitares nerveuses et aftershow DJ.','concerts','usine-geneve',11,22,false,18),
    ('chorales-aux-bastions','Chorales aux Bastions','Concert gratuit en plein air avec ensembles vocaux genevois.','concerts','parc-bastions',13,18,true,0),
    ('electro-lake-night','Electro Lake Night','Nuit club avec house mélodique, techno solaire et scénographie immersive.','soirees','alhambra-geneve',5,23,false,22),
    ('rooftop-afterwork-geneve','Afterwork coucher de soleil','DJ set, food trucks et vue sur la rade pour lancer la soirée.','soirees','parc-la-grange',6,18,true,0),
    ('nuit-des-collectifs','Nuit des collectifs','Plusieurs collectifs genevois se relaient entre disco, bass music et live machines.','soirees','usine-geneve',15,23,false,16),
    ('marche-createurs-bastions','Marché des créateurs','Design, bijoux, affiches, friperie et ateliers ouverts toute la journée.','festivals','parc-bastions',4,11,true,0),
    ('festival-lumieres-rade','Festival lumières sur la rade','Parcours lumineux, installations participatives et performances au bord du lac.','festivals','parc-la-grange',18,19,true,0),
    ('food-culture-geneve','Food & Culture Genève','Stands gourmands, musique live et rencontres associatives autour des cuisines du monde.','festivals','parc-bastions',21,12,true,0),
    ('expo-art-contemporain-mamco','Expo art contemporain au MAMCO','Nouvelles installations, performances vidéo et visites commentées.','expositions','mamco-geneve',3,10,false,12),
    ('nocturne-musee-histoire','Nocturne au Musée d’art et d’histoire','Visite nocturne, médiation flash et parcours thématique dans les collections.','expositions','musee-art-histoire-geneve',8,19,true,0),
    ('photo-urbaine-grutli','Photographie urbaine au Grütli','Regards contemporains sur la ville, ses marges et ses architectures.','expositions','grutli-geneve',12,17,false,10),
    ('atelier-famille-mamco','Atelier famille au MAMCO','Parcours ludique puis création plastique pour enfants et adultes.','famille','mamco-geneve',10,14,true,0),
    ('contes-parc-bastions','Contes au parc des Bastions','Histoires, musique douce et goûter participatif pour les familles.','famille','parc-bastions',16,15,true,0),
    ('cinema-plein-air-la-grange','Cinéma en plein air à La Grange','Projection familiale au crépuscule, transats et ambiance d’été.','famille','parc-la-grange',19,21,true,0),
    ('piece-contemporaine-carouge','Théâtre contemporain à Carouge','Création romande vive, drôle et engagée sur les liens de voisinage.','theatre','theatre-carouge',14,20,false,32),
    ('impro-au-grutli','Impro au Grütli','Match d’improvisation interactif avec thèmes proposés par le public.','theatre','grutli-geneve',17,20,false,15),
    ('lecture-musicale-alhambra','Lecture musicale à l’Alhambra','Textes d’auteurs suisses accompagnés par piano, clarinette et textures électroniques.','theatre','alhambra-geneve',24,19,false,20),
    ('bal-populaire-bfm','Bal populaire au BFM','Grand bal intergénérationnel avec initiation danse, orchestre live et surprises.','festivals','batiment-des-forces-motrices',25,20,true,0),
    ('open-air-dj-bastions','Open air DJ aux Bastions','Après-midi électronique gratuite avec jeunes talents locaux.','soirees','parc-bastions',27,16,true,0),
    ('musique-de-chambre-victoria','Musique de chambre','Quatuor, récital et programme intimiste dans l’écrin du Victoria Hall.','concerts','victoria-hall-geneve',28,19,false,38),
    ('vernissage-quartier-mamco','Vernissage quartier des Bains','Galeries ouvertes, parcours commentés et rencontres avec les artistes.','expositions','mamco-geneve',30,18,true,0),
    ('festival-jeune-public-carouge','Festival jeune public','Spectacles courts, marionnettes, ateliers et goûter pour les enfants.','famille','theatre-carouge',31,10,false,8)
  ) AS e(slug,title,short_description,category_slug,venue_slug,day_offset,hour_start,is_free,price) LOOP
    SELECT id INTO v_venue_id FROM public.venues WHERE slug = rec.venue_slug;
    INSERT INTO public.events (slug, title, short_description, description, category_id, organizer_id, venue_id, status, publication_status, is_free, is_verified, verification_level, source_confidence, language, official_url, genres, is_demo, published_at)
    VALUES (rec.slug, rec.title, rec.short_description, rec.short_description, CASE rec.category_slug WHEN 'concerts' THEN v_cat_concert WHEN 'festivals' THEN v_cat_festival WHEN 'expositions' THEN v_cat_expo WHEN 'soirees' THEN v_cat_nightlife WHEN 'theatre' THEN v_cat_theatre ELSE v_cat_family END, v_org_id, v_venue_id, 'published', 'published', rec.is_free, true, 'partner', 8.5, 'fr', 'https://www.geneve.ch/', ARRAY[rec.category_slug, 'geneve'], true, now())
    ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, short_description = EXCLUDED.short_description, description = EXCLUDED.description, category_id = EXCLUDED.category_id, organizer_id = EXCLUDED.organizer_id, venue_id = EXCLUDED.venue_id, status = 'published', is_free = EXCLUDED.is_free, is_verified = true
    RETURNING id INTO v_event_id;

    INSERT INTO public.event_occurrences (event_id, starts_at, ends_at, timezone, latitude, longitude, status, ticket_status)
    SELECT v_event_id, date_trunc('day', now() AT TIME ZONE 'Europe/Zurich') AT TIME ZONE 'Europe/Zurich' + (rec.day_offset || ' days')::interval + (rec.hour_start || ' hours')::interval,
           date_trunc('day', now() AT TIME ZONE 'Europe/Zurich') AT TIME ZONE 'Europe/Zurich' + (rec.day_offset || ' days')::interval + ((rec.hour_start + 2) || ' hours')::interval,
           'Europe/Zurich', v.latitude, v.longitude, 'scheduled', CASE WHEN rec.is_free THEN 'free'::public.ticket_status ELSE 'available'::public.ticket_status END
    FROM public.venues v WHERE v.id = v_venue_id
    AND NOT EXISTS (SELECT 1 FROM public.event_occurrences o WHERE o.event_id = v_event_id);

    INSERT INTO public.ticket_offers (event_id, name, price_min, price_max, currency, is_free, ticket_url, status)
    SELECT v_event_id, CASE WHEN rec.is_free THEN 'Entrée libre' ELSE 'Billet standard' END, rec.price, rec.price, 'CHF', rec.is_free, 'https://www.geneve.ch/', CASE WHEN rec.is_free THEN 'free'::public.ticket_status ELSE 'available'::public.ticket_status END
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.ticket_offers t
      WHERE t.event_id = v_event_id
        AND t.name = CASE WHEN rec.is_free THEN 'Entrée libre' ELSE 'Billet standard' END
        AND t.ticket_url = 'https://www.geneve.ch/'
    );

    INSERT INTO public.source_records (data_source_id, source_url, external_identifier, raw_json, extracted_data, processing_status, processed_at)
    SELECT v_source_id, 'https://www.geneve.ch/', rec.slug, jsonb_build_object('seed', true, 'city', 'Genève'), to_jsonb(rec), 'completed', now()
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.source_records sr
      WHERE sr.data_source_id = v_source_id
        AND sr.source_url = 'https://www.geneve.ch/'
        AND sr.external_identifier = rec.slug
    );
  END LOOP;
END $$;
