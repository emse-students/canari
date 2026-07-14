# Associations module

**Routes**: `src/routes/associations/`, `src/routes/lists/`, `src/routes/dashboard/`  
**Components**: `src/lib/components/associations/`

## Responsibilities

- Browse and search association (club) directory.
- Manage association profile, logo, colors, description.
- Member management (add, roles, permissions).
- Calendar of events.
- Document storage (PDFs, files).
- Boutique / shop (products, Stripe checkout).
- Forms with payment (see forms module for form execution; this module handles form management within an association).
- Stripe Connect onboarding for receiving online payments.
- Tag-based autocomplete for association tagging on posts.
- Cotisant (membership dues) management - see [Cotisations](../../cotisations.md).

## Key components

| Component | Role |
|---|---|
| `AssociationDetailView.svelte` | Public-facing association page |
| `AssociationCard.svelte` | Card in the directory listing |
| `AssociationMembersSection.svelte` | Member list with role display |
| `AssociationCalendarSection.svelte` | Calendar events for an association |
| `AssociationDocumentManager.svelte` | Upload/download/delete documents |
| `AssociationTagAutocomplete.svelte` | Tag input with autocomplete (used on post creation) |
| `edit/EditProfileTab.svelte` | Edit name, description, logo, color |
| `edit/EditMembersTab.svelte` | Manage members and roles |
| `edit/EditFormsTab.svelte` | Manage forms, view pending cash submissions |
| `edit/EditPaymentsTab.svelte` | Stripe Connect setup and status |
| `edit/EditBoutiqueTab.svelte` | Boutique products (`type: 'other'`), members-only + member pricing - see [Cotisations](../../cotisations.md) |
| `edit/EditCotisationsTab.svelte` | Enable cotisation, membership price, cotisant roster (search, export, manual grant/revoke) - see [Cotisations](../../cotisations.md) |
| `edit/EditDelegationTab.svelte` | Route payments to a parent association + parent-side approval/accounting - see [Payments](payments.md#payment-delegation-parent-association-routing) |

## Routes

| Route | Description |
|---|---|
| `/associations` | Public association directory |
| `/associations/[id]` | Association detail page |
| `/associations/[id]/edit` | Admin edit (profile, members, forms, payments, boutique, cotisations) |
| `/dashboard` | Association admin dashboard |
| `/lists/[slug]` | Member list public page |
| `/lists/[slug]/edit` | Edit member list |

## Permissions

Permissions are checked at the component level using the `X-Global-Admin` header and association-level role flags injected by Nginx. The key flags are:

- `MANAGE_MEMBERS` — add/remove members, edit roles
- `MANAGE_ASSO` — edit profile, create products, manage forms
- Global admin — can do everything

## Stripe Connect

Associations that want to accept online payments must complete Stripe Connect onboarding. The `EditPaymentsTab.svelte` component handles:

1. Starting onboarding (`POST /api/payments/onboarding`).
2. Checking status (`GET /api/payments/connect-status/:associationId`).
3. Displaying the Stripe Dashboard link for reporting.

Forms with `basePrice > 0` show a warning if Connect is not yet configured.
