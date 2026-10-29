import { Injectable } from '@nestjs/common';
import { PlatformService } from '../platform/platform.service';
import { deployedVersion } from '../platform/deployed-version';
import { deployBuild } from '../platform/deploy-build';
import type { CallsMode, LivesMode } from '../platform/entities/platform-config.entity';

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
      oidcPkce: true,
      presencePost: true,
    };
  }
}
