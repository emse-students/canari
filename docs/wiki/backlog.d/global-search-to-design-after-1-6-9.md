## Global search (posts, forms, events, associations, people) - to design for the owner's validation after 1.6.9

target: 1.10.0

**Asked by the owner on 2026-11-10, while deciding the 1.6.9 feed tabs.** Not designed, not built:
the next step is a design note put to the owner for validation, after the `1.6.9` stable.

**Why** - the product principle the owner set the same day, verbatim:

*"La philosophie de Canari c'est de permettre aux gens de retrouver toutes leurs informations
rapidement. L'engagement (et avoir une activité agréable) n'arrive qu'après, et ne doit jamais gêner
le premier point."*

The feed tabs answer "what is new"; they never answer "where was that". A reader looking for a post,
a form, an event, an association or a person today has to know which screen holds it. One search
over all five is what the principle asks for first
([engagement](../engagement.md#the-product-principle-owner-2026-11-10)).

**What the design must answer** (questions for the owner, not decisions):

- the scope of each kind: which posts (every tab's set, or only what the reader may see - always the
  visibility predicate), which forms (open, past, the reader's own), which events;
- one ranked list or one section per kind;
- where it lives (the top bar of every section, or one screen);
- what the server already searches (people, associations, posts) and what it does not yet index
  (forms, events), and the cost of each on the shared host.
