import { SEO_DATA_ELEMENT_ID } from './renderHead';
import { injectedSeoForPath, readInjectedSeo, resetInjectedSeoCache } from './injectedSeo';

function inject(json: string): void {
  const script = document.createElement('script');
  script.type = 'application/json';
  script.id = SEO_DATA_ELEMENT_ID;
  script.textContent = json;
  document.head.appendChild(script);
}

describe('injectedSeo', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    resetInjectedSeoCache();
  });

  it('reads back what the server wrote for this page', () => {
    inject(JSON.stringify({ path: '/associations/bde', meta: { title: 'Le BDE' } }));

    expect(injectedSeoForPath('/associations/bde')?.title).toBe('Le BDE');
  });

  it('ignores the payload once the user has navigated elsewhere', () => {
    inject(JSON.stringify({ path: '/associations/bde', meta: { title: 'Le BDE' } }));

    expect(injectedSeoForPath('/posts/abc')).toBeNull();
  });

  it('treats a trailing slash as the same page', () => {
    inject(JSON.stringify({ path: '/associations/bde', meta: { title: 'Le BDE' } }));

    expect(injectedSeoForPath('/associations/bde/')?.title).toBe('Le BDE');
  });

  it('survives the block being removed on mount, because it reads once', () => {
    inject(JSON.stringify({ path: '/posts/abc', meta: { title: 'Un post' } }));
    expect(readInjectedSeo()).not.toBeNull();

    // What `SeoHead` does on mount: every `data-canari-seo` node goes, this one included.
    document.head.innerHTML = '';

    expect(injectedSeoForPath('/posts/abc')?.title).toBe('Un post');
  });

  it('answers null rather than throwing when nothing was injected - the Tauri case', () => {
    expect(readInjectedSeo()).toBeNull();
    expect(injectedSeoForPath('/posts')).toBeNull();
  });

  it('answers null on a malformed payload instead of breaking the page', () => {
    inject('{not json');

    expect(readInjectedSeo()).toBeNull();
  });

  it('rejects a payload that is not shaped like one', () => {
    inject(JSON.stringify({ meta: { title: 'no path' } }));

    expect(readInjectedSeo()).toBeNull();
  });
});
