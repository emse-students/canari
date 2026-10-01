import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChevronLeft, Ellipsis, Images, Search } from '@lucide/svelte';

const plugin = vi.hoisted(() => ({
  createComponent: vi.fn(async () => {}),
  updateComponent: vi.fn(async () => {}),
  removeComponent: vi.fn(async () => {}),
  onComponentEvent: vi.fn(),
  emit: null as null | ((e: { id: string; event: string; detail?: string }) => void),
}));
const runtime = vi.hoisted(() => ({ ios: true }));

vi.mock('@sosweetham/tauri-plugin-system-components-api', () => ({
  createComponent: plugin.createComponent,
  updateComponent: plugin.updateComponent,
  removeComponent: plugin.removeComponent,
  onComponentEvent: plugin.onComponentEvent,
}));
vi.mock('$lib/utils/appVersion', () => ({ isIosTauriRuntime: () => runtime.ios }));
vi.mock('$lib/mobile/nativeTabIcons', () => ({
  classColorHex: () => '#050505',
  lucideIconPng: async (icon: { name?: string }, hex: string) => `png:${icon.name}:${hex}`,
}));
vi.mock('$lib/mobile/avatarBitmap', () => ({ renderedAvatarPng: async () => 'png:avatar' }));

import { coversScreen } from '$lib/actions/coversScreen.svelte';
import { nativeGlassPiece } from './nativeGlassPiece.svelte';

/** Lets the action's queue of plugin calls drain. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    flushSync();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function piece(rect = { left: 12, top: 40, width: 44, height: 44 }) {
  const node = document.createElement('button');
  node.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(node);
  return node;
}

function lastCreate() {
  const calls = plugin.createComponent.mock.calls as unknown as [
    { id: string; kind: string; anchor: string; props: Record<string, unknown> },
  ][];
  return calls.at(-1)![0];
}

describe('nativeGlassPiece', () => {
  beforeEach(() => {
    runtime.ios = true;
    plugin.onComponentEvent.mockImplementation(async (handler) => {
      plugin.emit = handler;
      return { unregister: async () => {} };
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('does nothing outside the iOS app - WP-G1 CSS glass stays the piece', async () => {
    runtime.ios = false;
    const node = piece();
    nativeGlassPiece(node, { id: 'chat-back', label: 'Back', icon: ChevronLeft });
    await settle();
    expect(plugin.createComponent).not.toHaveBeenCalled();
    expect(node.style.visibility).toBe('');
  });

  it('draws a native glass button at the web piece rect, then hides the web piece', async () => {
    const node = piece();
    const action = nativeGlassPiece(node, { id: 'chat-back', label: 'Back', icon: ChevronLeft });
    await settle();
    const created = lastCreate();
    expect(created.id).toMatch(/^chat-back-\d+$/);
    expect(created.kind).toBe('button');
    expect(created.anchor).toBe('absolute');
    expect(created.props).toMatchObject({
      x: 12,
      y: 40,
      width: 44,
      height: 44,
      hidden: false,
      accessibilityLabel: 'Back',
      foreground: '#050505',
    });
    expect(String(created.props.image)).toMatch(/^png:.*:#050505$/);
    expect(node.style.visibility).toBe('hidden');
    action.destroy?.();
  });

  it('opens a native menu and runs the picked entry, a toggle carrying its state', async () => {
    const photos = vi.fn();
    const search = vi.fn();
    const node = piece();
    const action = nativeGlassPiece(node, {
      id: 'chat-menu',
      label: 'More',
      icon: Ellipsis,
      items: [
        { id: 'photos', label: 'Photos', icon: Images, onSelect: photos },
        { id: 'search', label: 'Search', icon: Search, onSelect: search, active: true },
      ],
    });
    await settle();
    const created = lastCreate();
    const menu = created.props.menu as { id: string; title: string; on?: boolean }[];
    expect(menu.map((e) => e.id)).toEqual(['photos', 'search']);
    expect(menu[0]).not.toHaveProperty('on');
    expect(menu[1].on).toBe(true);

    // Synchronous in the event handler: a file input opened here keeps the tap's user gesture.
    plugin.emit!({ id: created.id, event: 'menu', detail: 'photos' });
    expect(photos).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    action.destroy?.();
  });

  it('reports a plain tap as a click', async () => {
    const onClick = vi.fn();
    const node = piece();
    const action = nativeGlassPiece(node, {
      id: 'chat-title',
      label: 'Settings',
      title: 'Alice',
      onClick,
    });
    await settle();
    const created = lastCreate();
    expect(created.props.label).toBe('Alice');
    expect(created.props.titleSize).toBeUndefined();
    plugin.emit!({ id: created.id, event: 'click' });
    expect(onClick).toHaveBeenCalledTimes(1);
    action.destroy?.();
  });

  it("sets the native title at the web title's size, so the pill keeps one line", async () => {
    const node = piece();
    const title = document.createElement('span');
    title.setAttribute('data-glass-title', '');
    title.style.fontSize = '14px';
    title.textContent = 'Canari Test Beta';
    node.appendChild(title);
    const action = nativeGlassPiece(node, {
      id: 'chat-title',
      label: 'Settings',
      title: 'Canari Test Beta',
    });
    await settle();
    const created = lastCreate();
    expect(created.props.titleSize).toBe(14);
    expect(created.props.circular).toBeUndefined();
    action.destroy?.();
  });

  it('hides under anything covering the screen, since no web layer can cover it', async () => {
    const node = piece();
    const action = nativeGlassPiece(node, { id: 'chat-add', label: 'Add', icon: Images });
    await settle();
    const id = lastCreate().id;
    plugin.updateComponent.mockClear();

    const backdrop = document.createElement('div');
    const cover = coversScreen(backdrop);
    await settle();
    expect(plugin.updateComponent).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ hidden: true })
    );

    cover.destroy();
    await settle();
    expect(plugin.updateComponent).toHaveBeenLastCalledWith(
      id,
      expect.objectContaining({ hidden: false })
    );
    action.destroy?.();
  });

  it('follows a move made by the root inset alone, with no resize anywhere', async () => {
    // iOS: native publishes --safe-area-inset-bottom when the keyboard animation ENDS, after the
    // window resize was read; the composer floor moves the "+" 22 pt and nothing resizes.
    const rect = { left: 330, top: 487, width: 44, height: 44 };
    const node = piece(rect);
    const action = nativeGlassPiece(node, { id: 'chat-add', label: 'Add', icon: Images });
    await settle();
    const id = lastCreate().id;
    plugin.updateComponent.mockClear();

    rect.top = 465;
    document.documentElement.style.setProperty('--safe-area-inset-bottom', '0px');
    await settle();
    expect(plugin.updateComponent).toHaveBeenLastCalledWith(
      id,
      expect.objectContaining({ y: 465 })
    );
    document.documentElement.style.removeProperty('--safe-area-inset-bottom');
    action.destroy?.();
  });

  it('is hidden while its web twin has no box (the phone header at md width)', async () => {
    const node = piece({ left: 0, top: 0, width: 0, height: 0 });
    const action = nativeGlassPiece(node, { id: 'chat-back', label: 'Back', icon: ChevronLeft });
    await settle();
    expect(lastCreate().props.hidden).toBe(true);
    action.destroy?.();
  });

  it('removes the native piece and gives the web one back on unmount', async () => {
    const node = piece();
    const action = nativeGlassPiece(node, { id: 'chat-back', label: 'Back', icon: ChevronLeft });
    await settle();
    const id = lastCreate().id;
    action.destroy?.();
    await settle();
    expect(plugin.removeComponent).toHaveBeenCalledWith(id);
    expect(node.style.visibility).toBe('');
  });

  it('keeps the web piece and says so at error level when the native one cannot be created', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    plugin.createComponent.mockRejectedValueOnce(new Error('no plugin'));
    const node = piece();
    const action = nativeGlassPiece(node, { id: 'chat-back', label: 'Back', icon: ChevronLeft });
    await settle();
    expect(node.style.visibility).toBe('');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('could not be created'),
      expect.any(Error)
    );
    action.destroy?.();
    await settle();
    expect(plugin.removeComponent).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
