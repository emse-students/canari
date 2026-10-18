/**
 * THE ORGANISER'S SIDE OF THE BOOKINGS API (WP-B4), typed.
 *
 * Routes and refusal codes are `apps/social-service/src/bookings/booking-spaces.controller.ts`,
 * described in docs/wiki/bookings-chantier.md, "WP-B4 as built". Every refusal is classified at the
 * throw as a {@link BookingsApiError}: its status, its stable `code`, and - for D29's refusals - the
 * bookings that stand in the way. A screen words it with `describeBookingRefusal`, never from the
 * server's message.
 */
import { apiFetch, type ApiFetchOptions } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';
import { SocialApiError } from '$lib/associations/api';
import type { AudienceCondition, FormItem } from '$lib/forms/api';
import { Log } from '$lib/utils/Log';
import type { Closure, StoredLine } from './availability';

export type SlotMode = 'step' | 'slots';
export type NameVisibility = 'names' | 'occupied';
export type Discoverability = 'listed' | 'link';
export type QuotaPeriod = 'day' | 'week';

/** Every setting of a space the organiser writes (D35); `null` clears a nullable one. */
export interface SpaceSettings {
  name: string;
  description: string | null;
  timeZone: string;
  slotMode: SlotMode;
  stepMinutes: number | null;
  maxSteps: number | null;
  nameVisibility: NameVisibility;
  discoverability: Discoverability;
  audience: AudienceCondition | null;
  items: FormItem[];
  privateInfo: string | null;
  /** ISO instant; no booking before it. */
  opensAt: string | null;
  minNoticeMinutes: number | null;
  horizonDays: number | null;
  maxActiveBookings: number | null;
  maxMinutesPerPeriod: number | null;
  quotaPeriod: QuotaPeriod | null;
  participantWithdrawMinMinutes: number;
  maxPeople: number | null;
  retentionDays: number;
}

/** A resource as the editor reads it, with its whole availability. */
export interface ManagedResource {
  id: string;
  name: string;
  description: string | null;
  privateInfo: string | null;
  linkedUserId: string | null;
  position: number;
  lines: StoredLine[];
  exceptions: Closure[];
}

/** `GET bookings/spaces/:id/manage`. */
export interface ManagedSpace extends SpaceSettings {
  id: string;
  ownerId: string;
  associationId: string | null;
  resources: ManagedResource[];
}

/** One row of `GET bookings/managed`. */
export interface ManagedSpaceRow {
  id: string;
  name: string;
  slotMode: SlotMode;
  discoverability: Discoverability;
  resourceCount: number;
}

/** A resource's own fields (D10, D32); `linkedUserId: null` unlinks. */
export interface ResourceFields {
  name?: string;
  description?: string | null;
  privateInfo?: string | null;
  linkedUserId?: string | null;
  position?: number;
}

/**
 * A refused bookings call. `bookingIds` is set on `bookings-inside-change` and
 * `bookings-inside-block` (D29): the coming bookings the change would strand, which the organiser
 * cancels before retrying. Empty otherwise.
 */
export class BookingsApiError extends SocialApiError {
  constructor(
    message: string,
    code: string | null,
    status: number,
    readonly bookingIds: string[]
  ) {
    super(message, code, status);
    this.name = 'BookingsApiError';
  }
}

/** Reads a refusal's body into a {@link BookingsApiError}; a body that is not JSON carries no code. */
async function refusal(res: Response, what: string): Promise<BookingsApiError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code : null;
  const ids = Array.isArray(body.bookingIds)
    ? body.bookingIds.filter((x): x is string => typeof x === 'string')
    : [];
  Log.i('BOOKINGS', `${what} refused status=${res.status} code=${code ?? 'none'}`);
  return new BookingsApiError(`${what} refused (${res.status})`, code, res.status, ids);
}

async function call<T>(what: string, path: string, init?: ApiFetchOptions): Promise<T> {
  Log.d('BOOKINGS', what);
  const res = await apiFetch(`${socialUrl()}/api/bookings${path}`, init);
  if (!res.ok) throw await refusal(res, what);
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): ApiFetchOptions => ({
  method,
  body: JSON.stringify(body),
});

/** The spaces of an entity, or the caller's personal ones when `associationId` is null. */
export function listManagedSpaces(associationId: string | null): Promise<ManagedSpaceRow[]> {
  const query = associationId ? `?associationId=${encodeURIComponent(associationId)}` : '';
  return call('listManagedSpaces', `/managed${query}`);
}

/** A new space with a name; every other setting starts at the server's default. */
export function createSpace(name: string, associationId: string | null): Promise<{ id: string }> {
  return call(
    'createSpace',
    '/spaces',
    json('POST', associationId ? { name, associationId } : { name })
  );
}

export function getManagedSpace(spaceId: string): Promise<ManagedSpace> {
  return call('getManagedSpace', `/spaces/${encodeURIComponent(spaceId)}/manage`);
}

/** Any subset of the settings; the server checks D29 when the shape of what is bookable changes. */
export function updateSpace(spaceId: string, patch: Partial<SpaceSettings>): Promise<unknown> {
  return call('updateSpace', `/spaces/${encodeURIComponent(spaceId)}`, json('PATCH', patch));
}

/** Deletes the space and EVERYTHING under it, history included (D27). */
export function deleteSpace(spaceId: string): Promise<unknown> {
  return call('deleteSpace', `/spaces/${encodeURIComponent(spaceId)}`, { method: 'DELETE' });
}

export function addResource(
  spaceId: string,
  fields: ResourceFields & { name: string }
): Promise<{ id: string }> {
  return call(
    'addResource',
    `/spaces/${encodeURIComponent(spaceId)}/resources`,
    json('POST', fields)
  );
}

export function updateResource(resourceId: string, fields: ResourceFields): Promise<unknown> {
  return call(
    'updateResource',
    `/resources/${encodeURIComponent(resourceId)}`,
    json('PATCH', fields)
  );
}

/** Refused while the resource has coming bookings (`bookings-inside-change`). */
export function deleteResource(resourceId: string): Promise<unknown> {
  return call('deleteResource', `/resources/${encodeURIComponent(resourceId)}`, {
    method: 'DELETE',
  });
}

/** Replaces the resource's WHOLE availability (D11); refused over coming bookings (D29). */
export function setAvailability(
  resourceId: string,
  lines: StoredLine[],
  exceptions: Closure[]
): Promise<unknown> {
  return call(
    'setAvailability',
    `/resources/${encodeURIComponent(resourceId)}/availability`,
    json('PUT', { lines, exceptions })
  );
}
