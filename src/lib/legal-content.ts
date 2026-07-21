export type LegalSection = {
  id: string;
  title: string;
  paragraphs?: string[];
  bullets?: string[];
};

export type LegalDocument = {
  kind: "terms" | "privacy" | "cookies";
  title: string;
  shortTitle: string;
  summary: string;
  version: string;
  effectiveDate: string;
  reviewNotice: string;
  sections: LegalSection[];
};

const REVIEW_NOTICE =
  "Version préparatoire destinée au lancement. L’identité juridique complète de l’exploitant, ses coordonnées, les sous-traitants effectivement utilisés et les durées de conservation définitives doivent être complétés puis validés par un conseil juridique avant l’ouverture commerciale.";

export const TERMS_DOCUMENT: LegalDocument = {
  kind: "terms",
  title: "Conditions générales d’utilisation",
  shortTitle: "CGU",
  summary:
    "Ces conditions encadrent l’accès à Global Party / Partyfinder, la découverte d’événements, le réseau social et les espaces organisateurs.",
  version: "2026-07-21-draft-1",
  effectiveDate: "21 juillet 2026",
  reviewNotice: REVIEW_NOTICE,
  sections: [
    {
      id: "operator",
      title: "1. Exploitant et objet du service",
      paragraphs: [
        "Global Party / Partyfinder est une plateforme de découverte d’événements et d’activités, comprenant notamment un catalogue, une carte, un agenda personnel, des favoris, un réseau social et des outils destinés aux organisateurs.",
        "Les coordonnées juridiques complètes de l’exploitant seront publiées dans cette section avant le lancement commercial. Le centre d’aide constitue entre-temps le canal de contact opérationnel.",
      ],
    },
    {
      id: "acceptance",
      title: "2. Acceptation et modification des conditions",
      paragraphs: [
        "L’utilisation du service implique l’acceptation des présentes conditions. Lorsqu’une modification substantielle affecte les droits ou obligations des utilisateurs, une information claire est affichée avant son entrée en vigueur.",
        "La version applicable est identifiée par sa date et son numéro. Les versions antérieures peuvent être archivées afin d’assurer la traçabilité.",
      ],
    },
    {
      id: "accounts",
      title: "3. Comptes, âge et sécurité",
      bullets: [
        "Les informations communiquées lors de la création du compte doivent être exactes et tenues à jour.",
        "Chaque utilisateur protège ses moyens d’authentification et signale rapidement tout accès suspect.",
        "Les restrictions d’âge indiquées sur une activité ou un événement doivent être respectées.",
        "L’exploitant peut demander une vérification proportionnée lorsqu’elle est nécessaire pour protéger un compte, traiter un abus ou valider un organisateur.",
      ],
    },
    {
      id: "catalogue",
      title: "4. Informations sur les événements",
      paragraphs: [
        "Les informations peuvent provenir d’organisateurs, de lieux, de partenaires, de contributions manuelles ou de sources publiques autorisées. Elles sont présentées à titre informatif et peuvent évoluer.",
        "L’utilisateur doit vérifier les informations décisives, notamment l’horaire, le lieu, l’âge requis, l’accessibilité, le prix, les conditions d’accès et l’annulation, sur la page officielle avant de se déplacer ou de payer.",
      ],
    },
    {
      id: "social",
      title: "5. Réseau social et contenus publiés",
      bullets: [
        "L’auteur conserve ses droits sur son contenu et accorde au service une licence non exclusive, mondiale et limitée au fonctionnement, à l’affichage, à la modération et à la promotion de la publication dans le service.",
        "L’auteur doit disposer des droits nécessaires sur les textes, images, vidéos, marques, musiques et personnes représentées.",
        "Les contenus illicites, trompeurs, haineux, violents, harcelants, portant atteinte à la vie privée ou aux droits de tiers sont interdits.",
        "Les publications sponsorisées, partenariats et communications commerciales doivent être identifiables comme tels.",
        "Les utilisateurs peuvent masquer, bloquer et signaler. La modération peut limiter, masquer ou retirer un contenu et conserver les éléments nécessaires au traitement du signalement.",
      ],
    },
    {
      id: "organizers",
      title: "6. Organisateurs",
      bullets: [
        "Un organisateur garantit l’exactitude, la légalité et la mise à jour des informations qu’il publie.",
        "Il ne doit pas usurper une organisation, un événement, une marque ou une personne.",
        "Les membres d’une organisation n’utilisent que les permissions nécessaires à leur rôle.",
        "La validation d’un compte ou d’un badge ne constitue pas une garantie commerciale, financière ou de sécurité de l’événement.",
      ],
    },
    {
      id: "payments",
      title: "7. Billetterie, réservations et services tiers",
      paragraphs: [
        "Lorsqu’un lien conduit vers une billetterie, un site officiel, un service cartographique ou un réseau social tiers, les conditions et politiques du tiers peuvent s’appliquer. Sauf indication contraire au moment du paiement, Global Party n’est pas le vendeur du billet ni l’organisateur de l’événement.",
        "Les éventuelles fonctions de paiement intégrées feront l’objet de conditions commerciales et d’informations tarifaires spécifiques avant leur activation.",
      ],
    },
    {
      id: "availability",
      title: "8. Disponibilité et évolution du service",
      paragraphs: [
        "Le service est amélioré en continu. Des interruptions temporaires peuvent survenir pour maintenance, sécurité, déploiement ou en raison d’un fournisseur externe.",
        "Les fonctionnalités peuvent évoluer, mais les changements importants sont conçus pour préserver les données et permettre une transition raisonnable.",
      ],
    },
    {
      id: "liability",
      title: "9. Responsabilité",
      paragraphs: [
        "Dans les limites permises par le droit applicable, l’exploitant ne répond pas des changements décidés par un organisateur, des informations fournies par des tiers, du comportement des participants, ni des pertes indirectes résultant d’un service tiers.",
        "Aucune clause ne limite une responsabilité qui ne peut légalement être exclue, notamment en cas de faute intentionnelle ou de dispositions impératives contraires.",
      ],
    },
    {
      id: "suspension",
      title: "10. Suspension, fermeture et recours",
      paragraphs: [
        "Un compte ou un contenu peut être limité en cas de risque de sécurité, fraude, violation répétée, injonction légale ou atteinte aux droits de tiers. Lorsque cela est possible et approprié, le motif et une voie de contestation sont communiqués.",
        "L’utilisateur peut demander la fermeture de son compte depuis les paramètres. Une vérification peut être requise et certaines données peuvent être conservées lorsqu’une obligation légale ou un litige le justifie.",
      ],
    },
    {
      id: "law",
      title: "11. Droit applicable et règlement des différends",
      paragraphs: [
        "Le droit applicable, le for et les éventuels mécanismes de médiation seront précisés avec l’identité juridique de l’exploitant avant le lancement commercial, sans priver un consommateur des protections impératives de son lieu de résidence lorsqu’elles s’appliquent.",
      ],
    },
  ],
};

export const PRIVACY_DOCUMENT: LegalDocument = {
  kind: "privacy",
  title: "Politique de confidentialité",
  shortTitle: "Confidentialité",
  summary:
    "Cette politique explique quelles données sont utilisées, pourquoi, avec qui elles peuvent être partagées et comment exercer ses droits.",
  version: "2026-07-21-draft-1",
  effectiveDate: "21 juillet 2026",
  reviewNotice: REVIEW_NOTICE,
  sections: [
    {
      id: "controller",
      title: "1. Responsable du traitement et contact",
      paragraphs: [
        "Le responsable du traitement sera l’entité qui exploite Global Party / Partyfinder. Sa raison sociale, son adresse, son pays d’établissement et le contact dédié à la protection des données doivent être renseignés ici avant l’ouverture commerciale.",
        "Les demandes relatives aux données peuvent déjà être initiées depuis Paramètres > Données et compte ou depuis le centre d’aide.",
      ],
    },
    {
      id: "data",
      title: "2. Catégories de données",
      bullets: [
        "Compte : identifiant, e-mail, moyens de connexion, nom affiché, nom d’utilisateur, avatar, langue et réglages.",
        "Profil et préférences : ville, centres d’intérêt, styles musicaux, favoris, abonnements et choix de personnalisation.",
        "Contenu social : publications, médias, commentaires, réactions, enregistrements, partages, signalements et métadonnées associées.",
        "Événements et organisateurs : informations de publication, membres autorisés, validations et historique des modifications.",
        "Utilisation : pages consultées, recherches, filtres, interactions, erreurs techniques, appareil, navigateur et informations de sécurité.",
        "Localisation : ville choisie et, uniquement avec autorisation, position plus précise pour calculer la proximité.",
        "Assistance : messages, pièces jointes éventuelles, décisions de modération et échanges liés à une demande.",
      ],
    },
    {
      id: "purposes",
      title: "3. Finalités",
      bullets: [
        "Fournir le catalogue, la carte, les recommandations, le réseau social, les favoris et l’agenda.",
        "Authentifier les utilisateurs, sécuriser les comptes, prévenir la fraude et traiter les incidents.",
        "Publier et modérer les contenus, gérer les signalements et faire respecter les règles de la communauté.",
        "Permettre aux organisateurs autorisés de gérer leurs événements et leur communication.",
        "Répondre aux demandes d’assistance, d’accès, de rectification, d’export ou de suppression.",
        "Mesurer et améliorer le service lorsque l’utilisateur a activé les catégories facultatives correspondantes.",
        "Personnaliser les recommandations ou les publicités uniquement selon les réglages et consentements applicables.",
      ],
    },
    {
      id: "legal-bases",
      title: "4. Fondements du traitement",
      paragraphs: [
        "Selon la fonctionnalité et le droit applicable, les traitements reposent sur l’exécution du service demandé, le consentement, des intérêts légitimes proportionnés tels que la sécurité et l’amélioration du service, ou une obligation légale.",
        "Les fonctions facultatives d’analyse, de publicité personnalisée, de localisation précise et de connexion à certains services tiers sont contrôlées séparément. Un consentement peut être retiré pour l’avenir depuis les paramètres.",
      ],
    },
    {
      id: "sources",
      title: "5. Origine des données",
      paragraphs: [
        "Les données proviennent principalement de l’utilisateur, de son appareil, des organisateurs, des lieux, de partenaires autorisés et de sources publiques nécessaires à la constitution du catalogue. Les informations issues d’une source externe sont traitées comme des données à vérifier et ne constituent pas des instructions pour le système.",
      ],
    },
    {
      id: "recipients",
      title: "6. Destinataires et prestataires",
      bullets: [
        "Autres utilisateurs, uniquement pour les éléments que l’auteur rend visibles selon l’audience choisie.",
        "Organisateurs, sous forme d’informations nécessaires à leurs propres contenus et, lorsque prévu, de statistiques agrégées.",
        "Fournisseurs d’hébergement, base de données, stockage, sécurité, e-mail, cartographie, analyse ou paiement effectivement activés.",
        "Autorités ou conseils lorsque la loi l’exige ou pour établir, exercer ou défendre un droit.",
      ],
      paragraphs: [
        "La liste exacte des prestataires, leurs pays de traitement et les garanties de transfert doivent être maintenus dans un registre et publiés avant le lancement commercial.",
      ],
    },
    {
      id: "retention",
      title: "7. Durées de conservation",
      paragraphs: [
        "Les données sont conservées pendant la durée nécessaire à la fonctionnalité, à la sécurité, à la résolution des litiges et aux obligations légales. Les durées précises ou critères applicables à chaque catégorie doivent être documentés avant le lancement.",
        "Les contenus supprimés peuvent subsister temporairement dans les sauvegardes, journaux de sécurité ou dossiers de modération, avec un accès limité et une suppression programmée.",
      ],
    },
    {
      id: "transfers",
      title: "8. Traitements internationaux",
      paragraphs: [
        "Lorsque des données sont traitées hors du pays de l’utilisateur, l’exploitant vérifie le niveau de protection applicable et met en place les garanties nécessaires, par exemple une décision d’adéquation, des clauses contractuelles ou une autre base reconnue.",
      ],
    },
    {
      id: "rights",
      title: "9. Droits et choix",
      bullets: [
        "Accéder aux données traitées et obtenir des informations compréhensibles.",
        "Corriger les données inexactes ou compléter les informations du profil.",
        "Demander l’effacement ou la limitation lorsque les conditions sont réunies.",
        "S’opposer à certains traitements et retirer un consentement pour l’avenir.",
        "Demander un export dans un format structuré lorsque ce droit s’applique.",
        "Déposer une réclamation auprès de l’autorité compétente.",
      ],
      paragraphs: [
        "Une vérification proportionnée de l’identité peut être demandée afin d’éviter qu’un tiers n’accède au compte. Les demandes peuvent être initiées depuis les paramètres ou le centre d’aide.",
      ],
    },
    {
      id: "security",
      title: "10. Sécurité",
      paragraphs: [
        "Le service applique notamment le contrôle d’accès, la séparation des rôles, des politiques de sécurité au niveau des données, la limitation des permissions, la journalisation, la validation des fichiers et la protection des secrets côté serveur.",
        "Aucun système n’est infaillible. Tout incident suspect peut être signalé au centre d’aide afin de permettre une analyse et, lorsque nécessaire, une notification conforme au droit applicable.",
      ],
    },
    {
      id: "children",
      title: "11. Mineurs",
      paragraphs: [
        "Le service n’est pas conçu pour collecter sciemment des données d’enfants sans la base et les garanties requises. Les règles d’âge de l’application, le consentement parental éventuel et les parcours dédiés doivent être finalisés avant l’ouverture à des utilisateurs mineurs.",
      ],
    },
    {
      id: "changes",
      title: "12. Mise à jour de la politique",
      paragraphs: [
        "La politique est mise à jour lorsque les traitements, prestataires ou obligations changent. Une modification substantielle est portée à la connaissance des utilisateurs avant son entrée en vigueur lorsque cela est requis.",
      ],
    },
  ],
};

export const COOKIES_DOCUMENT: LegalDocument = {
  kind: "cookies",
  title: "Politique de cookies et technologies similaires",
  shortTitle: "Cookies",
  summary:
    "Cette politique présente les catégories de stockage local et les contrôles disponibles dans l’application.",
  version: "2026-07-21-draft-1",
  effectiveDate: "21 juillet 2026",
  reviewNotice: REVIEW_NOTICE,
  sections: [
    {
      id: "definition",
      title: "1. De quoi s’agit-il ?",
      paragraphs: [
        "Les cookies, le stockage local, les identifiants de session et les technologies similaires permettent à un site ou une application de mémoriser des informations. Certaines sont indispensables au fonctionnement ; d’autres servent à l’analyse, à la personnalisation ou à la publicité lorsqu’elles sont activées.",
      ],
    },
    {
      id: "necessary",
      title: "2. Stockages strictement nécessaires",
      bullets: [
        "Authentification, renouvellement sécurisé de session et protection contre les accès non autorisés.",
        "Langue, consentement, réglages d’accessibilité et préférences indispensables.",
        "Répartition de charge, sécurité, prévention des abus et diagnostic d’incidents.",
      ],
      paragraphs: [
        "Ces éléments ne peuvent pas tous être désactivés depuis l’interface sans empêcher le service demandé. Leur durée est limitée à ce qui est nécessaire à leur fonction.",
      ],
    },
    {
      id: "analytics",
      title: "3. Analyse facultative",
      paragraphs: [
        "Lorsque l’utilisateur l’autorise, des mesures d’audience et d’interaction peuvent aider à comprendre les parcours, détecter les écrans difficiles et améliorer les performances. Le service privilégie les données agrégées et la minimisation.",
      ],
    },
    {
      id: "personalization",
      title: "4. Personnalisation facultative",
      paragraphs: [
        "La personnalisation peut utiliser la ville, les catégories, les styles, les favoris et les interactions afin d’ordonner les recommandations. Elle peut être désactivée sans supprimer les fonctionnalités essentielles de recherche.",
      ],
    },
    {
      id: "advertising",
      title: "5. Publicité facultative",
      paragraphs: [
        "Les publicités personnalisées ne sont activées qu’après le choix correspondant. Les contenus sponsorisés restent identifiés. Le refus de personnalisation n’implique pas nécessairement l’absence de toute publicité, mais celle-ci doit alors être contextuelle ou non personnalisée.",
      ],
    },
    {
      id: "third-parties",
      title: "6. Services tiers",
      paragraphs: [
        "Un contenu intégré, une carte, une vidéo, une billetterie ou un bouton de réseau social peut dépendre d’un tiers. Les intégrations non essentielles doivent être bloquées ou limitées tant que le choix requis n’a pas été exprimé. La liste exacte des services activés doit être publiée avant le lancement commercial.",
      ],
    },
    {
      id: "control",
      title: "7. Modifier ses choix",
      paragraphs: [
        "Les catégories facultatives peuvent être modifiées à tout moment dans Paramètres > Cookies et personnalisation. Le retrait s’applique pour l’avenir. Le navigateur ou le système permet également de supprimer les données locales, ce qui peut déconnecter le compte ou réinitialiser des préférences.",
      ],
    },
    {
      id: "inventory",
      title: "8. Inventaire à publier",
      paragraphs: [
        "Avant l’ouverture commerciale, l’exploitant doit tenir à jour un inventaire indiquant pour chaque cookie ou technologie : son nom, son fournisseur, sa finalité, sa catégorie, sa durée, son domaine et les transferts éventuels.",
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS = {
  terms: TERMS_DOCUMENT,
  privacy: PRIVACY_DOCUMENT,
  cookies: COOKIES_DOCUMENT,
} as const;
