import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { AssociationPermission } from '../entities/association-member.entity';

export class CreateAssociationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase alphanumeric with hyphens',
  })
  slug: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16000)
  bioMarkdown?: string;

  @IsString()
  @IsOptional()
  logoUrl?: string;
}

export class UpdateAssociationDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @IsString()
  @IsOptional()
  @MaxLength(16000)
  bioMarkdown?: string;

  @IsString()
  @IsOptional()
  logoUrl?: string;
}

export class AddMemberDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  role: string;

  @IsEnum(AssociationPermission)
  permission: AssociationPermission;
}

export class UpdateMemberRoleDto {
  @IsString()
  @IsOptional()
  role?: string;

  @IsEnum(AssociationPermission)
  @IsOptional()
  permission?: AssociationPermission;
}

export class AddMembersBatchDto {
  @IsArray()
  @IsString({ each: true })
  userIds: string[];
}

export class CreateAssociationCalendarEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(4000)
  description?: string;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  @IsOptional()
  endsAt?: string;

  /** Optional association post on the feed (same `associationId` as this event). */
  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedPostId?: string;

  /** Optional form (same association). */
  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedFormId?: string;
}

export class UpdateAssociationCalendarEventDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;

  @IsString()
  @IsOptional()
  @MaxLength(4000)
  description?: string;

  @IsDateString()
  @IsOptional()
  startsAt?: string;

  @IsDateString()
  @IsOptional()
  endsAt?: string;

  /** Set to empty string or null to remove the link. */
  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedPostId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedFormId?: string | null;
}
