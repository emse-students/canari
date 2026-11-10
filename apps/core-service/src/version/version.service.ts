import { Injectable } from '@nestjs/common';
import { PlatformService } from '../platform/platform.service';
import { deployedVersion } from '../platform/deployed-version';
import { deployBuild } from '../platform/deploy-build';
import type {
  CallsMode,
  CheckpointSkipMode,
  LivesMode,
  LiveReplaysMode,
} from '../platform/entities/platform-config.entity';

export type AppVersionResponse = {
  version: string;
  /**
   * Which BUILD is deployed, when the environment was given one - the commit, short. `null` in
   * production, whose version already names its content because it is built from a tag.
   *
   * DELIBERATELY NOT PART OF `version`: clients parse that field and turn it into a release tag and
   * a download URL, so a `+dev.<sha7>` suffix inside it would offer an update from a GitHub release
   * that does not exist. See `platform/deploy-build.ts`.
   */
  build: string | null;
  minClientVersion: string;
  maintenance: {
    enabled: boolean;
    message: string | null;
  };
  /**
   * The server's kill switch for calls (`platform_config.calls_mode`). Clients hide every call
   * entry point the server would refuse; the refusal itself is chat-delivery-service's, on every
   * call request, so a client that ignores this field is refused rather than obeyed.
   */
  calls: {
    mode: CallsMode;
  };
  /**
   * The server's kill switch for lives (`platform_config.lives_mode`). Clients hide the live card,
   * the viewer and the composer's Live chip while it is `off`; the refusal itself is
   * social-service's and media-service's, on every live request.
   */
  lives: {
    mode: LivesMode;
  };
  /**
   * The server's switch for WP-CHECKPOINT-SKIP (`platform_config.checkpoint_skip_mode`): `on` lets a
   * client leave the MLS checkpoint of a live receive-only drain to the next existing trigger, until
   * its own count of unsaved receive generations is reached. NOTHING IS ENFORCED HERE - the
   * checkpoint is the client's own durability - so a client that cannot read the field stays `off`.
   */
  checkpointSkip: {
    mode: CheckpointSkipMode;
  };
  /**
   * The server's switch for live replays (`platform_config.live_replays_mode`): `on` keeps a live
   * started now three days as a replay. ENFORCED BY SOCIAL-SERVICE at the start of a live, which
   * fixes it on the live row; a client reads it only to word the pre-live sheet, and reads an absent
   * or unknown value as `off`.
   */
  liveReplays: {
    mode: LiveReplaysMode;
  };
  /**
   * A CAPABILITY, NOT A SWITCH: this core-service forwards a PKCE `code_verifier` from
   * `POST /api/auth/oidc/callback` to MiConnect. A client sends a `code_challenge` only to a server
   * that says so, because a core-service older than this field drops the verifier, and MiConnect
   * refuses a challenged code redeemed without one - a client that challenged anyway could not sign
   * in. Always `true` from this release on; its absence is what an older server looks like.
   */
  oidcPkce: true;
  /**
   * A CAPABILITY OF THIS ESTATE'S CHAT-GATEWAY, published here because this is the one capability
   * document every client reads: `POST /api/presence` takes the asked ids in its BODY. A client
   * sends the POST only to an estate that says so, because a gateway older than the route answers
   * it `405` - and a stable ships both stores before production deploys, so for days a new phone
   * build talks to the old gateway. The gateway and this service are built from ONE release tag and
   * deployed together, which is what makes this service's word about the gateway true. Always
   * `true` from this release on; its absence is what an older estate looks like
   * (docs/wiki/legacy-compatibility.md, "the presence ids in a URL").
   */
  presencePost: true;
  /**
   * A CAPABILITY OF THIS ESTATE'S SOCIAL- AND MEDIA-SERVICE, published here for the same reason:
   * social-service keeps a post's client id and serves `POST /api/posts/:id/withdraw` (migration
   * 135), media-service opens `single-block` sessions. The client's background publish queue sends
   * nothing to an estate that does not say so - an older one would duplicate a post whose answer was
   * lost - and the three services are built from ONE release tag and deployed together. Always
   * `true` from this release on (docs/wiki/frontend/modules/posts.md#the-background-publish-queue).
   */
  publishQueue: true;
  /**
   * A CAPABILITY OF THIS ESTATE'S SOCIAL-SERVICE, published here for the same reason: a form is
   * created as a DRAFT (`draft: true`, migration 145) and published by its own route, and its edits
   * are saved as an unpublished revision (`/forms/:id/draft`, migration 146). A client builds forms
   * that way only on an estate that says so: an older social-service strips `draft` (its validation
   * whitelists the body) and publishes an empty form at once, and answers the revision routes `404`
   * - and a store build reaches phones before production deploys. Built from ONE release tag with
   * social-service. Always `true` from this release on (docs/wiki/legacy-compatibility.md, "a form
   * editor newer than its server").
   */
  formDrafts: true;
};

/** Resolves deployed app version and platform gates from core-service. */
@Injectable()
export class VersionService {
  constructor(private readonly platformService: PlatformService) {}

  /** Returns server version metadata and platform gates (no authentication required). */
  async getVersion(): Promise<AppVersionResponse> {
    const platform = await this.platformService.getConfig();
    return {
      // REPORTING, NOT DECIDING - so an unreadable version keeps its harmless default here.
      version: deployedVersion() ?? '0.0.0',
      build: deployBuild(),
      minClientVersion: platform.minClientVersion,
      maintenance: {
        enabled: platform.maintenanceEnabled,
        message: platform.maintenanceMessage,
      },
      calls: { mode: platform.callsMode },
      lives: { mode: platform.livesMode },
      checkpointSkip: { mode: platform.checkpointSkipMode },
      liveReplays: { mode: platform.liveReplaysMode },
      oidcPkce: true,
      presencePost: true,
      publishQueue: true,
      formDrafts: true,
    };
  }
}
