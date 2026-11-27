import { error } from '@sveltejs/kit';

/**
 * The mail screens on an invented mailbox (`src/test/mailPreview`), for screenshots and design
 * review: `vite dev` only - every build answers 404, and the preview's code is not in the bundle.
 */
export function load(): void {
  if (!import.meta.env.DEV) error(404, 'Not found');
}
