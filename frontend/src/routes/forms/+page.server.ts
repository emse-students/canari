import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  // Fetch forms on the server so the client never receives the user id.
  const API_Base = import.meta.env.VITE_SOCIAL_URL || '';
  const url = `${API_Base}/api/forms`;

  const auth = event.request.headers.get('authorization') ?? '';

  const res = await fetch(url, {
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    return { forms: [] };
  }

  const forms = await res.json();
  return { forms };
};
