import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `PUT /api/users/admin/platform/announcement`.
 *
 * Both languages are REQUIRED. Making one optional would mean the server picks a fallback for a
 * reader whose language it does not know, which is the one thing this design refuses to do.
 */
export class PublishAnnouncementDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  titleFr!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  titleEn!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  bodyFr!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  bodyEn!: string;

  /** Inclusive lower bound, or absent/empty for none. */
  @IsOptional()
  @IsString()
  @Matches(/^(\d+\.\d+\.\d+)?$/, {
    message: 'minClientVersion must be a semver major.minor.patch string, or empty',
  })
  minClientVersion?: string | null;

  /** Inclusive upper bound, or absent/empty for none. */
  @IsOptional()
  @IsString()
  @Matches(/^(\d+\.\d+\.\d+)?$/, {
    message: 'maxClientVersion must be a semver major.minor.patch string, or empty',
  })
  maxClientVersion?: string | null;
}
