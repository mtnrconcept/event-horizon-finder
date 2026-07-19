# Collecte d’événements

Deux chaînes complémentaires fonctionnent sans fournisseur payant :

- `scrape_geneva_events.py` synchronise les agendas déjà autorisés dans le
  registre de sources ;
- `import_geonames_city_targets.py` et `run_global_event_discovery.py`
  découvrent progressivement des agendas pour les principales villes du
  monde via un SearXNG privé, puis les crawlent directement.

Les secrets restent dans les variables d’environnement. Ils ne doivent jamais
être passés en argument, ajoutés au dépôt ou exposés au frontend.

## Registre de sources autorisées

Le mode par défaut orchestre la fonction Supabase protégée par petits lots. Le
prochain passage reprend les sources encore dues. Les fournisseurs
d’extraction payants sont désactivés dans le chemin opérationnel pris en charge.

```bash
SUPABASE_URL="https://<project-ref>.supabase.co" \
GENEVA_SCRAPER_SECRET="<secret>" \
python3 scripts/scrape_geneva_events.py \
  --direct-only
```

Pour relancer aussi les sources déjà synchronisées aujourd’hui :

```bash
python3 scripts/scrape_geneva_events.py --force --direct-only
```

La couche de précision partagée extrait d’abord le JSON-LD, interprète les
dates dans le fuseau IANA de la ville, conserve horaires nocturnes,
prix/devises/statuts, rejette les coordonnées incohérentes et dédoublonne
prudemment les occurrences. L’extraction est déterministe et best-effort : elle
ne fabrique pas les champs qu’une page structurée ou son HTML ne publie pas.

### Inspection locale d’un agenda

Ce mode lit les objets `schema.org/Event` d’une page sans écrire en base par
défaut.

```bash
python3 scripts/scrape_geneva_events.py \
  --mode direct \
  --direct-only \
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

Pour persister les événements d’une source déjà enregistrée, définir
`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY`, puis ajouter `--write`. La clé
service-role est strictement réservée au serveur.

## Cibles mondiales GeoNames

Le sélecteur utilise les exports gratuits GeoNames (CC BY 4.0) et retient
jusqu’à 50 villes, strictement classées par population, selon la taille de la
population nationale.

```bash
# Contrôle, téléchargement et cache sans écriture
python3 scripts/import_geonames_city_targets.py \
  --cache-dir .cache/geonames \
  --dry-run

# Import idempotent dans Supabase
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service-role-server-only>" \
python3 scripts/import_geonames_city_targets.py \
  --cache-dir .cache/geonames
```

Utiliser `--country CH` (répétable) pour un contrôle ciblé, `--output` pour
inspecter le JSON sélectionné et `--refresh` pour renouveler les fichiers.
Après chaque import écrit, la réconciliation désactive dans les pays traités
les anciennes cibles GeoNames qui ne font plus partie du top-N adaptatif.

## Orchestrateur mondial

Après configuration de la fonction `global-event-discovery` et du SearXNG
privé, le client planifie les villes dues, vide des tranches bornées des files
de recherche, crawl et persistance événementielle, puis mémorise le dernier
`campaign_id` sans secret.

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export GLOBAL_SCRAPER_SECRET="<au-moins-32-caracteres>"

python3 scripts/run_global_event_discovery.py plan \
  --target-date 2026-07-27 \
  --batch-size 25 --max-batches 10

python3 scripts/run_global_event_discovery.py search \
  --batch-size 5 --max-batches 20 --pause-seconds 2

python3 scripts/run_global_event_discovery.py crawl \
  --batch-size 2 --max-batches 20 --pause-seconds 3 --timeout 360

python3 scripts/run_global_event_discovery.py status
```

Voir [`docs/global-event-discovery.md`](../docs/global-event-discovery.md) pour
SearXNG, GeoNames, le déploiement, les volumes, la conformité, la reprise et le
monitoring.

## Tests

```bash
python3 -m unittest \
  tests/test_scrape_geneva_events.py \
  tests/test_global_event_currency_migration.py \
  tests/test_import_geonames_city_targets.py \
  tests/test_run_global_event_discovery.py

node --test supabase/functions/_shared/*.test.ts
```
