import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderedAvatarPng } from './avatarBitmap';

/** A 2d context that records what was painted - happy-dom has none of its own. */
function recordingContext() {
  const calls: string[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push(`${key}(${args.filter((a) => typeof a === 'string').join(',')})`);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      if (key === 'fillStyle') calls.push(`fillStyle=${value}`);
      return true;
    },
  });
  return { ctx, calls };
}

describe('renderedAvatarPng', () => {
  let calls: string[];
  beforeEach(() => {
    const recording = recordingContext();
    calls = recording.calls;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      recording.ctx as unknown as CanvasRenderingContext2D
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,x');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  function photo(src: string) {
    const img = document.createElement('img');
    img.src = src;
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: 80 });
    Object.defineProperty(img, 'naturalHeight', { value: 60 });
    return img;
  }

  it('paints a loaded photo, cropped square', async () => {
    const root = document.createElement('span');
    root.appendChild(photo('blob:tauri://localhost/abc'));
    expect(await renderedAvatarPng(root)).toBe('data:image/png;base64,x');
    expect(calls.filter((c) => c.startsWith('drawImage'))).toHaveLength(1);
  });

  it('does not read a photo from another origin, which would taint the canvas', async () => {
    const root = document.createElement('span');
    root.appendChild(photo('https://canari.emse.fr/api/users/a/avatar'));
    expect(await renderedAvatarPng(root)).toBeNull();
    expect(calls.some((c) => c.startsWith('drawImage'))).toBe(false);
  });

  it('paints the initials on their own background when there is no photo', async () => {
    const root = document.createElement('span');
    const initials = document.createElement('div');
    initials.textContent = 'AB';
    initials.style.backgroundColor = 'rgb(5, 5, 5)';
    initials.style.color = 'rgb(255, 204, 0)';
    root.appendChild(initials);
    document.body.appendChild(root);
    await renderedAvatarPng(root);
    expect(calls).toContain('fillStyle=rgb(5, 5, 5)');
    expect(calls).toContain('fillText(AB)');
  });

  it('paints the disc of the avatar when the initials sit in a transparent span inside it', async () => {
    // `Avatar`: the disc on a div, the initials in a `text-zoom-exempt` span with no background.
    const root = document.createElement('span');
    const disc = document.createElement('div');
    disc.style.backgroundColor = 'rgb(16, 24, 48)';
    disc.style.color = 'rgb(255, 204, 0)';
    const initials = document.createElement('span');
    initials.textContent = 'CT';
    disc.appendChild(initials);
    root.appendChild(disc);
    document.body.appendChild(root);
    await renderedAvatarPng(root);
    expect(calls).toContain('fillStyle=rgb(16, 24, 48)');
    expect(calls).toContain('fillText(CT)');
  });

  it('adds the presence dot when the web shows one', async () => {
    const root = document.createElement('span');
    const initials = document.createElement('div');
    initials.textContent = 'AB';
    const dot = document.createElement('span');
    dot.setAttribute('data-presence-dot', '');
    dot.style.backgroundColor = 'rgb(34, 197, 94)';
    root.append(initials, dot);
    document.body.appendChild(root);
    await renderedAvatarPng(root);
    expect(calls).toContain('fillStyle=rgb(34, 197, 94)');
  });
});
