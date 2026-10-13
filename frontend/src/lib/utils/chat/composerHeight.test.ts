/**
 * THE TYPING BUBBLE WENT UNDER THE COMPOSER WITH THE KEYBOARD CLOSED (user report, phone app,
 * 2026-10-13). The thread reserves `--chat-composer-height` under its last row; that height is the
 * footer's `offsetHeight`, padding included, and the footer's bottom padding follows the platform's
 * safe-area inset. The observer watched the CONTENT box, so an inset arriving after mount grew the
 * footer and published nothing.
 *
 * happy-dom has no layout and no ResizeObserver, so both are stubbed: the observer records what it
 * was asked to watch, and `offsetHeight` is whatever the test says the footer measures.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { COMPOSER_HEIGHT_PROPERTY, publishComposerHeight } from './composerHeight';

interface StubObserver {
  callback: ResizeObserverCallback;
  targets: { node: Element; options?: ResizeObserverOptions }[];
  disconnected: boolean;
}

let observers: StubObserver[] = [];

function install() {
  observers = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly stub: StubObserver;
      constructor(callback: ResizeObserverCallback) {
        this.stub = { callback, targets: [], disconnected: false };
        observers.push(this.stub);
      }
      observe(node: Element, options?: ResizeObserverOptions) {
        this.stub.targets.push({ node, options });
      }
      unobserve() {}
      disconnect() {
        this.stub.disconnected = true;
      }
    }
  );
}

function footerMeasuring(initial: number) {
  const footer = document.createElement('div');
  let height = initial;
  Object.defineProperty(footer, 'offsetHeight', { get: () => height, configurable: true });
  return {
    footer,
    resize(next: number) {
      height = next;
      for (const o of observers) o.callback([], o as unknown as ResizeObserver);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(COMPOSER_HEIGHT_PROPERTY);
});

describe('publishComposerHeight', () => {
  it('watches the border box, the box whose height it publishes', () => {
    install();
    const { footer } = footerMeasuring(64);
    const stop = publishComposerHeight(footer);
    expect(observers).toHaveLength(1);
    expect(observers[0].targets).toEqual([{ node: footer, options: { box: 'border-box' } }]);
    stop();
  });

  it('publishes at once, then again when the padding grows the footer', () => {
    install();
    const { footer, resize } = footerMeasuring(64);
    const root = document.documentElement;
    const stop = publishComposerHeight(footer, root);
    expect(root.style.getPropertyValue(COMPOSER_HEIGHT_PROPERTY)).toBe('64px');
    // A 24 px navigation-bar inset reaching the WebView after mount: 0.75rem of padding becomes 24.
    resize(76);
    expect(root.style.getPropertyValue(COMPOSER_HEIGHT_PROPERTY)).toBe('76px');
    stop();
  });

  it('rounds up, so the reservation is never a fraction short of the footer', () => {
    install();
    const { footer } = footerMeasuring(75.2);
    const stop = publishComposerHeight(footer);
    expect(document.documentElement.style.getPropertyValue(COMPOSER_HEIGHT_PROPERTY)).toBe('76px');
    stop();
  });

  it('removes the property and the observer on teardown', () => {
    install();
    const { footer } = footerMeasuring(64);
    const stop = publishComposerHeight(footer);
    stop();
    expect(observers[0].disconnected).toBe(true);
    expect(document.documentElement.style.getPropertyValue(COMPOSER_HEIGHT_PROPERTY)).toBe('');
  });
});
