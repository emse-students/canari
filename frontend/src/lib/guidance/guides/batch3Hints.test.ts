/**
 * BATCH 3 - associations and the campus space: the association page hint (follow, members, join),
 * the publish-as hint, the manager hints (the page, the management hub) and "Mon espace". Each on
 * its route only, every step kept on both layouts once its anchors are drawn, a step whose control
 * is not drawn for this account left out, and the anchors really named in the sources (a renamed
 * anchor fails here rather than silently skipping the step in production).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { planGuide } from '../guideEngine.svelte';
import type { GuideDefinition, GuideLayout } from '../guideTypes';
import { isHelpId } from '../helpIds';
import { GUIDES } from './index';
import { associationJoinHint } from './associationJoinHint';
import { associationManageHint, associationManageHubHint } from './associationManageHint';
import { mySpaceHint } from './mySpaceHint';
import { postAsHint } from './postAsHint';
import { isAssociationManagementHub, isAssociationPage } from './associationRoutes';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));
vi.mock('$lib/posts/postAsAccess.svelte', () => ({ canPostAsAssociation: () => true }));

const PHONE: GuideLayout = { phone: true, swipe: true, nativeTabBar: false };
const DESKTOP: GuideLayout = { phone: false, swipe: false, nativeTabBar: false };
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, '../../..', rel), 'utf8');

const PAGE = 'lib/components/associations/AssociationDetailView.svelte';
const HUB = 'routes/associations/[slug]/edit/[[section]]/+page.svelte';

const CASES: {
  guide: GuideDefinition;
  route: string;
  elsewhere: string;
  files: string[];
  anchors: string[];
}[] = [
  {
    guide: associationJoinHint,
    route: '/associations/bde-emse',
    elsewhere: '/associations/bde-emse/edit',
    files: [PAGE],
    anchors: ['asso.follow', 'asso.members', 'asso.join'],
  },
  {
    guide: postAsHint,
    route: '/posts',
    elsewhere: '/chat',
    files: ['routes/posts/+page.svelte', 'lib/components/navigation/MobileHeader.svelte'],
    anchors: ['posts.compose'],
  },
  {
    guide: associationManageHint,
    route: '/associations/bde-emse',
    elsewhere: '/associations/bde-emse/edit',
    files: [PAGE],
    anchors: ['asso.manage', 'asso.agenda'],
  },
  {
    guide: associationManageHubHint,
    route: '/associations/bde-emse/edit',
    elsewhere: '/associations/bde-emse',
    files: [HUB],
    anchors: ['asso.edit.members', 'asso.edit.audience'],
  },
  {
    guide: mySpaceHint,
    route: '/posts',
    elsewhere: '/chat',
    files: ['lib/components/posts/FeedTabRow.svelte'],
    anchors: ['posts.tab.all'],
  },
];

describe.each(CASES)('$guide.id', ({ guide, route, elsewhere, files, anchors }) => {
  it('is a hint under a listed id, registered, applying to its route only', () => {
    expect(isHelpId(guide.id)).toBe(true);
    expect(guide.kind).toBe('hint');
    expect(GUIDES).toContain(guide);
    expect(guide.appliesTo(route)).toBe(true);
    expect(guide.appliesTo(elsewhere)).toBe(false);
  });

  it('keeps every step on both layouts once its anchors are drawn', () => {
    for (const layout of [PHONE, DESKTOP]) {
      const { steps, skipped } = planGuide(guide, layout, (a) => anchors.includes(a));
      expect(steps.map((s) => s.id)).toEqual(guide.steps.map((s) => s.id));
      expect(skipped).toEqual([]);
    }
  });

  it('leaves a step out, not-rendered, where its control is not drawn', () => {
    const { steps, skipped } = planGuide(guide, PHONE, () => false);
    expect(steps).toEqual([]);
    expect(skipped.every((s) => s.reason === 'not-rendered')).toBe(true);
  });

  it('names anchors the sources really mark', () => {
    const source = files.map(src).join('\n');
    for (const anchor of anchors) {
      // The feed tabs mark themselves from one template, `posts.tab.${tab.feed}`.
      const perTab =
        anchor.startsWith('posts.tab.') &&
        source.includes('use:guideAnchor={`posts.tab.${tab.feed}`}') &&
        source.includes(`{ feed: '${anchor.slice('posts.tab.'.length)}'`);
      expect(source.includes(`'${anchor}'`) || perTab, anchor).toBe(true);
    }
  });
});

describe('eligibility is the page facts the control is drawn by', () => {
  it('a member (no join step) and a non-manager (no manager step) are shown only what applies', () => {
    const drawn = new Set(['asso.follow', 'asso.members']);
    const join = planGuide(associationJoinHint, PHONE, (a) => drawn.has(a));
    expect(join.steps.map((s) => s.id)).toEqual(['follow', 'members']);
    expect(join.skipped).toEqual([{ step: 'join', reason: 'not-rendered' }]);
    expect(planGuide(associationManageHint, PHONE, (a) => drawn.has(a)).steps).toEqual([]);
  });

  it('a manager without the audience right is shown the members row only', () => {
    const { steps } = planGuide(associationManageHubHint, PHONE, (a) => a === 'asso.edit.members');
    expect(steps.map((s) => s.id)).toEqual(['members']);
  });

  it('the page marks the join row only for a non-member of an association offering a tier', () => {
    const page = src(PAGE);
    expect(page).toContain("!myMembership && offeredTiers(products).length > 0 ? 'asso.join'");
  });

  it('the agenda row is marked only for a manager who may propose events', () => {
    expect(src(PAGE)).toContain("canManage && canProposeEvent ? 'asso.agenda'");
  });

  it('the publish-as hint reads the picker list and declares no replay', () => {
    expect(postAsHint.eligible).toBeTypeOf('function');
    expect(postAsHint.replay).toBeUndefined();
    expect(src('lib/posts/postAsAccess.svelte.ts')).toContain('listPostAsAssociations');
    expect(src('lib/components/posts/CreatePostForm.svelte')).toContain('listPostAsAssociations');
  });
});

describe('the association routes', () => {
  it('tells the page from the hub, a section and the creation page', () => {
    expect(isAssociationPage('/associations/bde-emse')).toBe(true);
    expect(isAssociationPage('/associations/bde-emse/')).toBe(true);
    expect(isAssociationPage('/associations/new')).toBe(false);
    expect(isAssociationPage('/associations')).toBe(false);
    expect(isAssociationPage('/associations/bde-emse/members')).toBe(false);
    expect(isAssociationPage('/lists/liste-x')).toBe(false);
    expect(isAssociationManagementHub('/associations/bde-emse/edit')).toBe(true);
    expect(isAssociationManagementHub('/associations/bde-emse/edit/members')).toBe(false);
    expect(isAssociationManagementHub('/associations/bde-emse')).toBe(false);
  });
});

describe('replay from Settings', () => {
  it('"Mon espace" is replayable on the feed; the association helps, bound to one route, are not', () => {
    expect(mySpaceHint.replay?.route).toBe('/posts');
    expect(mySpaceHint.replay?.label().length).toBeGreaterThan(0);
    for (const g of [associationJoinHint, associationManageHint, associationManageHubHint]) {
      expect(g.replay, g.id).toBeUndefined();
    }
  });
});
