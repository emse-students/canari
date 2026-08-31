import { getMetadataArgsStorage } from 'typeorm';

// Importing an entity is what registers its decorators with the metadata storage, so every entity
// carrying a user-id column must be imported here for this spec to see it.
import { PartnershipCode } from './partnership-code.entity';
import { AssociationMember } from './association-member.entity';
import { AssociationRoleHistory } from './association-role-history.entity';
import { DocumentReviewerGrant } from './document-reviewer-grant.entity';
import { ChannelMember } from '../../channels/entities/channel-member.entity';
import { Submission } from '../../forms/entities/submission.entity';

/**
 * A user id in this estate is NOT a UUID, and one column forgot it.
 *
 * `x-user-id` carries a 64-character hex digest. Migration 047 declared
 * `partnership_codes."claimedByUserId"` as `uuid`, so every claim on a `code_pool` partnership card
 * failed at the FIRST statement with SQLSTATE 22P02 (`invalid input syntax for type uuid`) and the
 * route answered 500 - for every user, on every card, from the day the feature shipped. Prod held
 * zero claimed rows against a live card. Migration 056 widened it to `varchar(255)`.
 *
 * Nothing caught it: the service specs mock the repository, so no column type is ever exercised, and
 * a green `bun run test` said nothing about a type only Postgres would ever check. This spec is the
 * cheap replacement - it reads the DECLARED metadata, needs no database, and covers the whole class
 * rather than the one column that broke.
 */
describe('a user-id column is varchar(255), never uuid', () => {
  const CASES: [string, string, Function][] = [
    ['partnership_codes', 'claimedByUserId', PartnershipCode],
    ['association_members', 'userId', AssociationMember],
    ['association_role_history', 'userId', AssociationRoleHistory],
    ['document_reviewer_grants', 'userId', DocumentReviewerGrant],
    ['channel_members', 'userId', ChannelMember],
    ['form_submissions', 'userId', Submission],
  ];

  it.each(CASES)('%s.%s is declared varchar(255)', (_table, property, target) => {
    const column = getMetadataArgsStorage().columns.find(
      (c) => c.target === target && c.propertyName === property
    );

    // Undefined here means the entity was renamed or the property moved, not that the type is right.
    expect(column).toBeDefined();
    expect(column?.options.type).toBe('varchar');
    expect(column?.options.length).toBe(255);
  });

  it('has no user-id-shaped column typed uuid anywhere in the imported entities', () => {
    const offenders = getMetadataArgsStorage()
      .columns.filter(
        (c) => /UserId$|^userId$|^user_id$/.test(c.propertyName) && c.options.type === 'uuid'
      )
      .map((c) => `${(c.target as Function).name}.${c.propertyName}`);

    // A user id is a 64-char hex digest, not a UUID: a uuid column rejects every real id with
    // SQLSTATE 22P02 and the route answers 500. Use varchar(255).
    expect(offenders).toEqual([]);
  });
});
