# social-service

**Stack**: NestJS  
**Port**: 3014  
**Source**: `apps/social-service/`

## Responsibilities

The social-service manages all community features:

- **Posts**: news feed with Markdown, polls, reactions, comments, reports, pinning.
- **Channels**: encrypted workspaces with role-based access, HKDF-derived per-channel keys, server-assisted key distribution.
- **Associations**: club management, members, documents, calendar events, boutique products.
- **Forms**: dynamic form builder with optional Stripe payment, cash payment validation.

## Databases

| Store | Purpose |
|---|---|
| PostgreSQL | Channels, workspaces, memberships, key distributions, forms, submissions, associations, products |
| MongoDB | Posts, comments, reactions (document store) |
| Redis | `chat:channel_events` pub/sub (publishes to chat-gateway) |

## Channel encryption model

Channels use server-assisted symmetric encryption (not MLS):

1. On workspace creation, `masterSecret` is generated and stored server-side.
2. A per-channel key is derived: `HKDF(masterSecret, channelId, keyVersion)`.
3. Each member receives the derived key encrypted with their MLS group key.
4. Key rotation increments `keyVersion`; old ciphertexts remain decryptable.
5. `channel_key_distributions` tracks which devices have received each key version.

## Routes

### Posts (`/api/posts`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/posts` | List paginated posts (feed types: all / followed) |
| POST | `/api/posts` | Create post (Markdown, optional poll or form, optional payment) |
| GET | `/api/posts/:postId` | Get single post |
| PATCH | `/api/posts/:postId` | Update post (author only) |
| DELETE | `/api/posts/:postId` | Delete post (author or admin) |
| POST | `/api/posts/:postId/reactions` | Add/toggle emoji reaction |
| POST | `/api/posts/:postId/comments` | Add comment |
| PATCH | `/api/posts/:postId/pin` | Pin post (admin only) |
| PATCH | `/api/posts/:postId/unpin` | Unpin post (admin only) |
| POST | `/api/posts/:postId/report` | Report post |

### Channels and workspaces (`/api/channels`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/channels/workspaces` | Create workspace |
| GET | `/api/channels/workspaces/user/me` | List caller's workspaces |
| GET | `/api/channels/workspace/:workspaceId/user/me` | List channels in workspace for caller |
| POST | `/api/channels` | Create channel in a workspace |
| POST | `/api/channels/:channelId/messages` | Send encrypted channel message |
| POST | `/api/channels/:channelId/members/join` | Join channel |
| POST | `/api/channels/:channelId/members/invite` | Invite user to channel |
| POST | `/api/channels/:channelId/members/kick` | Kick member (role check) |
| POST | `/api/channels/:channelId/members/leave` | Leave channel |
| POST | `/api/channels/:channelId/messages/:messageId/pin` | Pin message |

### Forms (`/api/forms`)

| Method | Path | Description |
|---|---|---|
| POST | `/api/forms` | Create form |
| GET | `/api/forms` | List caller's forms |
| GET | `/api/forms/:id` | Get form definition |
| POST | `/api/forms/:id/submit` | Submit form (with optional Stripe or cash payment) |
| GET | `/api/forms/:id/submissions` | List submissions (owner only) |
| POST | `/api/forms/:id/image` | Upload form banner image |

### Associations (`/api/associations`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/associations` | List all associations |
| GET | `/api/associations/:id` | Get association detail |
| POST | `/api/associations` | Create association (global admin or BDE `MANAGE_ASSO` flag) |
| PATCH | `/api/associations/:id` | Update association (admin with `MANAGE_MEMBERS`) |
| POST | `/api/associations/:id/members` | Add member to association |
| POST | `/api/associations/:id/events` | Create calendar event |
| POST | `/api/associations/:id/products` | Create boutique product |
| POST | `/api/associations/:id/products/:productId/checkout` | Start Stripe checkout for product |

## Redis events published

The social-service publishes to `chat:channel_events` on:
- `channel.member.joined`
- `channel.member.kicked`
- `channel.message.created`

The chat-gateway subscribers fan out these events to all connected devices of the affected users.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `MONGODB_URI` | yes | MongoDB connection string |
| `REDIS_URL` | yes | Redis connection string |
| `JWT_SECRET` | yes | HS256 secret (shared with all services) |
| `STRIPE_SECRET_KEY` | no | Stripe secret key (form/product payments) |
| `INTERNAL_SECRET` | yes | Shared secret for service-to-service calls |
| `MEDIA_SERVICE_URL` | yes | Internal URL for media-service (blob proxy) |
| `CORE_SERVICE_URL` | yes | Internal URL for core-service (user/payment verification) |
