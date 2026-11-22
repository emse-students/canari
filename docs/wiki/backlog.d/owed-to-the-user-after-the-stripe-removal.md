## Owed after the Stripe removal - what is left (audited 2026-11-19)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

**Owner, 2026-11-19:** *"Tu peux tout supprimer en ce qui concerne Stripe, je m'occupe de l'administratif"*.
The lead removes everything left of Stripe in the code and the database (the three columns, the
permission's old name), in held migrations shipped in `1.7.1` (#3852); the Stripe webhook endpoint,
the Lydia contract and the payer e-mail proof are the owner's. The three GitHub secrets were read gone on
2026-11-19 ([decisions](owner-decisions-of-2026-11-19.md)).

What is left is administrative, and no agent can do it ([stripe-archive](../stripe-archive.md#owed-by-the-user-one-off)):

- delete the webhook endpoint in the Stripe dashboard and, when no refund can still be asked, close the Stripe account (its closure is what purges the Stripe-side customers);
- the unsigned Lydia partnership contract;
- proof that the payer e-mail is not kept.

Association enrolment with conditions and uploaded documents is DROPPED (owner, 2026-11-19): Lydia Pro collects the documents.

The code and the database are done (owner, 2026-11-19: *"Tu peux tout supprimer en ce qui concerne Stripe"*): the three dead columns go with the held migrations social 177 and core 027 (the stored `stripe` payment method stays as historic data), the GitHub secrets were already deleted, and the permission rename never needed a data migration (only its bit is stored). The two columns still named `stripe*` hold the LIVE Lydia references and stay ([stripe-archive](../stripe-archive.md#the-last-removal-owner-2026-11-19-tu-peux-tout-supprimer-en-ce-qui-concerne-stripe)).
