# Social Service

NestJS microservice for Canari's community features. Runs on port **3014**.

## Domains

### Posts

News feed with Markdown content, media attachments, polls, and reactions.

- Paginated feed with infinite scroll
- Post creation with image, poll, embedded form
- Comments with text, mentions, images, GIFs
- Emoji reactions
- Pin/unpin (admin)
- Report (moderation)

### Channels & Workspaces

Encrypted community spaces with role-based access control.

- Workspace → channels hierarchy
- Custom roles with permission bitmasks
- Server-assisted symmetric encryption (HKDF-derived per-channel keys from workspace master secret)
- Key distribution tracked per device (`channel_key_distributions`)
- Channel push notifications with per-channel level (`all`, `mentions`, `none`)
- Full-text search (client-side decrypt + match)

### Forms

Dynamic form builder with payments.

- Custom field types with pricing modifiers
- Stripe Checkout, saved card, or cash payment
- Excel export of submissions
- Scheduled reminders via cron
- Can grant membership tags on completion

### Associations

Club management platform.

- Profile, logo, colors, description
- Member roster with roles and permissions
- Calendar events
- Document storage
- Boutique products (Stripe Connect)
- Cotisations (membership dues) via time-bounded tags

### Payment delegation

An association without its own Stripe Connect account can delegate payments to a parent association. All online payments (shop, forms, paid posts) route to the parent's Stripe account while the child retains its own identity.

## Databases

| Store | Purpose |
|---|---|
| PostgreSQL | Channels, workspaces, memberships, key distributions, forms, submissions, associations, products, user tags |
| MongoDB | Posts, comments, reactions (document store) |
| Redis | `chat:channel_events` pub/sub |

## Startup

```bash
cd apps/social-service
npm run start:dev
```

## See also

- [Wiki: social-service](../../docs/wiki/services/social-service.md) — Full API, env vars, encryption model
- [Wiki: Cotisations](../../docs/wiki/cotisations.md) — Membership dues model
- [Wiki: Payments module](../../docs/wiki/frontend/modules/payments.md) — Payment delegation
