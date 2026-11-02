import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AudienceRuleDto } from '../../spaces/dto/space.dto';
import { AddMemberDto } from './association.dto';

/** The three kinds the `associations.type` column stores. */
export const ASSOCIATION_KINDS = ['association', 'list', 'institution'] as const;
export type AssociationKind = (typeof ASSOCIATION_KINDS)[number];

/**
 * The platform administrator's create form on `/admin/spaces` (owner, 2026-11-02): a name, a kind,
 * the spaces it reaches and, optionally, a first admin - nothing else. Logo, description and
 * cotisations stay on the management page. The slug is derived by the server, exactly as on
 * `POST /associations`.
 */
export class AdminCreateAssociationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsIn(ASSOCIATION_KINDS)
  type!: AssociationKind;

  /**
   * The spaces it reaches, as audience rules - the shape `PUT associations/:id/audiences` takes.
   * EXPLICIT, so never the creator's campus: an empty list reaches nobody, like an institution's
   * default.
   */
  @IsArray()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => AudienceRuleDto)
  audiences!: AudienceRuleDto[];

  /** Optional; absent means NO member at all (owner: "personne au départ"). */
  @IsOptional()
  @ValidateNested()
  @Type(() => AddMemberDto)
  firstAdmin?: AddMemberDto;
}

/** The largest page the admin catalogue serves. */
export const ADMIN_CATALOGUE_MAX_LIMIT = 100;

/** `GET associations/admin/catalogue`: one kind, an optional search, a keyset cursor. */
export class AdminCatalogueQueryDto {
  @IsIn(ASSOCIATION_KINDS)
  type!: AssociationKind;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** The opaque `next` of the previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(400)
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_CATALOGUE_MAX_LIMIT)
  limit?: number;
}

/** `GET associations/admin/slug-preview?name=`. */
export class AdminSlugPreviewQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}
