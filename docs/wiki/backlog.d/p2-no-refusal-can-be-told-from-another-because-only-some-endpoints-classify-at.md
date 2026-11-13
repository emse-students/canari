## P2 - NO REFUSAL CAN BE TOLD FROM ANOTHER, BECAUSE ONLY SOME ENDPOINTS CLASSIFY AT THE THROW

target: 1.8.0

The English-on-a-French-screen sweep is finished ([durable-rules](../durable-rules.md), [social-service](../services/social-service.md)).
Every frontend API module and the delivery and core services now classify at the throw (2026-10-10 to 2026-10-19: `ApiRefusalError`, `refusalFromResponse`, one stable code per actionable refusal worded by `describeRefusalCode`, [table](../services/chat-delivery.md#refusal-codes---one-stable-name-per-refusal-a-member-can-act-on-2026-10-19)). Worded but waiting for a caller that types the refusal: `NOT_A_MEMBER` on notification settings, `USER_BLOCKED` on add-member, `ADMIN_SELF_DEMOTE` (no admin screen calls it).
**Still owed:** the social-service refusals not yet coded. The
`sessionAuth.ts` site closed with step 2 of the damaged-MLS-state P1 (PK1): the init throws typed errors,
and `serverProse.test.ts`'s allowlist is empty.
