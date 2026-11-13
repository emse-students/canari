const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True when `value` is a single UUID - a user, a group or a post id - and not a canonical direct
 * key or some other string. A caller that would send it to a route the server parses with
 * `ParseUUIDPipe` asks here first rather than learning the shape from a `400`.
 */
export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value.trim());
}
