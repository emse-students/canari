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
import { ALL_PERMISSION_FLAGS } from '../entities/association-member.entity';

/**
 * The optional first admin of a new entity: an account and its rights. NO ROLE: the role is a title
 * a person writes on the members tab, and a label typed by this code would be a locale string stored
 * as data - the row takes the column's default, as any member added with no title.
 */
export class FirstAdminDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  userId!: string;

  @IsInt()
  @Min(0)
  @Max(ALL_PERMISSION_FLAGS)
  permissions!: number;
}

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

  /** Optional; absent means NO member at all (owner: "personne au depart"). */
  @IsOptional()
  @ValidateNested()
  @Type(() => FirstAdminDto)
  firstAdmin?: FirstAdminDto;
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
