import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as crypto from 'crypto';

/** Allowlist regex for generic query/path values: alphanumerics plus `_`, `.`, `:`, `@`, `-`, up to 128 chars. */
export const SAFE_QUERY_VALUE_REGEX = /^[a-zA-Z0-9_.:@-]{1,128}$/;

/**
 * Validates that `value` is a non-empty string matching the safe query allowlist.
 * Throws `BadRequestException` with a descriptive message referencing `fieldName` on failure.
 */
export function sanitizeQueryValue(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new BadRequestException(`${fieldName} is required`);
  }

  if (!SAFE_QUERY_VALUE_REGEX.test(trimmed)) {
    throw new BadRequestException(`${fieldName} contains invalid characters`);
  }

  return trimmed;
}

/**
 * The literals a Canari client holds for "this identity has not resolved yet".
 *
 * They are the CLIENT's own placeholders (`BaseMlsService`), named here so the server can refuse
 * them: a value the sender defines as "not an identity" must never become one on this side.
 */
export const UNRESOLVED_IDENTITY_VALUES: readonly string[] = ['unknown', 'pending'];

/**
 * `sanitizeQueryValue` for a value that will be STORED as an identity - a `userId` or a `deviceId`
 * on a path that can create a key package or a membership row.
 *
 * WHY AN ALLOWLIST OF SHAPE IS NOT ENOUGH. On 2026-08-27 a client reached `invitations/status`
 * before its own identity resolved and this server stored `userId = 'unknown'`,
 * `deviceId = 'pending'` as an ACTIVE member of a real conversation, one second before its two
 * real members joined. Both literals pass `SAFE_QUERY_VALUE_REGEX` perfectly, and the existing
 * addressability gate (WP-GHOST-1) passed too, because the placeholder had by then registered a
 * KeyPackage under the same pair. The only thing that separates a member from a non-identity here
 * is the value itself, so it is checked here, once, for every writing path.
 *
 * READ paths keep `sanitizeQueryValue`: asking about a placeholder is harmless and answers
 * nothing, and refusing it there would only move a 404 to a 400.
 *
 * **"FOR EVERY WRITING PATH" IS A CLAIM ABOUT DOORS, AND THE DOORS DID NOT ALL HONOUR IT.** Measured
 * 2026-09-14: of the four HTTP paths that reach `activateDeviceMembership`, group creation and the
 * status endpoint called this; the background push door sanitized SHAPE only, and the distribution
 * publisher sanitized nothing at all - it checked the two fields were truthy and handed them
 * straight to the writer. So the sentence above was true of the function and false of the system,
 * for the same reason and the second time: a value check every caller must REMEMBER is not a check.
 * It is now also made at the writer, through {@link isUnresolvedIdentity}, which is where it cannot
 * be forgotten. This function stays because a door that can refuse the REQUEST should refuse it
 * there - a 400 naming the field beats an outcome the caller has to read.
 */
export function sanitizeIdentityValue(value: unknown, fieldName: string): string {
  const sanitized = sanitizeQueryValue(value, fieldName);
  if (isUnresolvedIdentity(sanitized)) {
    throw new BadRequestException(
      `${fieldName} is the client's unresolved-identity placeholder ('${sanitized}') and cannot be stored`
    );
  }
  return sanitized;
}

/**
 * Whether `value` is one of the client's own "this identity has not resolved yet" literals.
 *
 * The predicate half of {@link sanitizeIdentityValue}, for the caller that must not throw: the one
 * writer of an `active` membership answers a refusal with an {@link ActivationOutcome}, and every
 * one of its doors already reads one.
 */
export function isUnresolvedIdentity(value: string): boolean {
  return UNRESOLVED_IDENTITY_VALUES.includes(value);
}

/**
 * Like `sanitizeQueryValue` but treats `undefined`, `null`, and `""` as absent
 * and returns `undefined` instead of throwing, leaving the field truly optional.
 */
export function sanitizeOptionalQueryValue(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return sanitizeQueryValue(value, fieldName);
}

/** Validates that `value` is a non-empty array of non-empty strings; throws `BadRequestException` otherwise. */
export function sanitizeStringIdList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('messageIds must be an array');
  }

  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new BadRequestException('messageIds contains invalid ID');
    }
    ids.push(id.trim());
  }

  return ids;
}

/**
 * When the edge proxy forwards `x-user-id`, reject mismatched path/body user ids
 * unless the caller is a global admin. If `x-user-id` is absent, behavior is
 * unchanged from older deployments (HeaderAuthGuard still requires login).
 */
export function assertCallerOwnsUserId(
  headerUserId: string | undefined,
  headerGlobalAdmin: string | undefined,
  targetUserId: string,
  message: string
): void {
  if (headerGlobalAdmin === 'true') {
    return;
  }
  const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
  if (!caller) {
    return;
  }
  if (caller !== targetUserId) {
    throw new ForbiddenException(message);
  }
}

/** Validates that `value` is a non-empty string of at most 256 characters suitable for display. */
export function sanitizeDisplayText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${fieldName} must be a string`);
  }
  const text = value.trim();
  if (!text) {
    throw new BadRequestException(`${fieldName} is required`);
  }
  if (text.length > 256) {
    throw new BadRequestException(`${fieldName} is too long`);
  }
  return text;
}

/** Returns a sanitized device display name truncated to 80 characters, or `undefined` if absent. */
export function sanitizeOptionalDeviceName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const name = sanitizeDisplayText(value, 'deviceName');
  return name.slice(0, 80);
}

/** Returns a lowercased OS identifier matching `[a-z0-9_.-]{1,32}`, or `undefined` if absent. */
export function sanitizeOptionalDeviceOs(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException('deviceOs must be a string');
  }
  const os = value.trim().toLowerCase();
  if (!os) return undefined;
  if (!/^[a-z0-9_.-]{1,32}$/.test(os)) {
    throw new BadRequestException('deviceOs contains invalid characters');
  }
  return os;
}

/** Returns a version string matching `[0-9A-Za-z._+-]{1,32}` (e.g. "1.4.2"), or `undefined` if absent. */
export function sanitizeOptionalDeviceAppVersion(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException('deviceAppVersion must be a string');
  }
  const version = value.trim();
  if (!version) return undefined;
  if (!/^[0-9A-Za-z._+-]{1,32}$/.test(version)) {
    throw new BadRequestException('deviceAppVersion contains invalid characters');
  }
  return version;
}

/**
 * Validates that `value` is a non-empty standard base64 string.
 * Rejects values longer than 128 KiB of encoded data (~96 KiB binary).
 */
export function sanitizeBase64BinaryField(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value) {
    throw new BadRequestException(`${fieldName} must be a non-empty base64 string`);
  }
  if (value.length > 131072) {
    throw new BadRequestException(`${fieldName} is too large`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new BadRequestException(`${fieldName} is not valid base64`);
  }
  return value;
}

/** Validates that `value` is an array of integers in `[0, 255]` (i.e. a byte array). */
export function sanitizeByteArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${fieldName} must be an array`);
  }
  const bytes = value.map((v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
      throw new BadRequestException(`${fieldName} contains invalid byte values`);
    }
    return v;
  });
  return bytes;
}

/** Parses `value` as a positive integer, returning `fallback` if it is not a finite positive number. */
export function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n <= 0) return fallback;
  return n;
}

/** Validates and deduplicates an array of message ID strings, each passing the safe query allowlist. */
export function sanitizeMessageIdList(messageIds: unknown): string[] {
  if (!Array.isArray(messageIds)) {
    throw new BadRequestException('messageIds must be an array of strings');
  }

  const ids = messageIds.map((id) => sanitizeQueryValue(id, 'messageId'));
  return [...new Set(ids)];
}

/** Returns the SHA-256 hex digest of `token`, used to store join tokens without exposing the raw value. */
export function hashJoinToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * THE ONE POLICY FOR A REPLAY'S `sinceEpoch`, FOR BOTH ROUTES THAT ACCEPT ONE.
 *
 * Commit replay is served twice - `GET mls/commits/:groupId` for a JWT-bearing client, and
 * `POST mls/push/commits` for the background push path, which cannot mint a JWT and authenticates
 * with its PushSecret instead. They call the SAME `getCommitsSince`, and they disagreed about what
 * the epoch means:
 *
 * - the JWT route ran `Number.parseInt`, so it REFUSED a negative with 400 - and silently accepted
 *   `5abc` as 5, and `3.9` as 3;
 * - the push route ran `Math.max(0, Math.floor(...))`, so a negative or non-numeric epoch became
 *   **zero**, and the caller was handed the whole log from the beginning without being told.
 *
 * The second is the one that bites, and it is a FALLBACK: "I could not tell you where I am" is not
 * "I am at epoch 0", and conflating them answers a question nobody asked with a reply the device
 * cannot use - a device that cannot read its own epoch has no state to apply those commits to.
 * Every caller in this repository already refuses to ask: the Android service and both iOS paths
 * check `epoch >= 0` and abort before the request, so the clamp protected nothing and only made the
 * two routes answer differently.
 *
 * **An epoch is REQUIRED**, on both. A replay from the beginning is a request a caller can make by
 * sending `0`; an absent field is a caller who did not say.
 */
export function sanitizeEpoch(value: unknown, fieldName: string): number {
  // The query string carries it as text and the JSON body as a number, so both are read here rather
  // than each route pre-converting and re-introducing the divergence one layer up.
  // `Number('')` is 0, so an empty `?sinceEpoch=` would otherwise become a replay from the
  // beginning - the exact conflation this function exists to refuse.
  const text = typeof value === 'string' ? value.trim() : null;
  const n = text === null ? value : text === '' ? NaN : Number(text);
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new BadRequestException(`${fieldName} must be a non-negative integer`);
  }
  return n;
}
