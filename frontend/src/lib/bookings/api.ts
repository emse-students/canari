/**
 * THE BOOKINGS API, typed: the organiser's side (WP-B4) and the booker's (WP-B5).
 *
 * Routes and refusal codes are `apps/social-service/src/bookings/booking-spaces.controller.ts` and
 * `bookings.controller.ts`, described in docs/wiki/bookings-chantier.md, "WP-B3/B4/B5 as built". Every refusal is classified at the
 * throw as a {@link BookingsApiError}: its status, its stable `code`, and - for D29's refusals - the
 * bookings that stand in the way. A screen words it with `describeBookingRefusal`, never from the
 * server's message.
 */
import { apiFetch, type ApiFetchOptions } from '$lib/utils/apiFetch';
import { getToken } from '$lib/stores/auth';
import { fetchUpload } from '$lib/media';
import type { UploadedAnswerFile } from '$lib/forms/api';
import type { XhrUploadOptions } from '$lib/utils/uploadXhr';
import { m } from '$lib/paraglide/messages';
import { socialUrl } from '$lib/utils/apiUrl';
import { amountBoundsOf, SocialApiError, type AmountBounds } from '$lib/associations/api';
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
  /** The poster (D35): not a setting of the save bar - the editor saves it the moment it is picked. */
  poster: SpacePoster | null;
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
    readonly bookingIds: string[],
    amountBounds: AmountBounds | null = null
  ) {
    super(message, code, status, amountBounds);
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
  return new BookingsApiError(
    `${what} refused (${res.status})`,
    code,
    res.status,
    ids,
    amountBoundsOf(body)
  );
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

/**
 * A new space with its ONE default column (D44), named after it; every other setting starts at the
 * server's default. The server writes both in one transaction, with the column's first hours when
 * `availability` is given (the creation wizard, D52), so no half-made space is ever left behind.
 */
export function createSpace(
  name: string,
  associationId: string | null,
  availability?: { lines: StoredLine[]; exceptions: Closure[] }
): Promise<{ id: string; resourceId: string }> {
  return call(
    'createSpace',
    '/spaces',
    json('POST', {
      name,
      ...(associationId ? { associationId } : {}),
      ...(availability ? { availability } : {}),
    })
  );
}

export function getManagedSpace(spaceId: string): Promise<ManagedSpace> {
  return call('getManagedSpace', `/spaces/${encodeURIComponent(spaceId)}/manage`);
}

/** Any subset of the settings; the server checks D29 when the shape of what is bookable changes. */
export function updateSpace(spaceId: string, patch: Partial<SpaceSettings>): Promise<unknown> {
  return call('updateSpace', `/spaces/${encodeURIComponent(spaceId)}`, json('PATCH', patch));
}

/**
 * A space's poster (D35): an image ENCRYPTED BY THE CLIENT, as a post's (`MediaService.encryptAndUpload`)
 * - the server stores this reference and the media service holds ciphertext only. The fields are the
 * server's `PosterDto`, no more: a `MediaRef`'s others are refused.
 */
export interface SpacePoster {
  type: 'image';
  mediaId: string;
  key: string;
  iv: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
}

/** The image types the server accepts for a poster (`POSTER_MIME_TYPES`). */
export const POSTER_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Sets (or with `null` removes) the space's poster on its own. The server classifies the new one
 * for keeping and releases the one it replaces (`booking-poster-media.ts`).
 */
export function setSpacePoster(spaceId: string, poster: SpacePoster | null): Promise<unknown> {
  return call(
    'setSpacePoster',
    `/spaces/${encodeURIComponent(spaceId)}`,
    json('PATCH', { poster })
  );
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

/** Refused while the resource has ANY booking, past or cancelled included (D42, `resource-has-bookings`). */
export function deleteResource(resourceId: string): Promise<unknown> {
  return call('deleteResource', `/resources/${encodeURIComponent(resourceId)}`, {
    method: 'DELETE',
  });
}

/** One booking as its viewer may read it (D9): names only when allowed, answers to the organiser. */
export interface BookingView {
  id: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  cancelled: boolean;
  /** The viewer is the holder or a participant still in. */
  mine: boolean;
  holderName?: string;
  participantNames?: string[];
  answers?: Record<string, unknown> | null;
  /** With `answers`: the name each FILE answer's file was uploaded under, by file id (WP-B6). */
  fileNames?: Record<string, string>;
  /** With `answers`: the FILE answers whose file is gone (purged, or erased with its uploader). */
  deletedFileIds?: string[];
}

/**
 * The bookings a D29 refusal named, as the organiser reads them (`GET spaces/:id/bookings?ids=`),
 * by start. At most one page (200) is asked; an id of another space is not answered.
 */
export async function namedSpaceBookings(spaceId: string, ids: string[]): Promise<BookingView[]> {
  const query = `?ids=${ids.map(encodeURIComponent).join(',')}`;
  const page = await call<{ items: BookingView[] }>(
    'namedSpaceBookings',
    `/spaces/${encodeURIComponent(spaceId)}/bookings${query}`
  );
  return page.items;
}

/** One row of the organiser's list: the view, and how it was made (WP-B3). */
export interface OrganiserBooking extends BookingView {
  /** The organiser booked it for its holder (D20). */
  bookedOnBehalf: boolean;
  cancelledByHolder: boolean;
}

/** One page of the organiser's list; `nextOffset` is null on the last page. */
export interface OrganiserBookingsPage {
  items: OrganiserBooking[];
  nextOffset: number | null;
}

/**
 * The dashboard's "coming" list (WP-R5, D50): the space's LIVE bookings that end after `fromMs` -
 * the one under way included - by start, `limit` at a time from `offset`.
 */
export function upcomingSpaceBookings(
  spaceId: string,
  fromMs: number,
  offset = 0,
  limit = 50
): Promise<OrganiserBookingsPage> {
  const query = `?from=${encodeURIComponent(new Date(fromMs).toISOString())}&offset=${offset}&limit=${limit}`;
  return call<OrganiserBookingsPage>(
    'upcomingSpaceBookings',
    `/spaces/${encodeURIComponent(spaceId)}/bookings${query}`
  );
}

/** The holder or the organiser cancels a coming booking (D5); nobody is notified in v1 (D13). */
export function cancelBooking(bookingId: string): Promise<unknown> {
  return call('cancelBooking', `/${encodeURIComponent(bookingId)}/cancel`, { method: 'POST' });
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

// -- The booker's side (WP-B5) ---------------------------------------------------------------------

/** One row of `GET bookings/spaces`: a listed space the reader may book (D16, D31). */
export interface ListedSpace {
  id: string;
  name: string;
  description: string | null;
  associationId: string | null;
  associationName: string | null;
  timeZone: string;
  resourceCount: number;
  poster: SpacePoster | null;
}

/** A resource as a booker reads it: no private text (D32). */
export interface BookerResource {
  id: string;
  name: string;
  description: string | null;
  /** The reader is the account linked to it (D10): they may mark it unavailable. */
  linkedToMe: boolean;
}

/** `GET bookings/spaces/:id`: a space as a booker reads it. */
export interface BookerSpace {
  id: string;
  name: string;
  description: string | null;
  associationId: string | null;
  timeZone: string;
  slotMode: SlotMode;
  stepMinutes: number | null;
  maxSteps: number | null;
  nameVisibility: NameVisibility;
  items: FormItem[];
  /** The questions the reader's PROFILE hides; the answer half of a condition is the screen's. */
  hiddenItemIds: string[];
  opensAt: string | null;
  minNoticeMinutes: number | null;
  horizonDays: number | null;
  participantWithdrawMinMinutes: number;
  maxPeople: number | null;
  /** Days a FILE answer's file is kept after the END of its slot (D8, D41), said under the picker. */
  retentionDays: number;
  poster: SpacePoster | null;
  /** The reader manages the space: they book on behalf, block, cancel any coming booking. */
  canManage: boolean;
  resources: BookerResource[];
}

interface UnitRange {
  /** The local date (space zone) of the window the unit belongs to. */
  date: string;
  startMs: number;
  endMs: number;
}

/** One bookable unit of a resource and what it is now (D14). */
export type SlotUnit = UnitRange &
  (
    | { state: 'free' }
    | { state: 'booked'; booking: BookingView }
    | {
        state: 'blocked';
        /** The reason, when the organiser made it visible (or to the organiser). */
        blockReason?: string | null;
        /** Sent only to whoever may lift the block. */
        blockId?: string;
      }
  );

/** A resource's units over the dates asked. */
export interface ResourceSlots {
  resourceId: string;
  units: SlotUnit[];
}

/** One row of `GET bookings/mine`. */
export interface MyBooking extends BookingView {
  /** A participant who left it; still listed, marked. */
  withdrawn: boolean;
  holder: boolean;
  /** A booking of a resource linked to the reader (D10). */
  linked: boolean;
  space: { id: string; name: string; timeZone: string };
  resource: { id: string; name: string };
  /** The "after booking" texts (D32): only for a live booking the reader is one of the people of. */
  privateInfo: { spacePrivateInfo: string | null; resourcePrivateInfo: string | null } | null;
}

/** What a booking request carries (D4, D7, D20); instants are ISO with their zone. */
export interface BookingRequest {
  resourceId: string;
  startsAt: string;
  endsAt: string;
  participantIds?: string[];
  answers?: Record<string, unknown>;
  /** Booking ON BEHALF of this account: the organiser only. */
  holderId?: string;
}

/** "Indisponible" over a range of a resource (D10, D20). */
export interface BlockRequest {
  startsAt: string;
  endsAt: string;
  reason?: string;
  reasonVisible?: boolean;
}

/** The listed spaces the reader may book, by name. */
export function listSpaces(): Promise<ListedSpace[]> {
  return call('listSpaces', '/spaces');
}

export function getSpace(spaceId: string): Promise<BookerSpace> {
  return call('getSpace', `/spaces/${encodeURIComponent(spaceId)}`);
}

/** The units over local dates `from`..`to` (`YYYY-MM-DD`, both included, at most 62 days). */
export function getSlots(spaceId: string, from: string, to: string): Promise<ResourceSlots[]> {
  const query = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  return call('getSlots', `/spaces/${encodeURIComponent(spaceId)}/slots${query}`);
}

export function book(spaceId: string, request: BookingRequest): Promise<{ id: string }> {
  return call('book', `/spaces/${encodeURIComponent(spaceId)}/bookings`, json('POST', request));
}

/** A participant leaves a coming booking, until the space's delay (D5). */
export function withdrawBooking(bookingId: string): Promise<unknown> {
  return call('withdrawBooking', `/${encodeURIComponent(bookingId)}/withdraw`, {
    method: 'POST',
  });
}

/** The reader's bookings, newest first: as holder, as participant, and of a linked resource. */
export function myBookings(): Promise<MyBooking[]> {
  return call('myBookings', '/mine');
}

export function addBlock(resourceId: string, request: BlockRequest): Promise<{ id: string }> {
  return call(
    'addBlock',
    `/resources/${encodeURIComponent(resourceId)}/blocks`,
    json('POST', request)
  );
}

/** Lifts a block that has not ended. */
export function removeBlock(blockId: string): Promise<unknown> {
  return call('removeBlock', `/blocks/${encodeURIComponent(blockId)}`, { method: 'DELETE' });
}

/**
 * The signed `.ics` path of one booking (D13), `/api/bookings/<id>/calendar.ics?u=<reader>&sig=...`, signed for the reader, on the
 * social service's origin. A calendar app fetches it with no identity.
 */
export function calendarLink(bookingId: string): Promise<{ path: string }> {
  return call('calendarLink', `/${encodeURIComponent(bookingId)}/calendar-link`);
}

// -- File answers and the export (WP-B6) -----------------------------------------------------------

/**
 * Uploads the file of one FILE question before the booking is sent - the forms' upload
 * (`uploadFormAnswerFile`), on the space. The booking then carries `fileId`; the server accepts it
 * only from the account that uploaded it, for this question, within a day.
 */
export async function uploadBookingAnswerFile(
  spaceId: string,
  itemId: string,
  file: File,
  transport: XhrUploadOptions = {}
): Promise<UploadedAnswerFile> {
  Log.d('BOOKINGS', `uploadBookingAnswerFile item=${itemId} ${file.size} B`);
  const fd = new FormData();
  fd.append('itemId', itemId);
  fd.append('file', file);
  const res = await fetchUpload(
    `${socialUrl()}/api/bookings/spaces/${encodeURIComponent(spaceId)}/files`,
    (token) => ({ method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd }),
    await getToken(),
    transport
  );
  if (!res.ok) throw await refusal(res, 'uploadBookingAnswerFile');
  return res.json();
}

/** The organiser's download of one booking's answer file - the only way it is ever read (D22). */
export async function downloadBookingAnswerFile(bookingId: string, fileId: string): Promise<Blob> {
  Log.d('BOOKINGS', `downloadBookingAnswerFile booking=${bookingId.slice(0, 8)}`);
  const res = await apiFetch(
    `${socialUrl()}/api/bookings/${encodeURIComponent(bookingId)}/files/${encodeURIComponent(fileId)}`
  );
  if (!res.ok) throw await refusal(res, 'downloadBookingAnswerFile');
  return res.blob();
}

/**
 * The words of an export's columns, in this client's language: the server has no catalogue and
 * refuses a request without them (`export-labels`) - the forms' `ExportLabels` reasoning. Mirrored
 * by `apps/social-service/src/bookings/booking-export.ts`.
 */
export interface BookingExportLabels {
  date: string;
  start: string;
  end: string;
  resource: string;
  holder: string;
  participants: string;
  status: string;
  cancelled: string;
  file: string;
  fileDeleted: string;
}

/** The labels this client writes an export in, resolved through Paraglide. */
export function bookingExportLabels(): BookingExportLabels {
  return {
    date: m.bookings_export_col_date(),
    start: m.bookings_export_col_start(),
    end: m.bookings_export_col_end(),
    resource: m.bookings_export_col_resource(),
    holder: m.bookings_export_col_holder(),
    participants: m.bookings_export_col_participants(),
    status: m.bookings_export_col_status(),
    cancelled: m.bookings_export_cancelled(),
    file: m.form_answer_file(),
    fileDeleted: m.form_answer_file_deleted(),
  };
}

/**
 * The space's bookings as an `.xlsx` (D24). The caller names the file from the space it shows: a
 * cross-origin answer's `Content-Disposition` is not readable here without an exposed header.
 */
export async function exportBookings(spaceId: string, labels: BookingExportLabels): Promise<Blob> {
  Log.d('BOOKINGS', `exportBookings space=${spaceId.slice(0, 8)}`);
  const query = encodeURIComponent(JSON.stringify(labels));
  const res = await apiFetch(
    `${socialUrl()}/api/bookings/spaces/${encodeURIComponent(spaceId)}/export?labels=${query}`
  );
  if (!res.ok) throw await refusal(res, 'exportBookings');
  return res.blob();
}
