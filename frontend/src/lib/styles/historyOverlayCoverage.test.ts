/**
 * EVERY SURFACE THAT COVERS THE SCREEN HOLDS A HISTORY ENTRY, OR SAYS WHY IT DOES NOT.
 *
 * On a phone the system Back is a `popstate`, and `historyOverlayStack` closes the overlay whose
 * entry it pops. A surface that registers none is invisible to it, so the Back pops whatever lies
 * UNDER the surface: on 2026-10-13 one Back with the message action sheet open closed the sheet AND
 * the conversation (Mi 9T, 3 of 3), and the audit that followed found fourteen more surfaces with
 * the same omission - the poll composer, every confirmation, every picker sheet, the PDF viewer.
 *
 * NOTHING TYPES A COMPONENT AS AN OVERLAY, so this reads the source. A file is a SURFACE when it
 * marks a node `use:coversScreen` (the iOS tab bar's registry of what covers the screen, which every
 * modal, sheet, drawer and viewer already joins), renders a `SidePanel` or a `FullScreenViewer` (two
 * wrappers that leave the entry to their consumer), or portals a `role="menu"` / `role="dialog"`.
 * A surface must call `bindHistoryOverlay` or `pushHistoryOverlay`, or sit in `EXEMPT` with the
 * reason. The list is held exactly: an entry whose file now registers, or no longer is a surface,
 * fails too, so it cannot go stale in either direction.
 *
 * A file that renders `Modal`, `ModalOverlay` or `FloatingSurface` needs nothing: those register
 * themselves, and they are surfaces checked here like any other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelteFiles, withoutComments } from './markupSources';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Surfaces that hold no history entry of their own, each with the reason. `registeredBy` names the
 * files that register it in its place (its host, or every consumer of a wrapper): each must still
 * register, or the exemption is a hole.
 */
const EXEMPT: Record<string, { reason: string; registeredBy?: string[] }> = {
  'lib/components/calendar/EventFormModal.svelte': {
    reason: 'drawn by hand; each host registers it alongside its other modals',
    registeredBy: [
      'lib/components/associations/AssociationCalendarSection.svelte',
      'routes/calendar/+page.svelte',
    ],
  },
  'lib/components/chat/ComposerGifPanel.svelte': {
    reason: "one of the composer's surfaces; ChatComposer registers the active one",
    registeredBy: ['lib/components/chat/ChatComposer.svelte'],
  },
  'lib/components/chat/ConversationSidePanel.svelte': {
    reason: 'the conversation side panel is the `sidePanel` state useConversations registers',
    registeredBy: ['lib/composables/useConversations.svelte.ts'],
  },
  'lib/components/shared/SidePanel.svelte': {
    reason: 'a wrapper: registering here would double the entry its consumers already hold',
    registeredBy: [
      'lib/composables/useConversations.svelte.ts',
      'lib/components/sidebar/Sidebar.svelte',
    ],
  },
  'lib/components/sidebar/SidebarCommunityAdminPanel.svelte': {
    reason: 'opened and closed by Sidebar, which registers it',
    registeredBy: ['lib/components/sidebar/Sidebar.svelte'],
  },
  'lib/components/shared/FullScreenViewer.svelte': {
    reason: 'a wrapper: each consumer registers, MediaLightbox with its own close semantics',
    registeredBy: [
      'lib/components/shared/MediaLightbox.svelte',
      'lib/components/shared/PdfViewerModal.svelte',
    ],
  },
  'routes/admin/carte/[id]/+page.svelte': {
    reason: 'the full-window card editor exists only for a fine pointer (canEdit = !coarsePointer)',
  },
};

/** Why a file counts as a surface, or an empty list when it does not. */
function surfaceMarks(body: string): string[] {
  const marks: string[] = [];
  if (/use:coversScreen/.test(body)) marks.push('coversScreen');
  if (/<SidePanel\b/.test(body)) marks.push('SidePanel');
  if (/<FullScreenViewer\b/.test(body)) marks.push('FullScreenViewer');
  const tags = body.match(/<[a-zA-Z][^<>]*>/g) ?? [];
  if (tags.some((t) => /use:portal/.test(t) && /role="(?:menu|dialog|alertdialog)"/.test(t))) {
    marks.push('portalled menu or dialog');
  }
  return marks;
}

const REGISTERS = /\b(?:bindHistoryOverlay|pushHistoryOverlay)\(/;

/** Whether a source file (any extension) calls the history stack. */
function fileRegisters(path: string): boolean {
  return REGISTERS.test(withoutComments(readFileSync(join(src, path), 'utf8')));
}

const surfaces = svelteFiles(src).map((file) => {
  const body = withoutComments(readFileSync(file, 'utf8'));
  return {
    path: relative(src, file).replaceAll('\\', '/'),
    marks: surfaceMarks(body),
    registers: REGISTERS.test(body),
  };
});

describe('every screen-covering surface answers the system Back', () => {
  it('registers a history entry, or is exempt with a reason', () => {
    const missing = surfaces
      .filter((s) => s.marks.length > 0 && !s.registers && !(s.path in EXEMPT))
      .map((s) => `${s.path} (${s.marks.join(', ')})`);
    expect(missing).toEqual([]);
  });

  it('holds no stale exemption', () => {
    const stale = Object.keys(EXEMPT).filter((path) => {
      const s = surfaces.find((x) => x.path === path);
      return !s || s.marks.length === 0 || s.registers;
    });
    expect(stale).toEqual([]);
  });

  it('gives every exemption a reason, and every host it names still registers', () => {
    for (const [path, { reason, registeredBy = [] }] of Object.entries(EXEMPT)) {
      expect(reason.length, path).toBeGreaterThan(20);
      for (const host of registeredBy) expect(fileRegisters(host), `${path} <- ${host}`).toBe(true);
    }
  });
});
