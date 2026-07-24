import { highlightCode, resolveHighlightLanguage } from './codeHighlight';

describe('resolveHighlightLanguage', () => {
  it('maps common aliases', () => {
    expect(resolveHighlightLanguage('ts')).toBe('typescript');
    expect(resolveHighlightLanguage('py')).toBe('python');
  });
});

describe('highlightCode', () => {
  it('highlights typescript with spans', () => {
    const { html, language } = highlightCode('const x: number = 1;', 'typescript');
    expect(language).toBe('typescript');
    expect(html).toContain('<span');
    expect(html).toContain('const');
  });

  it('auto-detects when language is omitted', () => {
    const { html, language } = highlightCode('def hello():\n  pass', '');
    expect(language).toBe('python');
    expect(html).toContain('hljs');
  });

  it('escapes HTML in source so {@html} does not inject scripts', () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '</code></pre><img src=x onerror=alert(1)>',
    ];
    for (const payload of payloads) {
      const { html } = highlightCode(payload, 'javascript');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<img\b/i);
      expect(html).toMatch(/&lt;/);
    }
  });

  it('escapes HTML even when highlighter treats input as markup (xml)', () => {
    const { html } = highlightCode('<img src=x onerror=alert(1)>', 'html');
    expect(html).not.toMatch(/<img\b/i);
    expect(html).toContain('&lt;');
  });
});
