# Safe fetch proxy

Petit proxy HTTP sans dépendance applicative, destiné aux fonctions Edge du
scraper. Il résout le nom DNS, refuse toute réponse contenant une adresse
privée ou réservée, puis connecte directement l'adresse publique validée. Le
nom d'origine reste utilisé pour `Host`, SNI et la vérification du certificat
TLS. Les redirections ne sont jamais suivies.

## Contrat HTTP

La passerelle Caddy publie le service sous
`https://search.example.com/safe-fetch/v1/fetch`. L'appel doit contenir un
Bearer distinct d'au moins 32 caractères :

```http
POST /safe-fetch/v1/fetch HTTP/1.1
Authorization: Bearer <SAFE_FETCH_AUTH_TOKEN>
Content-Type: application/json

{"url":"https://agenda.example.org/events"}
```

Seuls `http://…:80` et `https://…:443` sont admis. La méthode envoyée au site
cible est toujours `GET`; aucun en-tête utilisateur, cookie ou secret n'est
transmis. Le proxy utilise l'identité fixe
`GlobalParty-Event-Discovery/1.0`, identique à celle évaluée dans `robots.txt`.

Lorsqu'un site cible a répondu, le proxy renvoie `200` avec le corps brut et
les métadonnées suivantes :

- `X-Safe-Fetch-Status`: statut HTTP du site cible ;
- `X-Safe-Fetch-Location`: valeur de `Location`, si présente ;
- `X-Safe-Fetch-Content-Type`: type du contenu cible, si valide ;
- `X-Safe-Fetch-Cache-Control`, `X-Safe-Fetch-Etag`,
  `X-Safe-Fetch-Last-Modified` et `X-Safe-Fetch-Retry-After`: métadonnées
  validées utiles au cache et au backoff ;
- `Content-Type: application/octet-stream`: type volontairement opaque de la
  réponse du proxy.

Le statut du site cible n'est volontairement **pas** réémis comme statut du
proxy et aucun en-tête HTTP `Location` n'est renvoyé. Ainsi, même un client
configuré pour suivre automatiquement les redirections ne peut pas contourner
le contrôle SSRF. Une erreur du proxy utilise un statut `4xx`/`5xx`, un corps
JSON `{"error":"code"}` et `X-Safe-Fetch-Error`.

Limites par défaut : réponse décompressée de 5 Mio, durée totale de 20 s,
résolution DNS de 3 s, 32 requêtes simultanées. Elles sont configurables dans
`infra/searxng/.env.example`, dans des bornes strictes codées côté serveur.

`GET /healthz` est une sonde non authentifiée qui ne déclenche aucune requête
sortante.

## Vérification locale

```sh
go test ./...
go vet ./...
```

Le `Dockerfile` exécute aussi les tests avant de construire le binaire statique
non-root. En production, épingler `SAFE_FETCH_GO_IMAGE` et
`SAFE_FETCH_PROXY_IMAGE` par digest après revue.
