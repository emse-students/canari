import { goto } from '$app/navigation';
import { inAppPathFromHref } from '$lib/utils/publicAppUrl';

/**
 * Navigates to an in-app route when `href` is a public Canari URL or a supported relative path.
 * Returns true when navigation was handled.
 */
export async function navigateInAppFromHref(href: string): Promise<boolean> {
  const path = inAppPathFromHref(href);
  if (!path) return false;

  console.log('[appLink] In-app navigation →', path);
  try {
    await goto(path);
  } catch {
    if (typeof window !== 'undefined') window.location.href = path;
  }
  return true;
}

/**
 * Navigates to an in-app route when `url` is a public Canari web link.
 * Returns true when navigation was handled.
 */
export async function navigateInAppFromPublicUrl(url: string): Promise<boolean> {
  return navigateInAppFromHref(url);
}
