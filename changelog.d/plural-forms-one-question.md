### Fixed - "1 questions" and its siblings: counts of one now read in the singular, in French and English

A post card for a form with a single question said "(1 questions)"; the message had no singular. It, the form question count, and fifteen sibling messages (device connections, reactions, PDF pages, audience people, free slots, the admin storage lines) are now plural-aware Paraglide messages, so one (and, in French, zero) takes the singular. `i18n.pluralGuard.test.ts` fails on a new bare `{count} noun` unless it is listed with the reason its count cannot be one.
