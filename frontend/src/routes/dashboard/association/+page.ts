import { redirect } from '@sveltejs/kit';

/** Legacy Stripe stub — onboarding is per-association on the edit page. */
export function load() {
  redirect(302, '/associations');
}
