import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The body of an acceptance (optional, and empty for an association's). For a PERSON's acceptance
 * of an institution's request (D38b), the fingerprint of the audience they were shown
 * (`details.institutionAudience.fingerprint` in their inbox); the server refuses a stale one with
 * `REPOST_PERSONAL_AUDIENCE_CHANGED` (review of #2965, 2026-11-02).
 */
export class AcceptProposalDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  audienceFingerprint?: string;
}
