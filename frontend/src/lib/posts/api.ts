import type { MediaRef } from '$lib/media';

export type PostImageRef = Omit<MediaRef, 'type'>;

export interface PollOption {
  id: string;
  label: string;
  votes: number;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  multipleChoice: boolean;
  endsAt?: string;
  votesByUser: Record<string, string[]>;
}

export interface EventButton {
  id: string;
  label: string;
  eventId: string;
  requiresPayment: boolean;
  amountCents?: number;
  currency?: string;
  stripePriceId?: string;
  capacity?: number;
  registrants: string[];
}

export interface FormOption {
  id: string;
  label: string;
  priceModifier: number; // Amount in cents
}

export interface FormItem {
  id: string;
  label: string;
  required: boolean;
  type: string;
  options?: FormOption[];
  rows?: string[];
  scale?: { min: number; max: number; minLabel?: string; maxLabel?: string };
}

export interface PostForm {
  id: string;
  title: string;
  eventId: string;
  basePrice: number;
  currency: string;
  submitLabel: string;
  items: FormItem[];
}

export interface PostEntity {
  _id: string;
  authorId: string;
  markdown: string;
  mentions: string[];
  links: Array<{ url: string }>;
  images: PostImageRef[];
  polls: Poll[];
  eventButtons: EventButton[];
  forms?: PostForm[];
  attachedFormId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePostPayload {
  authorId: string;
  markdown: string;
  images?: PostImageRef[];
  polls?: Array<{
    question: string;
    options: Array<{ label: string }>;
    multipleChoice?: boolean;
    endsAt?: string;
  }>;
  eventButtons?: Array<{
    label: string;
    eventId: string;
    requiresPayment: boolean;
    amountCents?: number;
    currency?: string;
    stripePriceId?: string;
    capacity?: number;
  }>;
  attachedFormId?: string;
}

function getPostsBaseUrl(): string {
  const env = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_POST_URL;
  if (typeof env === 'string' && env.trim()) {
    return env.trim().replace(/\/$/, '');
  }
  return 'http://localhost:3015';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = getPostsBaseUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const details = await res.text();
    throw new Error(`post-service ${res.status}: ${details || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function listPosts(limit = 30): Promise<PostEntity[]> {
  return request<PostEntity[]>(`/api/posts?limit=${limit}`);
}

export async function createPost(payload: CreatePostPayload): Promise<PostEntity> {
  return request<PostEntity>('/api/posts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function votePoll(
  postId: string,
  pollId: string,
  payload: { userId: string; optionIds: string[] }
): Promise<{ ok: boolean; poll: Poll }> {
  return request<{ ok: boolean; poll: Poll }>(`/api/posts/${postId}/polls/${pollId}/vote`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function registerEvent(
  postId: string,
  buttonId: string,
  payload: { userId: string; email?: string }
): Promise<{
  ok: boolean;
  registered?: boolean;
  alreadyRegistered?: boolean;
  requiresPayment: boolean;
  paymentPending?: boolean;
  checkoutUrl?: string;
  message?: string;
}> {
  return request(`/api/posts/${postId}/events/${buttonId}/register`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function submitForm(
  postId: string,
  formId: string,
  payload: { userId: string; selections: Record<string, string>; email?: string }
): Promise<{
  ok: boolean;
  requiresPayment: boolean;
  checkoutUrl?: string;
  message: string;
}> {
  return request(`/api/posts/${postId}/forms/${formId}/submit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
