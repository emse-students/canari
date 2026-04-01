import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
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
