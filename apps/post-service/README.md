# post-service

Service NestJS pour publication de posts communautaires.

## Fonctionnalites MVP

- Posts markdown
- Images (references media-service deja uploadees cote client)
- Extraction de liens et mentions (@userId) pour usage futur
- Polls avec vote
- Boutons d'inscription a des evenements (gratuit ou payant Stripe)

## Endpoints

- `GET /posts/health`
- `POST /posts`
- `GET /posts?limit=30`
- `POST /posts/:postId/polls/:pollId/vote`
- `POST /posts/:postId/events/:buttonId/register`

## Variables d'environnement

- `PORT` (defaut `3004`)
- `POSTS_MONGO_URI` (defaut `mongodb://localhost:27017/post_db`)
- `STRIPE_SECRET_KEY` (optionnel)
- `STRIPE_SUCCESS_URL` (optionnel)
- `STRIPE_CANCEL_URL` (optionnel)
