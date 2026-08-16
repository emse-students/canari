import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AvatarCache, isCacheableAbsence } from './avatar.cache';

/**
 * What the proxy managed to establish about one avatar. THREE OUTCOMES, NOT AN EXCEPTION PER CAUSE:
 * the caller's response differs between them, and it cannot recompute the answer from a thrown
 * error without reading its message - which is the shape this repository forbids.
 *
 * `absent` is an ANSWER about the avatar: the upstream says this user has none. It may be cached,
 * and it is what the great majority of accounts return.
 * `unavailable` is NOT an answer about the avatar - a rejected key, an upstream 5xx, a timeout, or
 * no key configured at all. It is never cached, at any layer, so recovery is immediate.
 */
export type AvatarOutcome =
  | { readonly kind: 'image'; readonly body: Buffer; readonly contentType: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable' };

/**
 * How long to wait before deciding MiGallery is not answering. An avatar is not worth more, and the
 * number is the one Le Cercle already justified for the same endpoint - the four proxies of this
 * endpoint state the same budget rather than each inventing one.
 *
 * It replaces axios's 5 000 ms, which measured the same thing under a different number for no
 * reason anybody could state.
 */
const UPSTREAM_TIMEOUT_MS = 4000;

/** A fetched image is stable; the gallery is not asked again for an hour. */
const IMAGE_TTL_MS = 60 * 60 * 1000;

/** An absence is shorter-lived: a user may upload a photo, and should see it appear. */
const ABSENT_TTL_MS = 10 * 60 * 1000;

/**
 * Ceiling on cached entries. A school-sized directory fits well inside it, and the point is that a
 * long-lived process cannot grow without bound on a key space that is not ours to bound.
 */
const MAX_CACHED_AVATARS = 500;

@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);
  private readonly avatarApiUrl: string;
  private readonly avatarApiKey: string;
  private readonly cache = new AvatarCache({
    imageTtlMs: IMAGE_TTL_MS,
    absentTtlMs: ABSENT_TTL_MS,
    maxEntries: MAX_CACHED_AVATARS,
  });

  constructor(private readonly configService: ConfigService) {
    this.avatarApiUrl = this.configService.get<string>(
      'MIGALLERY_API_URL',
      'https://gallery.mitv.fr'
    );
    this.avatarApiKey = this.configService.get<string>('MIGALLERY_API_KEY', '');

    if (!this.avatarApiKey) {
      this.logger.warn('MIGALLERY_API_KEY is not set - every avatar will answer unavailable.');
    }
  }

  /**
   * Fetch one user's avatar from MiGallery.
   *
   * NEVER THROWS FOR AN UPSTREAM CONDITION. An avatar is an optional decoration: whatever happens
   * upstream, the client draws initials, so the only question this method answers is which of the
   * three outcomes it was - and the log line is what tells the causes of `unavailable` apart.
   * The one exception is a malformed identifier, which is a fault in the REQUEST and stays a 400.
   *
   * The benign absence is deliberately NOT logged: a 404 forwarded as a 404 hides nothing, and it is
   * the common case rather than the edge one. What is logged is every cause that is ours.
   */
  async fetchUserAvatar(userId: string): Promise<AvatarOutcome> {
    // Prevent SSRF / path traversal: userId must be a safe alphanumeric identifier.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) {
      throw new HttpException('Invalid user ID', HttpStatus.BAD_REQUEST);
    }

    if (!this.avatarApiKey) return { kind: 'unavailable' };

    const cached = this.cache.get(userId);
    if (cached) return cached;

    try {
      const url = `${this.avatarApiUrl}/api/users/${userId}/avatar`;

      const response = await axios.get<ArrayBuffer>(url, {
        headers: { 'x-api-key': this.avatarApiKey },
        responseType: 'arraybuffer',
        timeout: UPSTREAM_TIMEOUT_MS,
        // Disable redirects: following them to unknown destinations is a SSRF vector.
        maxRedirects: 0,
      });

      const outcome = {
        kind: 'image',
        body: Buffer.from(response.data),
        // Pass the upstream's type through rather than asserting JPEG. The proxy does not know what
        // the gallery stores, and hardcoding it mislabels every PNG or WebP it serves.
        contentType: String(response.headers['content-type'] ?? 'image/jpeg'),
      } as const;
      this.cache.set(userId, outcome);
      return outcome;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;

      if (status !== undefined && isCacheableAbsence(status)) {
        const outcome = { kind: 'absent' } as const;
        this.cache.set(userId, outcome);
        return outcome;
      }

      // OUR KEY IS BEING REFUSED - the one cause here that a human must act on, and the one that
      // would otherwise blank every face on the site silently. It must never share a level with a
      // transient blip. It also never reaches the browser as a 401: this service's credentials are
      // not the user's, and a 401 crossing that boundary is exactly how an unrelated upstream fault
      // becomes a logout.
      if (status === 401 || status === 403) {
        this.logger.error(
          `MiGallery refused our API key (HTTP ${status}) at ${this.avatarApiUrl} - avatars are disabled until it is fixed`
        );
        return { kind: 'unavailable' };
      }

      // LOG WHAT IDENTIFIES THE FAILURE, NOT THE WHOLE OBJECT. Handing an axios error to the Nest
      // logger prints `util.inspect` of the underlying TLS socket - roughly 500 lines per
      // occurrence, `Symbol(kCapture)` and all. Eleven timeouts in one five-minute window produced
      // 5 581 log lines on 2026-08-15 and made the service's entire window unreadable, which costs
      // far more than the incident itself: a real line anywhere in that span would not have been
      // found. The cause is `code` and the destination, and both fit on one line.
      //
      // WARN, NOT ERROR: nothing failed for the user, who sees initials either way. It stays loud
      // enough to accuse - a fallback is a signal - and the rate is what says whether it matters,
      // which is why the line is partitionable by subject and destination.
      const detail =
        axios.isAxiosError(error) ?
          `${error.code ?? `HTTP ${status ?? 'no status'}`} ${error.message}`
        : error instanceof Error ? error.message
        : String(error);
      this.logger.warn(`Avatar unavailable for ${userId} from ${this.avatarApiUrl}: ${detail}`);
      return { kind: 'unavailable' };
    }
  }
}
