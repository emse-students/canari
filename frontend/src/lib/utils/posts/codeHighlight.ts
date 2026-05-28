import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  h: 'c',
  hpp: 'cpp',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
};

let registered = false;

function registerLanguages(): void {
  if (registered) return;
  registered = true;
  const pairs: Array<[string, typeof javascript]> = [
    ['bash', bash],
    ['c', c],
    ['cpp', cpp],
    ['css', css],
    ['go', go],
    ['java', java],
    ['javascript', javascript],
    ['json', json],
    ['kotlin', kotlin],
    ['markdown', markdown],
    ['php', php],
    ['plaintext', plaintext],
    ['python', python],
    ['rust', rust],
    ['sql', sql],
    ['typescript', typescript],
    ['xml', xml],
    ['yaml', yaml],
  ];
  for (const [name, mod] of pairs) {
    hljs.registerLanguage(name, mod);
  }
}

export function resolveHighlightLanguage(lang: string): string {
  const trimmed = lang.trim().toLowerCase();
  if (!trimmed) return '';
  return LANGUAGE_ALIASES[trimmed] ?? trimmed;
}

export interface HighlightedCode {
  html: string;
  language: string;
}

/**
 * Highlight a fenced code block; falls back to auto-detect, then plaintext.
 *
 * Security: output is passed to Svelte `{@html}`. highlight.js escapes `<>&"'`
 * in user source and only injects `<span class="hljs-…">` wrappers - see tests.
 */
export function highlightCode(text: string, lang: string): HighlightedCode {
  registerLanguages();
  const source = text.replace(/\n$/, '');
  const resolved = resolveHighlightLanguage(lang);

  if (resolved && hljs.getLanguage(resolved)) {
    const result = hljs.highlight(source, { language: resolved });
    return { html: result.value, language: result.language ?? resolved };
  }

  const auto = hljs.highlightAuto(source);
  if (auto.language) {
    return { html: auto.value, language: auto.language };
  }

  const plain = hljs.highlight(source, { language: 'plaintext' });
  return { html: plain.value, language: 'text' };
}
