# Collecteur d’événements genevois

Le script `scrape_geneva_events.py` couvre deux usages complémentaires.

## Synchronisation de production

Le mode par défaut orchestre la fonction Supabase protégée, par petits lots, jusqu’à ce que toutes les sources dues aient été traitées. Les secrets restent dans les variables d’environnement.

```bash
SUPABASE_URL="https://<project-ref>.supabase.co" \
GENEVA_SCRAPER_SECRET="<secret>" \
python3 scripts/scrape_geneva_events.py
```

Pour relancer toutes les sources, y compris celles déjà synchronisées aujourd’hui :

```bash
python3 scripts/scrape_geneva_events.py --force
```

## Inspection directe d’un agenda

Le mode direct extrait les objets `schema.org/Event` d’une page officielle, sans dépendance Python externe et sans écrire en base par défaut.

```bash
python3 scripts/scrape_geneva_events.py \
  --mode direct \
  --url "https://un-lieu.ch/agenda/" \
  --venue "Nom du lieu" \
  --category concerts \
  --follow-links 20
```

Lorsque `FIRECRAWL_API_KEY` est défini, Firecrawl est utilisé en repli pour les agendas JavaScript qui ne publient pas de JSON-LD. Pour charger le registre Supabase et persister les événements, définir `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY`, puis ajouter `--write`. La clé `service_role` ne doit jamais être exposée dans le frontend ni commitée.

## Tests

```bash
python3 -m unittest tests/test_scrape_geneva_events.py
```
