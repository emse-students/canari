import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * POST MEDIA IS FULL-BLEED WITHIN THE CARD (owner, 2026-11-09, revising 2026-10-01): no side inset,
 * square corners in the middle of the card, the card's own radius only when the block is first or
 * last, 8 px under the text and none under the media. Source-pinned: the geometry is class strings.
 */
describe("PostContent media geometry", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "PostContent.svelte"),
    "utf8",
  );

  it("has no inset and no gap around the media block", () => {
    expect(source).not.toContain('class="mt-1 mb-1 w-full px-3"');
    expect(source).toContain("first:rounded-t-2xl last:rounded-b-2xl");
  });

  it("draws the media box square", () => {
    const box = source.split(/\r?\n/).find((l) => l.includes("? `w-full"));
    expect(box).toBeDefined();
    expect(box).not.toContain("rounded");
  });

  it("hands over 8 px from the text when media follows", () => {
    expect(source).toContain("{hasMedia ? 'pb-2' : 'pb-3'}");
  });
});
