# Performance & Responsivité v3

Cette livraison complète l’architecture existante sans remplacer les routes avancées de découverte, de carte, de réseau social, de paramètres, d’aide ou le MCP.

## Ajouts

- PWA avec mise à jour explicite et page hors ligne
- cache limité aux pages publiques et aux assets statiques
- exclusion stricte des routes authentifiées, paramètres, admin, API et MCP
- indicateur de perte et de reprise de connexion
- mesure locale LCP, CLS et INP sans transmission réseau
- budgets gzip pour JavaScript et CSS
- quality gate GitHub dédié
- trois index PostgreSQL additifs pour les recherches et la carte
- script SQL de rollback contrôlé

## Sécurité

Le service worker ne met jamais en cache les espaces authentifiés ni les réponses Supabase. Les mises à jour ne forcent pas un rechargement sans action de l’utilisateur.

## Retour arrière

Le code peut être restauré par revert du commit de fusion. Les index peuvent être retirés avec `supabase/rollback/20260722014500_discovery_performance_v3_rollback.sql` après vérification des plans d’exécution.
