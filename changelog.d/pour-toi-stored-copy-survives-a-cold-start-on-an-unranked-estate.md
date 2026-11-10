### Fixed - the stored Pour toi copy of an estate without ranked lists is no longer deleted at the next cold start

The page now records the shape it was served in, so a cold start (capability unknown) still draws it and deletes it only once the estate is known to serve ranked lists; the old Suivis rows alpha.6 stored without a marker are still cleaned. See [feedStore](frontend/src/lib/posts/feedStore.ts).
