// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { isDragExcludedTarget } from './dragExclusion';

afterEach(() => (document.body.innerHTML = ''));

function target(html: string, selector: string): Element {
  document.body.innerHTML = `<div id="card">${html}</div>`;
  return document.body.querySelector(selector)!;
}

describe('isDragExcludedTarget', () => {
  it.each([
    ['<input id="t">'],
    ['<textarea id="t"></textarea>'],
    ['<select id="t"></select>'],
    ['<div id="t" contenteditable="true"></div>'],
    ['<div id="t" contenteditable></div>'],
    ['<div id="t" role="textbox"></div>'],
    ['<button id="t"></button>'],
    ['<a id="t" href="/x"></a>'],
    ['<label id="t"><input type="checkbox"></label>'],
    ['<div data-no-drag><span id="t"></span></div>'],
  ])('excludes %s', (html) => {
    expect(isDragExcludedTarget(target(html, '#t'))).toBe(true);
  });

  it('excludes a child of an interactive element', () => {
    expect(isDragExcludedTarget(target('<button><svg id="t"></svg></button>', '#t'))).toBe(true);
  });

  it('judges a text node by its parent', () => {
    const el = target('<input id="t">', '#t');
    expect(isDragExcludedTarget(el.ownerDocument.createTextNode('x'))).toBe(false);
    const p = target('<button id="t">hi</button>', '#t');
    expect(isDragExcludedTarget(p.firstChild)).toBe(true);
  });

  it('keeps inert parts of the card draggable', () => {
    expect(isDragExcludedTarget(target('<div id="t"><span>x</span></div>', '#t'))).toBe(false);
    expect(isDragExcludedTarget(target('<div id="t" contenteditable="false"></div>', '#t'))).toBe(
      false
    );
    expect(isDragExcludedTarget(null)).toBe(false);
  });

  it('lets a handle drag even when it is a button', () => {
    expect(isDragExcludedTarget(target('<button id="t" data-drag-handle></button>', '#t'))).toBe(
      false
    );
    expect(
      isDragExcludedTarget(target('<button data-drag-handle><svg id="t"></svg></button>', '#t'))
    ).toBe(false);
  });

  it('still excludes a field nested inside a handle region', () => {
    expect(isDragExcludedTarget(target('<div data-drag-handle><input id="t"></div>', '#t'))).toBe(
      true
    );
  });
});
