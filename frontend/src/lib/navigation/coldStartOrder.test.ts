/**
 * A COLD-START DEEP LINK REACHES THE ROUTER AFTER ITS ROUTE TABLE EXISTS - BECAUSE `init` DOES NO I/O.
 *
 * Kit's `_start` sets `app`, awaits the client `init` hook, then builds the route table `match`
 * reads; a `match` before that throws, and the launch URL - claimed once, never retried - would be
 * lost to the rejection. The launch URL arrives through a Tauri IPC reply (a task); everything
 * between the hooks module and the route table is microtasks only while `init` stays synchronous.
 * The reasoning is on `init` in `hooks.client.ts`; this holds the two facts it rests on.
 *
 * What it cannot see: a Kit upgrade that adds a task boundary of its own before the route table.
 * The second assertion reads Kit's source for the order it relies on, so such a change fails here.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('the cold-start order a deep link relies on', () => {
  it('keeps the client init hook synchronous', () => {
    const hooks = readFileSync(resolve(here, '../../hooks.client.ts'), 'utf8');
    expect(hooks).toMatch(/^export function init\(\): void \{\}$/m);
    expect(hooks).not.toMatch(/export (const|async function) init\b/);
  });

  it("builds Kit's route table right after awaiting init, with nothing else awaited between", () => {
    const client = readFileSync(
      resolve(here, '../../../node_modules/@sveltejs/kit/src/runtime/client/client.js'),
      'utf8'
    );
    const start = client.indexOf('app = _app;');
    const routes = client.indexOf('routes = ', start);
    expect(start).toBeGreaterThan(0);
    expect(routes).toBeGreaterThan(start);
    const between = client.slice(start, routes);
    expect(between.match(/\bawait\b/g)).toEqual(['await']);
    expect(between).toContain('await _app.hooks.init?.()');
  });
});
