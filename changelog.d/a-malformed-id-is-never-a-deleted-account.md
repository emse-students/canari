### Fixed - a string that is not an account id is never labelled "Compte supprimé"

`GET /api/users/batch` listed every unmatched id as `deleted`, so a membership notice whose payload held
something other than account ids read "Compte supprimé" for every member, cached for the session. Only a
well-formed id that is absent is `deleted` now; anything else is named in `malformed`, logged at warn
(lengths, never the strings) and surfaced to the client as `MalformedUserIdError`, a lookup failure and not
an answer about an account (`apps/core-service/src/users/users.controller.ts`, `frontend/src/lib/stores/user.ts`).
