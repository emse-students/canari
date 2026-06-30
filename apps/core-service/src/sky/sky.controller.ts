import { Controller, Get, Param, UseGuards, Logger } from '@nestjs/common';
import axios from 'axios';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';

/** A parrainage relative as exposed by Sky, keyed by Authentik sub. */
interface SkyEntourageMember {
  prenom: string;
  nom: string;
  level: number | null;
  kind: string;
  sub: string | null;
}

/** Sky parrainage entourage of a user (incoming/outgoing links). */
interface SkyEntourage {
  found: boolean;
  parrains: SkyEntourageMember[];
  fillots: SkyEntourageMember[];
}

/**
 * Read-only proxy that fetches a user's parrainage entourage from the Sky app
 * (separate server) so the Canari profile page can display the close tree
 * (parrains/marraines, fillots/fillotes). Behind nginx session auth; the call to
 * Sky uses the shared SKY_API_KEY. Never throws: a Sky hiccup yields an empty
 * tree rather than breaking the profile.
 */
@Controller('users')
@UseGuards(NginxAuthGuard)
export class SkyEntourageController {
  private readonly logger = new Logger(SkyEntourageController.name);
  private readonly skyUrl = (
    process.env.SKY_API_URL || 'https://sky.mitv.fr'
  ).replace(/\/+$/, '');
  private readonly skyKey = process.env.SKY_API_KEY ?? '';

  @Get(':sub/parrainage')
  async parrainage(@Param('sub') sub: string): Promise<SkyEntourage> {
    const empty: SkyEntourage = { found: false, parrains: [], fillots: [] };
    if (!this.skyKey) {
      return empty;
    }
    try {
      const res = await axios.get<SkyEntourage>(
        `${this.skyUrl}/api/external/entourage/${encodeURIComponent(sub)}`,
        { headers: { 'x-api-key': this.skyKey }, timeout: 5000 },
      );
      return res.data;
    } catch (e) {
      this.logger.warn(
        `Sky entourage fetch failed for ${sub}: ${(e as Error).message}`,
      );
      return empty;
    }
  }
}
