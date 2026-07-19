# Découverte mondiale d’événements sans API payante

Cette chaîne complète le registre de sources connues par une découverte web
asynchrone. Elle ne lance jamais « tout le Web » dans une seule fonction : les
villes, recherches et pages sont placées dans des files durables, puis reprises
par de petits workers bornés. Un arrêt GitHub, une erreur réseau ou une limite
de temps Edge ne fait donc pas recommencer le cycle.

## Architecture

1. `scripts/import_geonames_city_targets.py` télécharge les exports GeoNames
   `countryInfo.txt` et `cities500.zip`, puis sélectionne les plus grandes
   villes de chaque pays/territoire couvert.
2. L’action `plan` construit sept requêtes quotidiennes localisées de vie
   nocturne, puis famille, plein air et culture pour chaque mois touché par
   cette fenêtre. Elle complète la langue nationale principale par les autres
   langues GeoNames du pays, dans un budget strict de 16 requêtes par ville.
   Une ville monolingue produit donc 10 requêtes, ou 13 lorsqu’elle traverse un
   changement de mois; une ville d’un pays multilingue peut monter à 16.
3. L’action `search` interroge uniquement une instance **SearXNG privée** en
   JSON. Elle conserve au maximum les dix premiers sites de domaines distincts
   après normalisation et met les résultats en cache (24 heures par défaut).
4. Chaque URL unique devient un travail de crawl. Avant tout téléchargement,
   l’action `crawl` récupère ou relit le cache de `robots.txt`, applique les
   règles au chemin demandé et respecte le délai de l’hôte exact (`www` et le
   domaine racine ont des états séparés). Un proxy de fetch
   gratuit épingle la résolution DNS à l’adresse publique validée, conserve
   SNI/Host, puis bloque les adresses privées. Une redirection vers un hostname
   lié n’est jamais suivie avec la décision robots du parent : elle devient un
   nouveau job, qui recharge sa propre politique d’origine.
5. Le crawler direct lit en priorité `schema.org/Event`/JSON-LD, puis le HTML
   événementiel déterministe. Il suit toujours les fiches détail et la
   pagination de même origine. Le budget borne uniquement une invocation :
   chaque URL restante ou en erreur devient un sous-job durable, donc aucune
   limite globale silencieuse ne coupe un agenda. Il n’utilise ni navigateur
   caché ni fournisseur d’extraction payant.
6. Les événements acceptés sont checkpointés dans une file SQL au niveau de
   chaque événement, puis persistés par petits lots idempotents. Une page dense
   ne dépend donc plus de la durée d’une seule fonction Edge.
7. La normalisation conserve notamment dates, horaires, fuseau, lieu,
   coordonnées plausibles, description, organisateur, catégorie, prix,
   devise, statut, billetterie et image lorsqu’ils sont effectivement trouvés.
   Une devise explicitement extraite est conservée; à défaut, elle n’est
   renseignée que si le code pays possède une correspondance déclarée. Elle
   reste `NULL` lorsqu’aucune preuve ni correspondance n’existe : le catalogue
   ne remplace jamais une devise inconnue par EUR.
   C’est une extraction déterministe **best-effort** : JSON-LD/schema.org est
   prioritaire, puis viennent les métadonnées et libellés HTML reconnus. Une
   page rendue uniquement en JavaScript, protégée ou non structurée peut rester
   partielle; aucun champ absent n’est inventé pour donner une impression de
   complétude.
8. Les URL canoniques, identifiants externes et empreintes normalisées
   (titre/date/lieu) servent au dédoublonnage prudent. Une même fiche canonique
   peut référencer plusieurs pages dans `public.event_sources`, avec leur URL,
   image, réservation et attribution propres. Une correspondance ambiguë
   n’est pas fusionnée agressivement.

Les files, leases, extraits de recherche, décisions robots et identités de
dédoublonnage restent dans le schéma `private`. Les visiteurs peuvent seulement
lire les sources des événements publiés. Le HTML téléchargé n’est pas conservé
comme copie éditoriale ; seuls les faits extraits, une empreinte de contenu et
des métadonnées opérationnelles le sont.

## Sélection des pays et des villes

La limite s’adapte à la population du pays :

|         Population nationale | Villes maximum |
| ---------------------------: | -------------: |
|             moins de 100 000 |              1 |
| 100 000 à moins de 1 million |              3 |
|      1 à moins de 5 millions |              8 |
|     5 à moins de 20 millions |             15 |
|    20 à moins de 50 millions |             25 |
|   50 à moins de 100 millions |             40 |
|         100 millions et plus |             50 |

Les villes sont strictement classées par population; le statut de capitale est
conservé comme métadonnée sans évincer une ville plus peuplée. « Tous les pays » signifie ici tous les
pays/territoires présents dans les fichiers GeoNames et possédant au moins une
localité admissible. Le rapport du `--dry-run` donne le nombre réel de pays et
de villes avant toute écriture.

Après un import réussi, une réconciliation service-role désactive, dans les
pays traités, les anciennes cibles GeoNames sorties du nouveau top-N. Un import
filtré par `--country` ne réconcilie que les pays explicitement demandés.

GeoNames est distribué sous **CC BY 4.0**. L’import enregistre la provenance et
la licence ; l’attribution GeoNames doit rester visible dans la documentation
des données. Références : [export GeoNames](https://www.geonames.org/export/),
[fichiers téléchargeables](https://download.geonames.org/export/dump/) et
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

```bash
# Téléchargement en cache et contrôle sans écriture
python3 scripts/import_geonames_city_targets.py \
  --cache-dir .cache/geonames \
  --dry-run

# Contrôle ciblé, toujours sans écriture
python3 scripts/import_geonames_city_targets.py \
  --cache-dir .cache/geonames \
  --country CH --country FR \
  --output /tmp/city-targets.json \
  --dry-run

# Import idempotent après application de la migration
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service-role-server-only>" \
python3 scripts/import_geonames_city_targets.py \
  --cache-dir .cache/geonames
```

`SUPABASE_SERVICE_ROLE_KEY` sert uniquement à cet import serveur. Elle ne doit
jamais être placée dans Vite, un navigateur, un artefact ou une sortie de CI.
`--refresh` force le renouvellement des fichiers GeoNames ; sans cette option,
le cache local est réutilisé.

## Pourquoi SearXNG doit rester privé

SearXNG est un logiciel libre de métarecherche, pas une promesse d’accès
illimité aux moteurs en amont. Le dossier `infra/searxng/` fournit un point de
départ :

- `compose.yaml` exécute SearXNG, Valkey et une passerelle Caddy ;
- `settings.yml` active le format JSON, le limiteur et suspend les moteurs qui
  répondent par blocage, quota ou CAPTCHA ;
- `Caddyfile` exige `Authorization: Bearer <SEARXNG_AUTH_TOKEN>` ;
- `.env.example` sépare le secret interne SearXNG du jeton de la passerelle.

```bash
cp infra/searxng/.env.example infra/searxng/.env
# Remplacer chaque valeur, sans commiter le fichier .env.
docker compose --env-file infra/searxng/.env \
  -f infra/searxng/compose.yaml up -d
```

`SEARXNG_PUBLIC_URL` doit être une URL HTTPS joignable depuis les fonctions
Supabase ; `127.0.0.1` ne convient que pour un test sur la même machine. Les
valeurs par défaut n’exposent donc rien publiquement : placer la passerelle
derrière un frontal TLS/équilibreur contrôlé, ou configurer explicitement son
adresse d’écoute et son certificat. Les
images proposées sont épinglées à une version; avant la production, compléter
chaque valeur `*_IMAGE` par son **digest multiarchitecture `@sha256:…` vérifié**,
puis mettre versions et digests à jour explicitement. L’hébergement, la bande
passante et l’adresse IP de sortie peuvent avoir un coût même si aucune API
commerciale n’est achetée.

Il n’existe pas de méthode gratuite et garantie permettant d’obtenir, à grande
échelle, « les dix résultats mondiaux » identiques à Google ou Bing. Le rang
SearXNG dépend des moteurs activés, de leur disponibilité, de la langue, du
pays, de leurs conditions d’utilisation et de leurs protections anti-abus.
Cette implémentation fournit donc **jusqu’à dix sites de domaines distincts du
SearXNG privé**, sans scraper directement les pages HTML de Google et sans
contourner quota, CAPTCHA ou authentification. N’activer que des moteurs dont
les conditions permettent cet usage. Voir la
[documentation administrateur SearXNG](https://docs.searxng.org/admin/).

## Secrets et déploiement

Secrets Edge obligatoires :

- `GLOBAL_SCRAPER_SECRET` : secret aléatoire d’au moins 32 caractères pour les
  appels à l’orchestrateur ;
- `SEARXNG_BASE_URL` : URL HTTPS de la passerelle SearXNG privée ;
- `SEARXNG_AUTH_TOKEN` : jeton Bearer distinct, d’au moins 32 caractères.
- `SAFE_FETCH_PROXY_URL` : URL HTTPS de la route `/safe-fetch/v1/fetch` ;
- `SAFE_FETCH_AUTH_TOKEN` : troisième secret indépendant d’au moins
  32 caractères, utilisé uniquement par le proxy DNS-épinglé.

La plateforme fournit aussi `SUPABASE_URL` et la clé service-role à la fonction.
Générer des valeurs différentes, par exemple avec `openssl rand -hex 32`, et
ne jamais les afficher dans les logs.

```bash
supabase link --project-ref "<project-ref>"
supabase db push --dry-run
supabase db push

supabase secrets set \
  "GLOBAL_SCRAPER_SECRET=$GLOBAL_SCRAPER_SECRET" \
  "SEARXNG_BASE_URL=$SEARXNG_BASE_URL" \
  "SEARXNG_AUTH_TOKEN=$SEARXNG_AUTH_TOKEN" \
  "SAFE_FETCH_PROXY_URL=$SAFE_FETCH_PROXY_URL" \
  "SAFE_FETCH_AUTH_TOKEN=$SAFE_FETCH_AUTH_TOKEN"

supabase functions deploy global-event-discovery --no-verify-jwt
```

Le `--no-verify-jwt` est volontaire : la fonction vérifie elle-même le secret
constant-time pour les workers et, pour les appels interactifs, le JWT puis le
rôle administrateur/modérateur. Elle n’accepte pas un appel anonyme sans l’un
de ces contrôles.

Le workflow `.github/workflows/discover-world-events.yml` :

- exécute les tests Node/Python/Go et le type-check Deno; le `--dry-run`
  GeoNames réseau est exécuté en PR/manuel, pas avant chaque cycle planifié ;
- lance chaque heure jusqu’à huit workers de recherche et seize workers de
  crawl bornés, puis les reprend via les files ;
- rejoue toute l’histoire des migrations sur une base Supabase locale jetable
  en validation; aucune clé de production n’est disponible dans ce job ;
- n’applique **jamais** de migration et ne déploie **jamais** sur un horaire ;
- n’importe réellement les villes que si `import_city_targets` est coché lors
  d’un `workflow_dispatch` ;
- ne migre/déploie que si `deploy` est explicitement coché lors du même type de
  déclenchement manuel.

Le workflow ne crée pas l’hébergement public TLS de SearXNG et du proxy : cette
infrastructure doit exister et réussir ses contrôles de santé avant le premier
dispatch de déploiement. Les anciens endpoints Firecrawl répondent désormais
`paid_provider_disabled` et ne sont plus déployés par le workflow supporté.

## Exécution et reprise

Le client n’accepte pas le secret en argument afin qu’il n’apparaisse pas dans
l’historique du shell ou la liste des processus.

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export GLOBAL_SCRAPER_SECRET="<au-moins-32-caracteres>"

# Planifie au plus 10 × 25 villes dues et mémorise le campaign_id.
python3 scripts/run_global_event_discovery.py plan \
  --target-date 2026-07-27 \
  --batch-size 25 \
  --max-batches 10 \
  --pause-seconds 2

# Chaque commande reprend les files serveur, sans retraiter les jobs terminés.
python3 scripts/run_global_event_discovery.py search \
  --batch-size 5 --max-batches 20 --pause-seconds 2

python3 scripts/run_global_event_discovery.py crawl \
  --batch-size 2 --max-batches 20 --pause-seconds 3 --timeout 360

python3 scripts/run_global_event_discovery.py status
```

Le dernier `campaign_id` est écrit sans secret dans
`.cache/global-event-discovery/state.json`. `--campaign-id <uuid>` permet une
reprise explicite ; `--no-state` désactive le fichier et exige alors cet
identifiant pour `search`, `crawl` et `status`. Chaque appel produit une ligne
JSON nettoyée, puis un résumé. La boucle s’arrête lorsque le serveur renvoie
`claimed: 0`/`has_more: false` ou lorsque `--max-batches` est atteint. Les
limites du client et de la fonction bornent chaque worker, tandis que les
continuations persistées reprennent jusqu’à épuisement de l’agenda. Un plafond
de sécurité anormalement atteint devient une erreur visible, jamais un succès
tronqué.

Sans `--target-date`, la fenêtre commence **demain** et couvre sept jours
consécutifs. Les trois autres familles couvrent chaque mois touché, y compris
quand la semaine traverse un changement de mois.

## Volume, parallélisme et montée en charge

Le nombre exact `N` est produit par le `--dry-run` du dump `cities500`, qui
évolue avec GeoNames et inclut les petites localités nécessaires aux
micro-États et territoires habités. La taille opérationnelle est donc :

```text
N villes × 10 requêtes habituelles en langue unique
N villes × 13 requêtes au changement de mois en langue unique
N villes × 16 requêtes au maximum avec langues supplémentaires
N × 16 × 10 emplacements de résultat au maximum
```

Cette formule est une borne haute, pas autant de téléchargements certains : le
même agenda apparaît dans plusieurs requêtes. L’unicité
`campagne + ville + URL canonique` conserve le bon contexte géographique et
évite de dupliquer la même page pour une ville. Le `--dry-run` GeoNames reste
la source de vérité si le dump évolue.

Le profil GitHub par défaut exécute une tranche **chaque heure**. Le
planificateur n’ajoute plus de villes lorsque le backlog global atteint 2 000
recherches ou 5 000 crawls. La réclamation d’une recherche réserve en plus dix
places de crawl sous verrou transactionnel : plusieurs workers ne peuvent donc
pas franchir silencieusement le plafond. Le crawl s’arrête à son tour lorsque
la file de persistance événementielle atteint 20 000 éléments, tout en vidant
cette file avant de télécharger de nouvelles pages. Les seuils sont
configurables par `GLOBAL_MAX_QUEUED_SEARCH_JOBS`,
`GLOBAL_MAX_QUEUED_CRAWL_JOBS` et
`GLOBAL_MAX_QUEUED_PERSISTENCE_JOBS`.

Avec le profil horaire actuel, les plafonds théoriques sont :

- plan : `4 appels × 25 villes × 24 passages/jour` = 2 400 villes/jour ;
- recherche : `8 workers × 16 appels × 5 requêtes × 24` = 15 360
  recherches/jour ;
- crawl : `16 workers × 20 appels × 2 sites × 24` = 15 360 pages/jour, avant
  les continuations durables de pagination et de fiches détail.

Sur le dump audité en juillet 2026 (246 pays/territoires et 3 414 villes
sélectionnées), un cycle représente environ 34 140 à 54 624 recherches : la
file de recherche peut donc être vidée en 2,2 à 3,6 jours au plafond, sous
réserve que SearXNG et les moteurs amont tolèrent le débit. La borne absolue de
10 nouveaux sites par requête représenterait encore 22 à 36 jours de crawl ;
les URL répétées et le cache réduisent généralement ce total, mais la cadence
hebdomadaire n’est pas annoncée comme garantie tant que les métriques réelles
ne le démontrent pas.

Le débit réel du plan est donc limité par ce que recherche, crawl et
persistance ont effectivement vidé : le backlog ne croît pas sans borne et les
villes encore jamais traitées ne sont pas affamées par un recrawl quotidien.
La cadence de 168 heures reste une cible. Mesurer l’âge des cibles et augmenter
prudemment l’infrastructure si la fraîcheur attendue n’est pas atteinte.
Le parallélisme ne supprime aucune protection : les prises de jobs sont
atomiques, les leases expirés sont récupérables, et un seul crawl peut être
actif par domaine avec son propre `next_allowed_at`/`crawl-delay`.

Le profil peut être réduit par `workflow_dispatch` dès que les 429 ou backoffs
augmentent. Une seule page par hostname est active à la fois et le
`crawl-delay` reste prioritaire sur le parallélisme global. Le cycle de
campagne est mensuel et une ville redevient due chaque semaine par défaut.

Les campagnes techniques terminales et caches expirés sont supprimés par lots
après 45 jours. Cette rétention ne supprime ni les événements publiés, ni leurs
identités, ni les liens de sources affichés dans la fiche. Une campagne ayant
encore un payload événementiel en échec terminal est conservée pour reprise ou
diagnostic manuel au lieu d’effacer silencieusement l’événement manquant.

## Conformité et images

- Respecter le [Robots Exclusion Protocol, RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html),
  les conditions de chaque site et les demandes de retrait.
- Ne pas contourner connexion, paywall, CAPTCHA, quota, blocage géographique ou
  mesure anti-automatisation. Un site inaccessible reste inaccessible.
- Conserver un User-Agent identifiable et une cadence basse par domaine.
- Les événements sont des faits, mais les descriptions et photos peuvent être
  protégées. Garder la description utile au service sans archiver la page
  complète, conserver URL/attribution, et ne recopier une image dans le
  stockage que si sa licence l’autorise. Par défaut, la fiche référence l’URL
  publiée par la source.
- Ne pas republier un visuel ou un texte qu’une source retire ; une politique de
  rétention et de reverification doit accompagner la mise en production.

## Supervision

Commencer par `status`, qui expose les compteurs de la campagne sans ouvrir les
tables privées aux navigateurs. Il inclut aussi les trois backlogs globaux et
les compteurs `event_persistence`, avec `completed_with_errors` si un payload a
épuisé ses reprises. Dans les sorties JSON et les logs Edge,
surveiller notamment :

- `claimed`, `completed`, `failed` et l’âge des travaux en file ;
- `cacheHit`, le nombre de résultats par recherche et les réponses SearXNG 429 ;
- `robots_disallowed`, `robots_unavailable`, `crawl_delay_deferred` ;
- `outbound_*` (URL, DNS, redirection ou adresse privée bloquée) ;
- candidats acceptés/rejetés, événements créés/mis à jour et sources ajoutées ;
- leases expirés, échecs répétés par domaine et croissance du backlog.

Une page exceptionnellement dense ne persiste plus ses centaines d’événements
dans la même fonction Edge. Après extraction, chaque payload est checkpointé
dans une file SQL idempotente, puis enregistré par petits lots lors des appels
suivants. Une modification ultérieure du prix, du statut ou de la description
rouvre le payload même si sa précédente version avait déjà réussi. Les URL,
paginations et redirections vers un hostname lié sont elles aussi des jobs
durables ; chaque hostname recharge son propre `robots.txt`.

Une recherche à `claimed: 0` signifie seulement que rien n’est actuellement
réclamable : des jobs en backoff peuvent redevenir disponibles plus tard. Les
erreurs transitoires restent en file avec une prochaine date d’essai ; les
erreurs terminales (robots interdit, URL non publique, format définitivement
invalide) ne sont pas contournées.
