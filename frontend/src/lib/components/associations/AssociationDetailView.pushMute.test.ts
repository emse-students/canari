import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const api = vi.hoisted(() => ({
  getAssociationBySlug: vi.fn(),
  listMembers: vi.fn(),
  listAssociationProducts: vi.fn(),
  listAssociationPartnerships: vi.fn(),
  getAssociationFollowStatus: vi.fn(),
  getAssociationPushMuteStatus: vi.fn(),
  muteAssociationPush: vi.fn(),
  unmuteAssociationPush: vi.fn(),
  followAssociation: vi.fn(),
  unfollowAssociation: vi.fn(),
  getMyBdeReach: vi.fn(),
}));
const session = vi.hoisted(() => ({ userId: 'u1' as string | null }));

vi.mock('$lib/associations/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));
vi.mock('$lib/stores/user', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentUserId: () => session.userId,
  isGlobalAdmin: () => false,
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), afterNavigate: vi.fn() }));
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/associations/bde'), params: { slug: 'bde' } },
}));
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false }));
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));

import AssociationDetailView from './AssociationDetailView.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render() {
  component = mount(AssociationDetailView, { target: document.body, props: { slug: 'bde' } });
  await settle();
}

const button = () => document.querySelector<HTMLButtonElement>('[data-testid="asso-push-mute"]');

beforeEach(() => {
  vi.clearAllMocks();
  session.userId = 'u1';
  api.getAssociationBySlug.mockResolvedValue({
    id: 'a1',
    name: 'BDE',
    slug: 'bde',
    type: 'association',
  });
  api.listMembers.mockResolvedValue([]);
  api.listAssociationProducts.mockResolvedValue([]);
  api.listAssociationPartnerships.mockResolvedValue([]);
  api.getAssociationFollowStatus.mockResolvedValue({ following: false });
  api.getAssociationPushMuteStatus.mockResolvedValue({ muted: false });
  api.getMyBdeReach.mockResolvedValue({ validateEvents: [], manageAsso: [] });
  api.muteAssociationPush.mockResolvedValue({ ok: true });
  api.unmuteAssociationPush.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('AssociationDetailView push mute button', () => {
  it('offers the mute, flips on tap and calls the API', async () => {
    await render();
    expect(button()!.textContent).toContain(m.asso_push_mute_button());
    expect(button()!.getAttribute('aria-pressed')).toBe('false');

    button()!.click();
    await settle();

    expect(api.muteAssociationPush).toHaveBeenCalledWith('a1');
    expect(button()!.textContent).toContain(m.asso_push_unmute_button());
    expect(button()!.getAttribute('aria-pressed')).toBe('true');
  });

  it('starts muted from the server status and unmutes', async () => {
    api.getAssociationPushMuteStatus.mockResolvedValue({ muted: true });
    await render();
    expect(button()!.getAttribute('aria-pressed')).toBe('true');

    button()!.click();
    await settle();

    expect(api.unmuteAssociationPush).toHaveBeenCalledWith('a1');
    expect(button()!.getAttribute('aria-pressed')).toBe('false');
  });

  it('rolls back when the write is refused, and does not touch the follow', async () => {
    api.muteAssociationPush.mockRejectedValue(new Error('500'));
    await render();

    button()!.click();
    await settle();

    expect(button()!.getAttribute('aria-pressed')).toBe('false');
    expect(api.followAssociation).not.toHaveBeenCalled();
    expect(api.unfollowAssociation).not.toHaveBeenCalled();
  });

  it('is absent without an account and never asks the server', async () => {
    session.userId = null;
    await render();
    expect(button()).toBeNull();
    expect(api.getAssociationPushMuteStatus).not.toHaveBeenCalled();
  });
});
