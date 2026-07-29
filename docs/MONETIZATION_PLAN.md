# Plan de monétisation — Global Party

## Positionnement

Global Party doit rester utile sans paiement pour construire une audience mondiale, puis
monétiser les acteurs qui gagnent de la visibilité, des ventes ou de la donnée grâce à cette
audience. La priorité est de vendre des résultats mesurables sans dégrader la découverte,
la confidentialité ni les performances de la carte.

## Portefeuille de revenus

| Source                                   | Client                          | Modèle                       | Prix de départ conseillé     | Priorité       |
| ---------------------------------------- | ------------------------------- | ---------------------------- | ---------------------------- | -------------- |
| Campagnes ciblées                        | Organisateurs, lieux, marques   | Budget ponctuel prépayé      | 10 CHF/jour, 70 CHF/campagne | Déjà actif     |
| Abonnement Pro                           | Organisateurs réguliers         | Abonnement                   | 29 CHF/mois ou 290 CHF/an    | Phase 1        |
| Abonnement Business                      | Réseaux et multi-lieux          | Abonnement                   | 79 CHF/mois ou 790 CHF/an    | Phase 1        |
| Mise en avant express                    | Organisateurs occasionnels      | Achat ponctuel               | 9–49 CHF selon durée/zone    | Phase 2        |
| Affiliation billetterie                  | Plateformes de tickets          | CPA ou partage de commission | 3–12 % ou montant par vente  | Phase 2        |
| Sponsoring de ville/catégorie            | Marques, offices du tourisme    | Forfait mensuel              | 500–5 000 CHF/mois           | Phase 2        |
| Leads qualifiés                          | Prestataires événementiels      | CPL                          | 10–80 CHF/lead               | Phase 3        |
| Widgets marque blanche                   | Médias, hôtels, villes          | SaaS B2B                     | 99–999 CHF/mois              | Phase 3        |
| API et licences de données               | Médias, tourisme, IA            | Quota ou contrat annuel      | 199 CHF/mois à sur devis     | Phase 3        |
| Insights de marché                       | Réseaux, collectivités          | Rapport ou dashboard         | 490–5 000 CHF                | Phase 3        |
| Premium utilisateur                      | Clubbers et voyageurs fréquents | Abonnement                   | 3,90–6,90 CHF/mois           | Phase 4        |
| Marketplace de services                  | Organisateurs et prestataires   | Commission                   | 8–15 %                       | Phase 4        |
| Newsletter et notifications sponsorisées | Marques et événements           | CPM/forfait                  | 20–50 CHF CPM                | Après audience |
| Dons / soutien                           | Utilisateurs                    | Ponctuel/récurrent           | Libre                        | Optionnel      |

## Offres organisateurs

### Starter — gratuit

- Une organisation et un collaborateur.
- Dix événements actifs.
- Statistiques essentielles.
- Accès aux campagnes publicitaires à la carte.

### Pro — 29 CHF/mois ou 290 CHF/an

- Événements actifs illimités.
- Trois collaborateurs.
- Statistiques avancées et exports simples.
- Traduction et assistance IA.
- Badge Pro.

### Business — 79 CHF/mois ou 790 CHF/an

- Jusqu’à cinq organisations ou lieux.
- Quinze collaborateurs.
- Rapports, exports et support prioritaire.
- Crédits promotionnels mensuels à introduire après validation de la marge.

### Enterprise — sur devis

- API sous contrat, widgets marque blanche et sponsoring territorial.
- SLA, facturation B2B et accompagnement.
- Conditions négociées plutôt que Checkout en libre-service.

## Architecture de facturation

- Stripe Checkout hébergé pour réduire le périmètre PCI et gérer 3DS.
- Catalogue tarifaire serveur dans `monetization_plans`; les montants sont stockés en unité
  monétaire mineure.
- Projection locale de l’abonnement dans `organizer_subscriptions`.
- Stripe reste l’autorité du paiement; seules les fonctions utilisant `service_role` peuvent
  modifier les champs de facturation.
- Webhook signé et tables privées d’idempotence pour les replays.
- Verrou par organisation avant création d’une session afin d’éviter deux checkouts concurrents.
- Customer Portal Stripe pour moyen de paiement, facture et annulation.
- Aucun secret Stripe dans le client ou dans Git.

## Affiliation billetterie

La première étape consiste à mesurer les clics sortants par événement, offre et partenaire avec
un identifiant d’attribution non personnel. Une conversion ne doit être comptée qu’après retour
signé du partenaire ou import de rapport. Les URL d’affiliation doivent être générées côté serveur
depuis une liste de domaines et de paramètres autorisés.

Avant activation :

1. signer les programmes partenaires;
2. définir la fenêtre d’attribution et la devise;
3. vérifier les règles de consentement par pays;
4. ajouter une table de rapprochement vente/commission;
5. afficher clairement les liens affiliés lorsque la loi l’exige.

## Sponsoring et publicité

- Conserver les campagnes natives comme produit à la performance.
- Ajouter des « boosts express » simples pour les petits organisateurs.
- Réserver les habillages de ville/catégorie aux ventes directes, avec fréquence limitée.
- Ne jamais vendre de ciblage sensible ni exposer de micro-audiences.
- Facturer les campagnes avant activation et rembourser automatiquement les campagnes rejetées
  ou non diffusées selon les conditions commerciales.

## API, widgets et données

- API par clé serveur, quotas, limitation de débit et journalisation.
- Paliers Developer, Business et Enterprise.
- Widgets embarqués pour hôtels, médias, villes et lieux.
- Données licenciées uniquement selon les droits des sources; ne pas revendre un contenu dont la
  licence ne le permet pas.
- Les statistiques agrégées doivent respecter un seuil minimal afin d’éviter la réidentification.

## Premium utilisateur

À lancer seulement après rétention suffisante :

- expérience sans publicité;
- alertes prioritaires et illimitées;
- itinéraires multi-événements;
- calendrier collaboratif;
- recommandations et listes de voyage avancées.

Le contenu événementiel de base et la sécurité ne doivent jamais devenir payants.

## KPI et garde-fous

| Axe         | KPI principal                         | Garde-fou                      |
| ----------- | ------------------------------------- | ------------------------------ |
| Abonnements | MRR, activation, churn                | Aucun accès inter-organisation |
| Publicité   | revenu, CTR, taux de diffusion        | Fréquence et consentement      |
| Affiliation | clics, conversion, commission validée | Retour partenaire signé        |
| API         | MRR, appels utiles, marge infra       | Quotas et licences             |
| Premium     | conversion et rétention               | Découverte gratuite préservée  |

## Feuille de route

### Phase 1 — fondation

- Catalogue de plans et abonnement organisateur.
- Checkout test, portail client, webhook et idempotence.
- Page de facturation et plan complet documenté.
- Tests de replay, mauvais montant, mauvaise devise et isolation d’organisation.

### Phase 2 — revenu transactionnel

- Produits Stripe permanents et Price IDs.
- Boost express et codes promotionnels.
- Première intégration d’affiliation billetterie.
- Tableau de rapprochement des revenus.

### Phase 3 — B2B

- Sponsoring territorial.
- Widgets et clés API.
- Facturation Enterprise et reporting.

### Phase 4 — plateforme

- Premium utilisateur.
- Marketplace avec Stripe Connect seulement après validation juridique, fiscale, KYC et support.

## Déploiement et retour arrière

1. Appliquer la migration additive.
2. Déployer les Edge Functions.
3. Configurer `STRIPE_ACCOUNT_ID`, la clé test et le secret webhook.
4. Abonner l’endpoint aux événements listés dans `.env.example`.
5. Tester Checkout, webhook, replay et portail en mode test.
6. Déployer l’interface.

Retour arrière : retirer le lien vers `/organizer/billing`, désactiver les deux nouvelles Edge
Functions et conserver les tables additives pour audit. Les campagnes publicitaires existantes ne
sont ni modifiées ni supprimées.
