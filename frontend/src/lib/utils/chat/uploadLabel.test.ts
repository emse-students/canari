import { expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { uploadCaption } from '$lib/utils/chat/uploadLabel';
import { uploadPercent, type UploadPhase } from '$lib/utils/chat/uploadProgress.svelte';

const view = (phase: UploadPhase) => ({ phase, loaded: 0, total: 0, attempt: 1 });

it.each([
  ['queued', () => m.upload_queued()],
  ['waiting', () => m.upload_waiting()],
  ['repairing', () => m.upload_repairing()],
  ['retrying', () => m.upload_retrying()],
  ['preparing', () => m.upload_preparing()],
] as const)('%s has its own honest caption and no percentage', (phase, expected) => {
  expect(uploadCaption(view(phase), 1000)).toBe(expected());
  expect(uploadPercent({ ...view(phase), total: 100, loaded: 50 })).toBeNull();
});

it('only waiting accuses the connection', () => {
  const others = (['queued', 'repairing', 'retrying'] as const).map((p) =>
    uploadCaption(view(p), 1)
  );
  expect(others).not.toContain(m.upload_waiting());
});
