import { isIPv4, isIPv6 } from 'node:net';
import { Logger } from '@nestjs/common';

const logger = new Logger('ClientAddress');

/**
 * The VISITOR behind a request - the one person-naming address this service sees, as the network
 * one visitor holds: an IPv4 address, or the /64 prefix of an IPv6 one.
 *
 * `req.ip` is the nginx container for every request (this service is only reached through it), so
 * it names a hop, not a person. nginx resolves the client itself (`real_ip` from the host proxy,
 * 2026-09-30) and forwards it as `X-Real-IP`, overwriting whatever a caller sent; the service port
 * is not published, so no caller reaches it any other way. A request with no header did not come
 * through nginx - a test, or a local call - and is keyed on the socket, said out loud, because in
 * production it would mean every visitor shares one address.
 *
 * Shared by the per-visitor throttle (`ClientIpThrottlerGuard`) and the per-visitor ceiling of a
 * public form's unpaid answers (`guest-visitor.ts`), so the two can never disagree on who a
 * visitor is.
 */
export function clientAddress(req: {
  headers?: Record<string, unknown>;
  ip?: string;
  method?: string;
  url?: string;
}): string {
  const forwarded = req.headers?.['x-real-ip'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return visitorNetwork(forwarded);
  logger.warn(`[ADDRESS] no X-Real-IP on ${req.method} ${req.url}, keyed on the socket`);
  return visitorNetwork(req.ip ?? '');
}

/**
 * The network one visitor holds, for an address. An IPv6 host is routinely given a whole /64 and
 * picks its address inside it at will (privacy extensions rotate it), so keyed on the full address
 * one visitor is 2^64 visitors to a throttle or a ceiling. So an IPv6 address counts as its /64,
 * written `xxxx:xxxx:xxxx:xxxx::/64` in full lowercase hex, whatever its spelling; an IPv4-mapped
 * one (`::ffff:a.b.c.d`) is the IPv4 address it carries. Anything else is returned unchanged.
 */
export function visitorNetwork(address: string): string {
  const bare = address.split('%')[0];
  if (!isIPv6(bare)) return address;
  const groups = ipv6Groups(bare);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    if (isIPv4(v4)) return v4;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16).padStart(4, '0'))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address, `::` and an embedded IPv4 tail expanded. */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const lastGroup = text.slice(lastColon + 1);
  if (lastGroup.includes('.')) {
    const [a, b, c, d] = lastGroup.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const all =
    tail === null ? headGroups : [...headGroups, ...Array(missing).fill('0'), ...tailGroups];
  return all.map((g) => parseInt(g, 16));
}
