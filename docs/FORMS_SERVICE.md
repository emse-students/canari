# Service de Formulaires (Form Service)

Ce microservice gère la création, la validation, le paiement et l'exportation des formulaires dynamiques. Il est conçu pour être découplé du `post-service`, bien qu'il soit souvent utilisé conjointement pour attacher des formulaires d'inscription ou de commande à des publications.

## 🏗️ Architecture

- **Framework** : NestJS
- **Base de données** : MongoDB (collection `forms`, `submissions`)
- **Paiement** : Stripe Integration (Checkout Sessions)
- **Export** : ExcelJS (génération de fichiers `.xlsx`)

## 🔑 Fonctionnalités Clés

1. **Constructeur de Formulaire Dynamique**
   - Supporte plusieurs types de champs : Texte court/long, Choix unique, Choix multiple, Échelles linéaires, Matrices.
   - Gestion des prix : Chaque option peut modifier le prix total (ex: T-shirt XL +2€).
   - Devise et prix de base configurables.

2. **Soumission & Validation**
   - Validation côté serveur des champs requis.
   - Calcul sécurisé du prix total côté serveur (pour éviter la manipulation côté client).
   - Stockage des réponses structurées.

3. **Intégration Stripe**
   - Création automatique de sessions de paiement si le formulaire a un coût.
   - Webhook (à venir) ou redirection success/cancel pour valider le paiement.

4. **Exports Données**
   - Export des soumissions au format Excel pour les administrateurs/créateurs.

## 🔌 API Endpoints (Prefix: `/api/forms`)

| Méthode | Route         | Description                                              |
| :------ | :------------ | :------------------------------------------------------- |
| `POST`  | `/`           | Créer un nouveau formulaire                              |
| `GET`   | `/`           | Lister les formulaires (opt: `?ownerId=...`)             |
| `GET`   | `/:id`        | Récupérer les détails d'un formulaire                    |
| `POST`  | `/:id/submit` | Soumettre une réponse (retourne URL Stripe si payant)    |
| `GET`   | `/:id/check`  | Vérifier si un utilisateur a déjà soumis (`?userId=...`) |
| `GET`   | `/:id/export` | Télécharger les soumissions en `.xlsx`                   |

## 📦 Modèle de Données (Simplifié)

### Form

```typescript
interface Form {
  title: string;
  description: string;
  basePrice: number; // en centimes
  currency: string;
  items: FormItem[];
  ownerId: string;
}
```

### FormItem

```typescript
interface FormItem {
  type: 'short_text' | 'multiple_choice' | ...;
  label: string;
  options?: { label: string; priceModifier: number }[];
  required: boolean;
}
```

## 🚀 Démarrage

Le service tourne sur le port **3008**.

### Local

```bash
cd apps/form-service
npm run start:dev
```

### Docker

```bash
docker compose up -d form-service
```
