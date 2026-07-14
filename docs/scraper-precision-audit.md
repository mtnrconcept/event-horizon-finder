# Audit du scraper mondial et adaptation EVENTA

## Conclusion

Le scraper fourni est plus précis sur la normalisation d’un événement, mais il ne remplace
pas avantageusement le collecteur EVENTA en production. Sa séparation en adaptateurs,
son traitement des dates, son score de qualité et son dédoublonnage sont solides. Le
collecteur existant reste meilleur pour l’orchestration continue, le registre de sources,
les reprises par curseur, Firecrawl et l’écriture protégée dans Supabase.

L’implémentation retient donc une architecture hybride : orchestration EVENTA inchangée,
normalisation déterministe inspirée du scraper fourni avant toute donnée extraite par IA.

## Éléments repris

| Mécanisme       | Adaptation EVENTA                                                                          |
| --------------- | ------------------------------------------------------------------------------------------ |
| JSON-LD robuste | Lecture de graphes, blocs commentés ou concaténés, offres et lieux imbriqués               |
| Temps           | Fuseau IANA de chaque ville, précision `exact/date/tbd/unknown`, marqueur `all_day`        |
| Séances         | Empreinte à la minute et rapprochement limité à 15 minutes                                 |
| Prix            | Minimum, maximum, devise ISO et gratuité validés séparément                                |
| Géographie      | Paire latitude/longitude obligatoire, bornes mondiales et rayon autour de la ville         |
| Qualité         | Score pondéré et rejet sous 48; publication automatique seulement à partir de 65           |
| Déduplication   | Fusion à partir de 0.92, signalement entre 0.78 et 0.92                                    |
| Provenance      | Méthode d’extraction, avertissements, rejets et version de précision dans `source_records` |

## Garde-fous ajoutés

- Le JSON-LD déterministe est prioritaire sur l’extraction IA Firecrawl.
- Une URL de fiche hors du domaine de la source est remplacée par l’URL officielle analysée.
- Les coordonnées éloignées du périmètre déclaré de la ville sont supprimées, jamais corrigées au hasard.
- Un identifiant de série récurrente n’écrase pas une autre séance : l’horaire doit aussi correspondre.
- Une annulation ou un report modifie le statut sans dépublier silencieusement la fiche.
- Les anciennes valeurs implicites `Europe/Zurich`, `fr` et `CHF` ne sont plus appliquées au monde entier.

## Limites assumées

Le système ne contourne ni authentification, ni paywall, ni `robots.txt`. Les sources doivent
rester autorisées et vérifiées dans `data_sources`. Les connecteurs API spécialisés du projet
fourni pourront être ajoutés source par source, mais ils ne doivent pas court-circuiter le
contrat de normalisation commun ni l’examen des doublons ambigus.
