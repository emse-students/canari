import githubCss from 'highlight.js/styles/github.min.css?url';
import githubDarkCss from 'highlight.js/styles/github-dark.min.css?url';

const LINK_ID = 'canari-hljs-theme';
let themeObserver: MutationObserver | undefined;

/** Swaps highlight.js stylesheet when `data-theme` changes (singleton). */
export function ensureHljsTheme(): void {
  if (typeof document === 'undefined') return;

  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }

  const apply = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    link!.href = dark ? githubDarkCss : githubCss;
  };

  apply();

  if (!themeObserver) {
    themeObserver = new MutationObserver(apply);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }
}
