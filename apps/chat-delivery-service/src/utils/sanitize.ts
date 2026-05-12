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
 * Like `sanitizeQueryValue` but treats `undefined`, `null`, and `""` as absent
 * and returns `undefined` instead of throwing, leaving the field truly optional.
 */
export function sanitizeOptionalQueryValue(
  value: unknown,
  fieldName: string,
): string | undefined {
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
  message: string,
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
export function sanitizeOptionalDeviceAppVersion(
  value: unknown,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException('deviceAppVersion must be a string');
  }
  const version = value.trim();
  if (!version) return undefined;
  if (!/^[0-9A-Za-z._+-]{1,32}$/.test(version)) {
    throw new BadRequestException(
      'deviceAppVersion contains invalid characters',
    );
  }
  return version;
}

/** Validates that `value` is an array of integers in `[0, 255]` (i.e. a byte array). */
export function sanitizeByteArray(value: unknown, fieldName: string): number[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${fieldName} must be an array`);
  }
  const bytes = value.map((v) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
      throw new BadRequestException(
        `${fieldName} contains invalid byte values`,
      );
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
