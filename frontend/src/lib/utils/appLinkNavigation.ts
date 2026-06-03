import { inAppPathFromPublicUrl } from '$lib/utils/publicAppUrl';

/**
 * Navigates to an in-app route when `url` is a public Canari web link.
 * Returns true when navigation was handled.
 */
export async function navigateInAppFromPublicUrl(url: string): Promise<boolean> {
  const path = inAppPathFromPublicUrl(url);
  if (!path) return false;

  console.log('[appLink] In-app navigation from public URL →', path);
  try {
    const { goto } = await import('$app/navigation');
    await goto(path);
  } catch {
    if (typeof window !== 'undefined') window.location.href = path;
  }
  return true;
}
