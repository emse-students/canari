# Plan : Migration Stripe -> Lydia (WP-LYDIA-1)

**Date** : 2026-08-12
**Contexte** : L'association reçoit de Lydia les capacités C2B (paiement à distance, `request/do`),
C2B Marketplace (sous-marchands "Business" + `business/create` + `business/add-cashier` + permissions
par vendeur) et B2C (`payment/send`, envoi vers un particulier). L'objectif : remplacer Stripe partout
dans Canari en changeant le moins possible le fonctionnement côté produit, puis produire (a) la liste
des questions à poser à Lydia et (b) ce que l'association doit organiser pour migrer.

---

**MISE À JOUR : la spec complète (56 pages, `Lydia API.pdf`) a été fournie par l'utilisateur et lue en
entier.** Elle couvre tous les endpoints (Auth, Author, Business, Payment, Request, Transaction, User,
Withdraw, Misc/erreurs/webhooks) avec champs exacts, exemples de requêtes/réponses, schéma de
signature et codes d'erreur. Le blocage initial ("aucun champ Lydia connu") est levé - la section
"Architecture cible confirmée" ci-dessous remplace les suppositions par les vrais noms de champs. Ce
qui reste réellement ouvert (support Lydia à contacter, ou décision produit de l'utilisateur) est
listé dans le Livrable A, très raccourci par rapport à la version précédente.

**Décisions utilisateur actées** : (1) la délégation de paiement à deux niveaux (club -> association
parente) est confirmée préservée sans changement de comportement - la spec Lydia montre que
`vendor_token` est un paramètre par requête, donc `resolvePaymentTarget` continue de choisir la cible
exactement comme aujourd'hui. (2) Pour la carte enregistrée avec débit sans interaction : après lecture
de la spec, le mécanisme le plus proche (`author/do` + `author/capture` + `author/extend`, plafond
partagé) a été présenté avec ses compromis, et l'utilisateur a choisi de NE PAS le retenir - chaque
achat redevient une autorisation dimensionnée à son montant avec interaction du payeur à chaque fois
(voir Phase 2). Le concept Stripe "carte enregistrée, débit sans confirmation" disparaît donc de
Canari - décision explicite, pas une simplification par défaut.

## Carte d'impact Stripe actuelle (établie par exploration, référence pour tout le reste)

Stripe est intégralement encapsulé dans `apps/core-service/src/payment/` (SDK, webhook, env vars) et
n'est **jamais** appelé directement par `social-service`, le frontend, ou les services Rust — ceux-ci
passent par les endpoints REST internes de `payment.controller.ts`. C'est la seule frontière à
traverser : ni le schéma DB de `social-service` (au-delà d'un rename de colonnes), ni le webhook vers
Le Cercle, ni les routes frontend n'ont besoin de changer de forme, seulement de fournisseur.

Trois primitives à remapper :
1. **Paiement one-off** (formulaires, boutique, cotisations, posts payants) — Checkout Session
   `mode: payment` / PaymentIntent direct -> **C2B `request/do`**.
2. **Marketplace / sous-marchand** (association = Stripe Connect Standard account, destination
   charge `transfer_data.destination`, + la "délégation de paiement" à deux niveaux qui est en réalité
   juste Canari choisissant QUEL compte cible passer à Stripe par appel, pas du routing imbriqué côté
   Stripe) -> **C2B Marketplace** (`business/create`, `business/add-cashier`, permissions par vendeur,
   + cibler le bon `vendor_token`/Business par requête — à confirmer que Lydia accepte ça sans lien
   parent-enfant pré-déclaré de son côté).
3. **Carte enregistrée + débit off-session** (`chargeWithSavedMethod`, Stripe Customer + PaymentMethod)
   — **aucun équivalent Lydia confirmé**. Question ouverte prioritaire (voir liste Lydia ci-dessous);
   Lydia est un produit à dominante app-driven (B2C = "envoi d'argent", C2B mentionne un "bouton de
   paiement Lydia"), donc le modèle pourrait être "approbation dans l'app" plutôt que "charge silencieuse
   serveur-à-serveur" — à trancher avec Lydia avant de coder cette partie.

Pas d'abonnements Stripe, pas de factures, pas de remboursements existants aujourd'hui — rien à
migrer sur ces points, mais le remboursement est une question à poser (gap existant, pas introduit par
la migration).

## Architecture cible

Introduire une interface `PaymentProvider` dans `core-service` (nouveau fichier, ex.
`apps/core-service/src/payment/payment-provider.interface.ts`) couvrant les méthodes déjà exposées par
`PaymentService` aujourd'hui (onboarding, création de requête de paiement, statut de compte, solde,
lien de dashboard, charge sur moyen enregistré, vérification de webhook). `PaymentService` devient
l'orchestrateur qui appelle l'implémentation active ; `StripePaymentProvider` est l'extraction pure de
l'existant (refactor sans changement de comportement — étape livrable et testable seule).

### Mapping confirmé Stripe -> Lydia (spec lue en entier, plus aucune supposition sur les champs)

Auth : trois tokens - `vendor_token` (= `api_token`, identifie une Business, PUBLIC), `provider_token`
(identifie Canari comme partenaire au-dessus des Business - c'est le rôle exact que joue Canari
aujourd'hui vis-à-vis des comptes Stripe Connect de chaque association), `user_token` (un individu,
p2p). Il existe un second token, **jamais envoyé** : le `private_token` (= `api_token_id` pour une
Business), utilisé uniquement pour signer (MD5 des paramètres triés alphabétiquement, concaténés
`clé=valeur` avec `&`, plus `&`+`private_token`, puis `md5(...)`). Toutes les requêtes sont en
`form-data`, jamais JSON, et chaque URL porte une extension (`.json`/`.xml`).

| Besoin Canari actuel | Appel Stripe | Appel Lydia confirmé | Notes |
| --- | --- | --- | --- |
| Onboarding association | `accounts.create` + `accountLinks.create` | `POST /api/business/create` (avec `provider_token`) | Retourne `api_token` (= futur `vendor_token`/`stripeAccountId`) et `api_token_id` (= `private_token`, à stocker chiffré côté `core-service` uniquement, jamais côté `social-service`). Paramètre `webhook` optionnel -> Lydia POST `{vendor_token, event}` avec `event = BUSINESS_VALIDATED \| BUSINESS_UNVALIDATED`. **`BUSINESS_VALIDATED` est l'équivalent exact de `charges_enabled` / `stripeOnboardingComplete`.** |
| Ajout de caissier / permissions | (implicite, un seul compte par association côté Stripe) | `POST /api/business/addcashier` | `permissions` = tableau JSON parmi `access_collect, access_allreceipt, access_checkout, access_statement, access_feedback, access_cashier, access_voucher, access_marketing, access_fee, access_cancelrequest, access_canceltransaction, access_manage_collects, access_easeofpayment`. C'est la réponse exacte à la question "permissions" du mail. |
| Checkout one-off (formulaire, boutique, cotisation) | `checkout.sessions.create({mode:'payment', line_items, transfer_data})` | `POST /api/request/do` | `vendor_token` = cible du paiement (**exactement le compte que `resolvePaymentTarget` choisit déjà** - pas de lien parent/enfant à déclarer côté Lydia, confirmé par la doc : le `vendor_token` est un paramètre par appel). `recipient`+`type` (email/phone) remplacent l'anonymat du lien Stripe Checkout - Canari doit connaître l'email/tel du payeur (déjà disponible sur le compte utilisateur). `payment_method: 'cb'\|'lydia'\|'auto'` couvre exactement "formulaire carte" et "bouton Lydia" du mail. `order_ref` (unique) = la clé d'idempotence actuelle. `browser_success_url`/`browser_fail_url` = `successUrl`/`cancelUrl`. `confirm_url`/`cancel_url`/`expire_url` = webhook **par requête** (pas un endpoint global) - POST avec `request_id, amount, currency, order_ref, vendor_token, sig` ; `sig` se vérifie avec le `private_token` de la Business concernée. Remplace le `checkout.controller webhook` unique par un callback dont l'URL est déjà connue au moment de la requête - plus simple que Stripe. |
| Statut Connect / solde | `accounts.retrieve` + `balance.retrieve` | Pas d'équivalent 1:1 trouvé pour un solde "collecte" générique ; `POST /api/business/b2cbalance` ne couvre que le solde disponible pour B2C. `POST /api/transaction/list` (période donnée) donne un total réconciliable - **c'est le pendant exact de la réconciliation déjà pratiquée sur MLS** (`recon.mjs`), donc naturel à adopter ici aussi. | Question ouverte : demander à Lydia s'il existe un endpoint de solde "collecte" équivalent à `balance.retrieve`, sinon `transaction/list` fait le job en moins direct. |
| Carte enregistrée + débit sans interaction | `customers` + `paymentMethods` + `paymentIntents.create({off_session:true})` | **Abandonné par décision utilisateur** - chaque achat redevient un `request/do` classique, avec interaction du payeur à chaque fois. | Le mécanisme `author/do`+`author/capture`+`author/extend` existe et aurait permis un plafond partagé sans interaction répétée, mais présenté avec ses compromis (plafond, ré-autorisation), l'utilisateur a préféré la simplicité d'une autorisation par achat. Le concept "PaymentMethod enregistrée" disparaît de Canari (voir Phase 2). |
| Webhook de paiement B2C | `payment_intent.*` | Paramètre `webhook` de `POST /api/payment/send` -> POST `{transaction_identifier, event, signature}`, `event` parmi `TRANSACTION_ACCEPTED/EXPIRED/CANCELED`, signature = MD5(transaction_identifier + event + private_token). | Utile seulement si B2C sert un jour de mécanisme de remboursement (aucun remboursement Stripe n'existe aujourd'hui). |

`StripePaymentProvider` reste l'extraction pure de l'existant ; `LydiaPaymentProvider` implémente
maintenant ce tableau avec les vrais noms de champs - plus aucune partie du design n'attend un
document externe, seulement les deux points listés dans le Livrable A.

Renommage des identifiants Stripe-spécifiques vers des noms génériques (`stripeCustomerId` ->
`paymentCustomerId`, `stripeAccountId` -> `paymentAccountId`, `stripeSessionId` -> `paymentRequestId`,
`stripePaymentIntentId` -> `paymentReference`, `stripeOnboardingComplete` -> `paymentOnboardingComplete`)
via une migration TypeORM dédiée dans `social-service` et `core-service` — pas de shim de compat
(CLAUDE.md : pas de renames "pour compat", pas de code mort). Ce renommage traverse tous les fichiers
listés dans la carte d'impact ci-dessus ; ils sont déjà inventoriés, pas besoin de les re-découvrir.

## Phasage

**Phase 0 — Prérequis (bloquant, avant toute ligne de code Lydia)**
- Récupérer auprès de l'utilisateur : PDF produit C2B / C2B Marketplace / B2C, contenu réel de
  `doc/api/` (copier-coller ou export), et la liste de documents KYC référencée dans le mail
  ("business/add-cashier ... la liste des documents présents ici").
- Obtenir un compte Lydia Pro + accès homologation pour la plateforme Canari, et au moins un Business
  de test (pour rejouer la discipline de test déjà en place dans ce repo — comptes de test dédiés,
  jamais de vraies données).
- Poser la liste de questions Lydia ci-dessous ; les réponses déterminent si Phase 2 se fait à
  l'identique ou avec un scope réduit sur les deux points "à préserver à tout prix".

**Phase 1 — Extraction de l'interface — FAIT**
- `payment-provider.interface.ts`, `stripe-payment-provider.ts` (extraction pure), `payment.service.ts`
  refactoré en orchestrateur. Comportement observable inchangé - les 8 tests `payment/*` existants
  passent tels quels, plus le reste de la suite (90/90), typecheck, lint, format tous verts.
- **Décision utilisateur actée, appliquée après coup** : la sélection du fournisseur n'est plus une
  variable d'environnement mais un champ admin-éditable dans `platform_config`
  (`GET`/`PATCH /api/users/admin/platform`, écran `/admin/platform`) - le même mécanisme qui porte déjà
  `maintenanceEnabled`/`minClientVersion`, lu en direct depuis Postgres à chaque appel, sans cache :
  basculer le switch dans l'admin prend effet immédiatement, sans redéploiement. `PaymentService`
  construit les deux providers une fois au démarrage (à partir de leurs secrets d'environnement
  respectifs, inchangés) et interroge `PlatformService.getConfig()` à chaque appel pour savoir lequel
  est actif.

**Phase 2 — `LydiaPaymentProvider`** (partiellement fait ; le reste dépend de decisions/reponses ci-dessous)
- **Fait** : `request/do` pour le chemin one-off (`createCheckoutSession`), `request/state` pour la
  relecture de session (`retrieveSession`), utilitaire de signature MD5 (`lydia-signature.ts`, testé
  contre l'exemple PHP de la doc). `request/do` ne nécessite AUCUNE signature (confirmé par la doc :
  "reservé à un autre produit Lydia") - seulement `provider_token` + `vendor_token` par appel, ce qui
  confirme au passage que la délégation à deux niveaux ne demande rien de spécial côté Lydia
  (`vendor_token` est déjà un paramètre par appel, exactement ce que `resolvePaymentTarget` fournit).
  Un champ `payerRecipient` (email/tel) a été ajouté à l'interface `PaymentProvider` - c'est le seul
  ajout de forme nécessaire, additif, ignoré par `StripePaymentProvider`.
- **Point (1) réglé** : formulaire de profil légal construit dans Canari (`LydiaBusinessOnboardingForm.
  svelte`), branché sur `business/create` via `LydiaPaymentProvider.createOnboarding`. Décision
  utilisateur : le frontend interroge `GET /api/payments/provider` (nouvel endpoint) pour savoir quel
  fournisseur est actif et affiche soit le bouton Stripe existant (inchangé), soit ce formulaire -
  aucun code n'est mort tant que la bascule n'a pas eu lieu, et rien ne change en prod tant que le
  switch admin reste sur `stripe`. Le `private_token` (`api_token_id`) retourné par `business/create`
  n'est délibérément PAS persisté : les appels signés côté provider (`business/addcashier`, etc.)
  utilisent le private_token du PROVIDER (Canari), jamais celui de la Business ciblée - confirmé par
  le champ "Provider private token" dans la spec de signature de `business/addcashier`.
- **2026-08-19 : le callback `request/do` est maintenant reçu, sur l'hypothèse du point (2).**
  `createCheckoutSession` enregistre désormais `confirm_url`/`cancel_url`/`expire_url` par requête, et
  `POST /api/payments/lydia-request-callback` (`webhook.controller.ts`) vérifie `sig` via
  `verifyRequestCallback` (donc avec le `private_token` du PROVIDER) et fait suivre vers le même
  fulfillment que le webhook Stripe, via un `order_ref` que Canari encode lui-même
  (`form:<submissionId>` / `product:<productId>:<userId>`, décodé par `lydia-order-ref.ts`). Reste
  une vraie lacune trouvée pendant ce câblage : **`payerRecipient` n'est jamais fourni** par
  `products.service.ts`/`forms.service.ts` - `request/do` le rend obligatoire, donc un paiement Lydia
  échoue systématiquement tant que rien ne résout l'email/tél du payeur (voir
  [backlog](../docs/wiki/backlog.md#flipping-payment_provider-from-stripe-to-lydia-wp-lydia-1)).
- **Une véritable lacune reste, non résolue par choix** : aucune lecture "statut en direct" côté
  Lydia (`getAccountStatus`/`getConnectAccountStatus`/`getConnectBalance`/`createConnectDashboardLink`)
  : Lydia pousse UNE fois l'évènement `BUSINESS_VALIDATED` par webhook, il n'existe pas d'appel
  "retrieve" comme `accounts.retrieve`. L'interface `PaymentProvider` suppose un modèle "poll en
  direct" hérité de Stripe ; pour Lydia il faudrait qu'elle lise plutôt un état stocké en DB (écrit
  par le webhook) - **changement de conception de l'interface, pas juste une implémentation** ; ces
  méthodes lèvent une erreur explicite pour l'instant plutôt que de mentir sur le statut. Le récepteur
  de ce webhook n'a délibérément pas été construit (2026-08-19, décision utilisateur) : il n'a aucune
  signature documentée et `vendor_token` est PUBLIC - voir la question ajoutée au Livrable A.
- Reste à faire pour clore Phase 2 : `business/addcashier` + permissions (peut se faire dès maintenant,
  ne dépend d'aucune réponse Lydia), le `payerRecipient` ci-dessus, et la lacune du statut en direct.
- **Décision utilisateur actée sur le débit "carte enregistrée"** : plutôt qu'un plafond partagé
  (`author_amount`) réutilisé sans interaction sur plusieurs achats, chaque achat déclenche sa propre
  autorisation dimensionnée exactement à son montant (`author/do` ou `request/do` avec le montant de
  cet achat, suivi d'une capture/confirmation immédiate) - **avec interaction du payeur à chaque
  achat**, comme un `request/do` ordinaire. Conséquence concrète : le concept Stripe "Customer +
  PaymentMethod enregistrée, débit serveur-à-serveur sans confirmation" **disparaît** - Lydia mémorise
  la relation payeur/moyen de paiement dans SA propre app (`payment_method: 'auto'` choisit le chemin
  le plus rapide pour un payeur déjà connu), pas dans la base Canari. À supprimer côté Canari : le
  concept de `PaymentMethod` listé/détachable (`listPaymentMethods`, `detachPaymentMethod`,
  `chargeWithSavedMethod`, les endpoints `setup-payment-method`/`payment-methods`/`charge-saved-method`
  /`charge-product-saved-method`, et l'UI associée : `PaymentModal.svelte`, `SettingsPaymentsSection.
  svelte`). Chaque achat (formulaire, produit, cotisation) redevient un simple `request/do` avec
  `recipient` = email/tel de l'utilisateur connu, exactement comme le flux Checkout hébergé déjà en
  place pour un nouvel achat sans carte enregistrée - le code s'en trouve simplifié, pas complexifié.
- Minimum de montant, devise, idempotence : repris des réponses Lydia (Stripe impose 50 centimes,
  `forms.service.ts:428-435` — la valeur Lydia remplace cette constante, pas la logique).

**Phase 3 — Webhook**
- Remplacer `stripe.webhooks.constructEvent` par le schéma de signature Lydia (à documenter dès qu'on
  l'a). Le fan-out interne (marquer submission payée, fulfillment produit, `dispatchCercleWebhook`)
  reste identique en forme ; seul le nom du champ d'idempotence change
  (`stripePaymentIntentId` -> `paymentReference`), et Le Cercle ne voit qu'une chaîne opaque unique —
  aucune coordination avec Aurel nécessaire tant que le champ reste une string unique par transaction.

**Phase 4 — Frontend**
- `stripeCallbacks.ts` -> nom générique, cible de redirection Lydia à la place de Checkout.
- Pages légales (`cgu`, `privacy`) : remplacer la mention de sous-traitant Stripe par Lydia.
- Copie UI ("Stripe Connect" -> "compte Lydia Pro") dans les écrans d'admin association.
- Supprimer la variable `STRIPE_PUBLISHABLE_KEY`/`VITE_STRIPE_PUBLISHABLE_KEY` (déjà morte aujourd'hui,
  jamais consommée) sauf si Lydia impose une clé publique pour un widget carte inline — dans ce cas,
  par défaut on garde le modèle "redirection hébergée" actuel (comme le fallback 3DS déjà en place dans
  `PaymentModal.svelte:84-85`) plutôt que d'introduire un widget inline, sauf si Lydia n'offre que ça.

**Phase 5 — Bascule**
- Comportement derrière le switch admin `platform_config.paymentProvider`, testé de bout en bout en homologation avec de
  vrais achats de test (même discipline que la campagne cross-client : observation systématique, pas
  seulement l'assertion).
- Rupture nette à la bascule (cohérent avec le style déjà adopté dans ce repo pour
  history-reconciliation) : migration DB, suppression du SDK Stripe et du code mort, mise à jour
  `infrastructure/MIGRATION.md`, `.env.example`, docker-compose (dev/prod/local), secrets CI
  (`deploy.yml`/`cd-dev.yml`, y compris le job de vérification d'empreinte des secrets), wiki
  (`payments.md`, `cotisations.md`, `services/core-service.md`, `architecture.md`, `glossary.md`,
  `api-surface.md`), `CHANGELOG.md`.

## Livrable A — Questions à poser à Lydia

La spec technique complète (56 pages) répond déjà à l'essentiel de ce qui aurait dû être demandé -
champs, signature, webhooks, permissions, erreurs sont tous documentés et intégrés au tableau
ci-dessus. Ce qui reste réellement à demander au contact Lydia (pas trouvable dans la doc) :

- **Obtention concrète des credentials homologation** : un `provider_token` pour Canari (nécessaire
  pour créer des Business par API et signer `business/addcashier` sans passer par un compte
  utilisateur individuel) + au moins un `vendor_token` de test. La doc mentionne l'accès mais pas la
  procédure/délai pour l'obtenir.
- **Liste exacte des documents KYC pour `business/addcashier`** : le mail y renvoie un lien ("la liste
  des documents présents ici") absent de la doc technique - à faire suivre par le contact Lydia.
- **Modèle de frais** : la doc montre un champ `commission_lydia` dans `transaction/list` (exemple :
  "1.20" pour une transaction de 12.40 EUR) mais ne documente pas le taux/barème par service (C2B,
  Marketplace, B2C) - demander le barème contractuel.
- **Montant minimum payable** : absent de la doc (Stripe impose 50 centimes EUR aujourd'hui,
  `forms.service.ts:428-435`) - confirmer s'il existe un plancher équivalent côté Lydia.
- **Solde "collecte" par Business** : `business/b2cbalance` ne couvre que le solde B2C - demander s'il
  existe un endpoint de solde de collecte générique, ou si `transaction/list` (réconciliation
  périodique) est la seule voie.
- **Rate limits et allowlist IP** éventuelle, et si le sandbox homologation permet de simuler la
  livraison de webhooks de bout en bout pour du test automatisé (discipline déjà en place sur ce
  repo).
- **Qui signe le callback de `request/do`** (`confirm_url`/`cancel_url`/`expire_url`) : le `private_token`
  du provider (Canari) ou celui de la Business ciblée ? Trouvé en implémentant Phase 2 (voir ci-dessus)
  - le code assume le token du provider, à confirmer avant la prod.
- **Existe-t-il un moyen de récupérer l'état d'un Business "à la demande"** (équivalent de
  `accounts.retrieve`) plutôt que de dépendre uniquement du webhook `BUSINESS_VALIDATED` envoyé une
  fois ? Sans ça, un webhook manqué (redémarrage, panne réseau) laisse Canari sans moyen de rattraper
  l'état - à demander explicitly, avec la fréquence de renvoi éventuelle du webhook en cas d'échec.
- **Le webhook `business/create` (`{vendor_token, event: BUSINESS_VALIDATED|BUSINESS_UNVALIDATED}`)
  a-t-il un schéma de signature**, comme celui de `request/do` ? Absent de tout ce qui a été lu
  jusqu'ici, et `vendor_token` étant documenté PUBLIC, un récepteur sans signature serait forgeable
  par quiconque connaît le `vendor_token` d'une autre association - c'est pourquoi ce récepteur n'a
  volontairement pas été construit (2026-08-19, voir [backlog](../docs/wiki/backlog.md#flipping-payment_provider-from-stripe-to-lydia-wp-lydia-1)).

## Livrable B — Ce que l'association doit organiser

- **Gouvernance des comptes Business** : qui, pour chaque club/association actuellement onboardé sur
  Stripe Connect, a l'autorité légale de signer l'ouverture d'un compte Lydia Pro (représentant
  légal) — organiser la collecte avant la bascule, pas après.
- **Campagne de collecte KYC** : dès que la liste de documents `business/add-cashier` est connue,
  relancer chaque association comme lors de l'onboarding Stripe initial ; sans ça, certaines ne
  pourront plus encaisser au jour de bascule.
- **Solde Stripe résiduel** : identifier toutes les associations avec un solde Stripe Connect non nul
  et déclencher les virements (payout) avant la désactivation de Stripe, sous peine de perdre l'accès
  à ces fonds.
- **Adoption utilisateur / app Lydia** : contrairement à Stripe (carte bancaire pure web), Lydia est
  fondamentalement app-driven (B2C = "envoi d'argent", bouton/app de confirmation) — évaluer si les
  utilisateurs (étudiants, adhérents) ont déjà l'app, sinon prévoir un plan de communication/onboarding
  avant la bascule, pas un simple changelog.
- **Validation légale** : mise à jour des CGU/politique de confidentialité (sous-traitant de paiement)
  à faire valider par la personne en charge du juridique/communication de l'association.
- **Fenêtre de bascule** : coordonner un gel des nouveaux onboardings Stripe juste avant la coupure
  (même logique que les fenêtres de gel déjà pratiquées avec Le Cercle), et désigner un contact interne
  qui suit la relation Lydia dans la durée (support, renouvellement) comme c'était le cas pour Stripe.

## Vérification

Aucune implémentation de code Lydia concret n'est possible avant Phase 0. Une fois les documents
reçus : rejouer en homologation un achat réel de bout en bout (formulaire payant, produit boutique,
onboarding d'un Business de test, webhook de confirmation observé et pas seulement asserté — la règle
"un feu vert n'est pas un système qui fonctionne" de CLAUDE.md s'applique ici comme partout ailleurs),
puis étendre la discipline de campagne cross-client existante avec un smoke-test paiement avant la
bascule production.
