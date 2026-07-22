# Retour arrière — Performance v3

1. Revert du commit de fusion GitHub.
2. Vérification du déploiement Vercel précédent.
3. Désenregistrement du service worker si nécessaire depuis les outils navigateur.
4. Purge uniquement des caches `global-party-v3-*`.
5. Après analyse des plans SQL, exécution facultative de `supabase/rollback/20260722014500_discovery_performance_v3_rollback.sql`.

Les index ajoutés sont indépendants des données métier et leur suppression ne supprime aucune ligne.
