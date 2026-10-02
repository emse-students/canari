### Fixed - the community and group image was blank on the invite card; an invite link can now be shared as a QR code

Avatars were stored behind the JWT route, so the unauthenticated `/api/media/public/:id` the invite card, the link preview and the SEO head read answered 404 once #507 removed the lazy fallback that used to hide it. They are now uploaded as public assets, and existing ones are promoted by `POST /media/internal/promote-public` ([media-service](docs/wiki/services/media-service.md#group-and-community-images-are-public-assets-2026-10-02)).
