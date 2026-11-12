// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { portalWhile } from './portal';
import { inertAppShell } from './inertAppShell';

describe('inertAppShell', () => {
  const setup = () => {
    document.body.innerHTML = '';
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    const node = document.createElement('section');
    shell.appendChild(node);
    const dialog = document.createElement('div');
    document.body.append(shell, dialog);
    return { shell, node, dialog };
  };

  it('makes the shell inert while mounted, and only the shell', () => {
    const { shell, node, dialog } = setup();
    portalWhile(node, true);
    const action = inertAppShell(node);
    expect(shell.inert).toBe(true);
    expect(dialog.inert).toBe(false);
    expect(node.inert).toBe(false);
    action.destroy?.();
  });

  it('restores the shell on destroy', () => {
    const { shell, node } = setup();
    portalWhile(node, true);
    inertAppShell(node).destroy?.();
    expect(shell.inert).toBe(false);
  });

  it('keeps an inert the shell already had', () => {
    const { shell, node } = setup();
    shell.inert = true;
    portalWhile(node, true);
    inertAppShell(node).destroy?.();
    expect(shell.inert).toBe(true);
  });
});
