/**
 * THE PERMISSION MATRIX RESERVES WIDTH BEFORE IT MEASURES A LABEL, AND ONE SCREEN PAYS FOR IT.
 *
 * `PermissionGrid` is a table, and a table column already grows to its content. A `min-width` on
 * one can therefore only ever ADD width - it never protects a label from wrapping, because the
 * label was going to win anyway. So every pixel in those floors is reserved, not needed.
 *
 * That mattered because of who renders it. The grid has exactly ONE consumer,
 * `SidebarCommunityAdminPanel`, whose own comment records the consequence: at `max-w-4xl` the grid
 * "was under 600px and its own horizontal scrollbar was doing the work - a matrix you have to drag
 * sideways to read is a matrix nobody audits". The answer taken then was to widen that one tab to
 * `max-w-6xl`. It worked, and it bought the room from the window.
 *
 * A PANEL CANNOT BUY ROOM FROM THE WINDOW. `.side-panel` is `max-width: 28rem`, and
 * the wider the window the narrower the panel gets (`sidePanelWidth.test.ts` is the gate for that
 * inversion). So the floors have to be the ones the content actually needs, measured against the
 * narrowest box that will ever hold the grid rather than against a desktop that had room to spare.
 *
 * ## What this asserts
 *
 * The reserved width - the label column's floor plus one role column's floor per role - fits the
 * side panel's content box. Nothing here claims the grid never scrolls: a community that defines
 * enough custom roles will still overflow, and should, because then the scrollbar is reporting a
 * real shortage of room. What it forbids is overflowing on the CANONICAL roles, where the shortage
 * would be an unspent reservation rather than content.
 *
 * ## Every number is derived
 *
 * A test that types `448` is a test that goes quietly false the day the panel is resized. The panel
 * width is read from `app.css`, the role count from the union type that defines the canonical roles,
 * and the floors from the grid's own classes. Each parse is checked for having found anything at
 * all first, because a regex that matches nothing asserts nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutComments } from '$lib/styles/markupSources';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../..');
const GRID = resolve(HERE, 'PermissionGrid.svelte');
const CONSUMER = resolve(SRC, 'lib/components/sidebar/SidebarCommunityAdminPanel.svelte');
const APP_CSS = resolve(SRC, 'app.css');

/** A file's markup with comments gone and every run of whitespace collapsed to one space. */
function flatten(file: string): string {
  return withoutComments(readFileSync(file, 'utf8')).replace(/\s+/g, ' ');
}

/** Tailwind's spacing scale in px: one step is 0.25rem, and the root stays at 16px here. */
function spacingPx(step: number): number {
  return step * 4;
}

/**
 * The grid's two width floors, in px and in source order: the label column, then one role column.
 *
 * Read from the classes rather than declared, so widening either one fails here instead of
 * silently spending the panel's room.
 */
function gridFloors(): { label: number; role: number } {
  const steps = [...flatten(GRID).matchAll(/min-w-(\d+)/g)].map((m) => spacingPx(Number(m[1])));
  if (steps.length !== 2) {
    throw new Error(`expected two min-width floors in PermissionGrid, found ${steps.length}`);
  }
  return { label: steps[0], role: steps[1] };
}

/**
 * How many roles the grid renders for a community, from the union that defines them.
 *
 * `CanonicalRole` is the consumer's own declaration of what a workspace ships with. Defining a
 * fourth re-runs the arithmetic below rather than leaving this gate measuring a stale three.
 */
function canonicalRoleCount(): number {
  const union = flatten(CONSUMER).match(/type CanonicalRole = ([^;]+);/);
  if (!union) throw new Error('SidebarCommunityAdminPanel no longer declares CanonicalRole');
  return union[1].split('|').length;
}

/** The side panel's widest form, in px, read from the rule that declares it. */
function sidePanelWidthPx(): number {
  const css = readFileSync(APP_CSS, 'utf8');
  const rule = css.match(/\.side-panel \{[^}]*?max-width: ([\d.]+)rem;/);
  if (!rule) throw new Error('.side-panel no longer declares a max-width in rem');
  return Number(rule[1]) * 16;
}

describe('the permission matrix fits the narrowest box that will hold it', () => {
  it('reads a floor, a role count and a panel width out of the sources', () => {
    // Each parse is load-bearing for the arithmetic below, and a silent zero would make it vacuous.
    const { label, role } = gridFloors();
    expect(label).toBeGreaterThan(0);
    expect(role).toBeGreaterThan(0);
    expect(canonicalRoleCount()).toBeGreaterThanOrEqual(3);
    expect(sidePanelWidthPx()).toBeGreaterThan(0);
  });

  it('reserves less than the side panel gives, on the canonical roles', () => {
    const { label, role } = gridFloors();
    const reserved = label + role * canonicalRoleCount();

    // The panel's content box: its width less the padding the settings body puts around the grid.
    // `p-4` on the card the grid sits in, both sides, plus the panel body's own `p-4` both sides.
    const PADDING = spacingPx(4) * 4;
    const available = sidePanelWidthPx() - PADDING;

    expect(reserved).toBeLessThanOrEqual(available);
  });

  it('keeps the floors below what the content in them needs', () => {
    const { label, role } = gridFloors();

    // A role column holds one 32px cell button (`h-8 w-8`) and a role pill; a floor above 5rem is
    // reserving room neither of them asked for.
    expect(role).toBeLessThanOrEqual(spacingPx(20));
    // The label column holds one `text-2xs` permission label. 13rem was the floor that made the
    // consumer ask for `max-w-6xl`; anything back at that size brings the same bill.
    expect(label).toBeLessThanOrEqual(spacingPx(40));
  });
});
