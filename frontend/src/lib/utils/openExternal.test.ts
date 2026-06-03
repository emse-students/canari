import { describe, expect, it, vi } from 'vitest';
import { handleAppLinkClick } from './openExternal';

vi.mock('$lib/utils/appLinkNavigation', () => ({
  navigateInAppFromHref: vi.fn().mockResolvedValue(true),
}));

import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';

describe('handleAppLinkClick', () => {
  it('navigates in-app for supported relative paths', () => {
    document.body.innerHTML = '<a id="link" href="/calendar">Agenda</a>';
    const anchor = document.getElementById('link') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    vi.spyOn(event, 'preventDefault');
    vi.spyOn(event, 'stopPropagation');

    Object.defineProperty(event, 'target', { value: anchor });
    expect(handleAppLinkClick(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(navigateInAppFromHref).toHaveBeenCalledWith('/calendar');
  });

  it('does not swallow public Canari URLs without an in-app mapping', () => {
    document.body.innerHTML = '<a id="ext" href="https://canari-emse.fr/api/version">API</a>';
    const anchor = document.getElementById('ext') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    vi.spyOn(event, 'preventDefault');

    Object.defineProperty(event, 'target', { value: anchor });
    expect(handleAppLinkClick(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('navigates in-app for admin dashboard links', () => {
    document.body.innerHTML = '<a id="admin" href="/admin/platform">Plateforme</a>';
    const anchor = document.getElementById('admin') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    Object.defineProperty(event, 'target', { value: anchor });
    expect(handleAppLinkClick(event)).toBe(true);
    expect(navigateInAppFromHref).toHaveBeenCalledWith('/admin/platform');
  });
});
