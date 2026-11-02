import {
  NEWLY_REACHED_BY_MEMBER_REPOST_SQL,
  memberRepostablePostSql,
  memberRepostCarriesSql,
  postVisibleToViewerSql,
} from './reader-spaces';

/**
 * THE POST OF A LIST OR OF A MEMBERS-ONLY ASSOCIATION IS NEVER CARRIED BY A MEMBER REPOST (owner,
 * 2026-11-02). One clause, read in the reader predicate's repost door - so the feed, the card's
 * names and Suivis agree - and spelled on the post row it is given. What it selects is proven
 * against PostgreSQL in `member-reposts.integration.spec.ts`.
 */
describe('memberRepostablePostSql', () => {
  it('admits a personal post, and an entity post only of an ALLOWED type with a rule', () => {
    const sql = memberRepostablePostSql('p');
    expect(sql).toContain('p."associationId" IS NULL OR EXISTS');
    // An allowlist: a type added later (`CHK_associations_type`) stays refused until listed.
    expect(sql).toContain(`vis_mrep_asso.type IN ('association', 'institution')`);
    expect(sql).not.toContain(`<> 'list'`);
    expect(sql).toContain('FROM association_audiences vis_mrep_arule');
    expect(sql).toContain('vis_mrep_asso.id = p."associationId"');
  });

  it('is a term of every repost carry, so a repost of such a post reaches nobody', () => {
    expect(memberRepostCarriesSql('p', 'r', '$1')).toContain(memberRepostablePostSql('p'));
    // ...and through it, of the reader predicate's repost door.
    expect(postVisibleToViewerSql('posts', '$1')).toContain(memberRepostablePostSql('posts'));
  });

  it("is read by the repost write's newly-reached set, in the same statement as its 'before'", () => {
    expect(NEWLY_REACHED_BY_MEMBER_REPOST_SQL).toContain(memberRepostablePostSql('nr_post'));
  });

  it('is not read where member reposts are left out', () => {
    expect(postVisibleToViewerSql('posts', '$1', { memberReposts: false })).not.toContain(
      'vis_mrep_asso'
    );
  });
});
