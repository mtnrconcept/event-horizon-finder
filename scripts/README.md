# Collecteur continu d’événements

Le script historique `scrape_geneva_events.py` orchestre désormais toutes les sources autorisées du registre, de Genève aux villes internationales. Il couvre deux usages complémentaires.

La couche de précision est partagée avec la fonction Edge : extraction déterministe du
JSON-LD avant le repli IA, dates interprétées dans le fuseau IANA de la ville, intervalles
journée entière semi-ouverts, prix/devises/statuts conservés, coordonnées incohérentes
écartées et dédoublonnage prudent par occurrence. Une paire ambiguë n’est jamais fusionnée
automatiquement sous le seuil de `0.92`, et deux séances séparées de plus de 15 minutes
restent distinctes.

## Synchronisation de production

Le mode par défaut orchestre la fonction Supabase protégée, par petits lots, jusqu’à ce que toutes les sources dues aient été traitées. Si un cycle atteint sa limite, il se termine proprement et le prochain passage planifié reprend les sources encore dues. Les secrets restent dans les variables d’environnement.

Firecrawl est désormais optionnel. Sans `FIRECRAWL_API_KEY`, la fonction télécharge directement
les pages des sources autorisées, lit leur JSON-LD et leur HTML événementiel déterministe, puis
suit un nombre limité de fiches du même domaine. L’extracteur HTML exige une date calendaire
complète et conserve les horaires nocturnes, images, genres et tarifs annoncés. Si Firecrawl
échoue ou ne renvoie aucun candidat, ce moteur direct prend également le relais automatiquement.

```bash
SUPABASE_URL="https://<project-ref>.supabase.co" \
GENEVA_SCRAPER_SECRET="<secret>" \
python3 scripts/scrape_geneva_events.py
```

Pour relancer toutes les sources, y compris celles déjà synchronisées aujourd’hui :

```bash
python3 scripts/scrape_geneva_events.py --force
```

Pour forcer un cycle de contrôle sans Firecrawl, même lorsqu’une clé est configurée :

```bash
python3 scripts/scrape_geneva_events.py --force --direct-only
```

## Inspection directe d’un agenda

Le mode direct extrait les objets `schema.org/Event` d’une page officielle, sans dépendance Python externe et sans écrire en base par défaut.

```bash
python3 scripts/scrape_geneva_events.py \
  --mode direct \
  --url "https://un-lieu.ch/agenda/" \
  --venue "Nom du lieu" \
  --category concerts \
  --city-name Genève \
  --country-code CH \
  --timezone Europe/Zurich \
  --latitude 46.2044 \
  --longitude 6.1432 \
  --follow-links 20
```

Lorsque `FIRECRAWL_API_KEY` est défini, Firecrawl est utilisé en repli pour les agendas JavaScript qui ne publient pas de JSON-LD. Pour charger le registre Supabase et persister les événements, définir `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY`, puis ajouter `--write`. La clé `service_role` ne doit jamais être exposée dans le frontend ni commitée.

## Tests

```bash
python3 -m unittest tests/test_scrape_geneva_events.py
node --test supabase/functions/_shared/*.test.ts
```
