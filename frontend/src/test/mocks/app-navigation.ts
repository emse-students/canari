/** Vitest stub for `$app/navigation` (not available outside SvelteKit). */
export async function goto(_href: string, _opts?: { replaceState?: boolean }): Promise<void> {}

export async function invalidateAll(): Promise<void> {}

export function beforeNavigate(
  _callback: (navigation: { from: unknown; to: unknown; cancel: () => void }) => void
): () => void {
  return () => {};
}

export function afterNavigate(
  _callback: (navigation: { from: unknown; to: unknown }) => void
): () => void {
  return () => {};
}

export function disableScrollHandling(): void {}

export function pushState(_url: string, _state: unknown): void {}

export function replaceState(_url: string, _state: unknown): void {}
