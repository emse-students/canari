import type { PostEntity } from '$lib/posts/api';
import { Log } from '$lib/utils/Log';

/**
 * WHICH OF TWO VALUES FOR THE SAME POST FIELD IS NEWER - A READ THE SERVER ANSWERED, OR A WRITE THIS
 * CARD MADE (review of #1896, 2026-10-15).
 *
 * `PostCard` keeps a local copy of its post and writes it on a tap. Its parent hands it new rows
 * (the feed's stored copy, then the server's page, then a refresh). A row says what the server held
 * when its READ WAS ISSUED, not when it landed: a feed GET sent before a heart was tapped can land
 * after the heart's own POST answered, and taking that row whole erased the heart. So both sides are
 * placed on ONE order, a counter of this tab:
 *
 * - a read takes its point when it is ISSUED (`stampServed`, in `$lib/posts/api`);
 * - a write takes its point when it is ANSWERED (`PostCardLedger.end` / `answered`), the earliest
 *   instant this device knows the server committed it.
 *
 * A row speaks for a field only when its read was issued after the field's last write answered and
 * no write on it is pending. No clock: the order is the program's own, so it cannot be wrong.
 */

const SERVED_AT = Symbol('canari.post.servedAt');
let sequence = 0;

/** The next point on this tab's single order of post reads issued and post writes answered. */
export function nextPostSequence(): number {
  return ++sequence;
}

/**
 * Marks rows read from the server with the point their request was ISSUED at.
 *
 * A symbol key, non-enumerable: `JSON.stringify`, `structuredClone` and a spread all drop it, so a
 * row sealed into the stored feed, cached or copied comes back UNSTAMPED - the oldest point, which
 * speaks for no field a write of this session touched. Svelte's `$state` proxies the very object
 * it is given, so the stamp is read back through the proxy.
 */
export function stampServed<T extends object>(rows: T | T[], issuedAt: number): void {
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    if (!row || typeof row !== 'object') continue;
    Object.defineProperty(row, SERVED_AT, {
      value: issuedAt,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
}

/** The point a row's read was issued at, `0` (older than everything) for a row nobody stamped. */
export function servedAt(row: object): number {
  const at = (row as Record<symbol, unknown>)[SERVED_AT];
  return typeof at === 'number' ? at : 0;
}

/** A field of the post a card can write, optimistically or on the answer. */
export type PostField = keyof PostEntity;

/** `into[field] = from[field]`, typed per field. */
function copyField<K extends PostField>(
  into: PostEntity,
  from: Partial<PostEntity>,
  field: K
): void {
  into[field] = from[field] as PostEntity[K];
}

/**
 * One card's record of its own writes, and the rule deciding what a new served row may replace.
 *
 * Every write of the card goes through it: an optimistic one (`begin` on the tap, `end` in the
 * `finally`) and one applied only on its answer (`answered`). The card never assigns a served value
 * except through `adopt`, `mergeRead` or `rollback`.
 */
export class PostCardLedger {
  #pending = new Map<PostField, number>();
  #answeredAt = new Map<PostField, number>();
  #held = new Set<PostField>();
  #served: PostEntity;

  constructor(row: PostEntity) {
    this.#served = row;
  }

  /** The last served row adopted - the parent's, by identity. */
  get served(): PostEntity {
    return this.#served;
  }

  /**
   * A write starts on `fields`. Returns the served row as it stands, which `rollback` compares
   * against to learn whether a newer one was adopted while this write was out.
   */
  begin(fields: PostField[]): PostEntity {
    for (const f of fields) this.#pending.set(f, (this.#pending.get(f) ?? 0) + 1);
    return this.#served;
  }

  /** The write `begin` started has answered, whichever way: its point is now. */
  end(fields: PostField[]): void {
    const at = nextPostSequence();
    for (const f of fields) {
      this.#pending.set(f, Math.max(0, (this.#pending.get(f) ?? 0) - 1));
      this.#answeredAt.set(f, at);
    }
  }

  /** A write applied only on its answer (pin, unmask, an edit) has answered now. */
  answered(fields: PostField[]): void {
    const at = nextPostSequence();
    for (const f of fields) this.#answeredAt.set(f, at);
  }

  /**
   * `field` is no longer taken from a FEED row: the card holds more of it than a feed row carries
   * (the whole comment thread, where the feed sends the first few). Only a read of the post itself
   * (`mergeRead`) replaces it from then on.
   */
  hold(field: PostField): void {
    this.#held.add(field);
  }

  /** Whether a read issued at `issuedAt` says something newer than this card about `field`. */
  #speaksFor(field: PostField, issuedAt: number): boolean {
    if ((this.#pending.get(field) ?? 0) > 0) return false;
    const answered = this.#answeredAt.get(field) ?? 0;
    return answered === 0 || issuedAt > answered;
  }

  /** Every field this card has a reason to keep from a served value. */
  #touched(): Set<PostField> {
    return new Set([...this.#pending.keys(), ...this.#answeredAt.keys(), ...this.#held]);
  }

  /**
   * What the card holds once its parent hands it `served`, a NEW row for the same post: the row
   * whole, except each field a write of this card made more recently than the row's read, or still
   * carries, or that the card holds more of.
   */
  adopt(local: PostEntity, served: PostEntity): PostEntity {
    this.#served = served;
    const issuedAt = servedAt(served);
    const next: PostEntity = { ...served };
    const kept: PostField[] = [];
    for (const field of this.#touched()) {
      if (this.#held.has(field) || !this.#speaksFor(field, issuedAt)) {
        copyField(next, local, field);
        kept.push(field);
      }
    }
    if (kept.length > 0) {
      Log.d(
        'PostCardLedger',
        `post ${served.id.slice(0, 8)}: kept ${kept.join(',')} over a row read at ${issuedAt}`
      );
    }
    return next;
  }

  /**
   * Applies a read of the post itself (`getPost`) to the card: every field it carries, except one a
   * write made after the read was issued or still carries.
   */
  mergeRead(local: PostEntity, read: Partial<PostEntity>, issuedAt: number): PostEntity {
    const next: PostEntity = { ...local };
    for (const field of Object.keys(read) as PostField[]) {
      if (this.#speaksFor(field, issuedAt)) copyField(next, read, field);
    }
    return next;
  }

  /**
   * What `field` goes back to when the write `begin` returned `token` for failed.
   *
   * The pre-tap value, UNLESS a newer served row was adopted while the write was out: `adopt` kept
   * the optimistic value over it, so it is that row's value the failure must reveal - restoring the
   * pre-tap one would put back what the server has since replaced. A held field, and a row older
   * than another answered write on the field, keep the pre-tap value.
   */
  rollback<K extends PostField>(
    local: PostEntity,
    field: K,
    previous: PostEntity[K],
    token: PostEntity
  ): PostEntity {
    const served = this.#served;
    const answered = this.#answeredAt.get(field) ?? 0;
    const servedIsNewer =
      served !== token && !this.#held.has(field) && (answered === 0 || servedAt(served) > answered);
    return { ...local, [field]: servedIsNewer ? served[field] : previous };
  }
}
