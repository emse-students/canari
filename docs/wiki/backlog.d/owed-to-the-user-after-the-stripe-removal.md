## Owed to the user after the Stripe removal

target: 1.8.0

What is left is administrative, and no agent can do it ([stripe-archive](../stripe-archive.md#owed-by-the-user-one-off)):

- delete the webhook endpoint in the Stripe dashboard and, when no refund can still be asked, close the Stripe account (its closure is what purges the Stripe-side customers);
- the unsigned Lydia partnership contract;
- proof that the payer e-mail is not kept;
- association enrolment with conditions and uploaded documents.

The code and the database are done (owner, 2026-11-19: *"Tu peux tout supprimer en ce qui concerne Stripe"*): the three dead columns and the stored `stripe` payment method go with the held migrations social 177 and core 027, the GitHub secrets were already deleted, and the permission rename never needed a data migration (only its bit is stored). The two columns still named `stripe*` hold the LIVE Lydia references and stay ([stripe-archive](../stripe-archive.md#the-last-removal-owner-2026-11-19-tu-peux-tout-supprimer-en-ce-qui-concerne-stripe)).
