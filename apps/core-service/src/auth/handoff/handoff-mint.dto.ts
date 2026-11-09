import { IsOptional, IsString, MaxLength } from 'class-validator';

/** The body of `POST /api/auth/handoff`: a site id and a path, both checked against the registry. */
export class HandoffMintDto {
  /** The target site's id in `libs/contracts/ecosystem-sites.json`. */
  @IsString()
  @MaxLength(64)
  aud!: string;

  /** A path of that site's allowlist; `/` when absent. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  dest?: string;
}
