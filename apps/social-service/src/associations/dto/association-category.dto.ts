import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

/** Payload for creating a managed association category. */
export class CreateAssociationCategoryDto {
  @IsString()
  @MaxLength(100)
  label: string;

  /** URL-safe unique identifier (lowercase letters, digits and hyphens). */
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9-]+$/)
  slug: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

/** Partial update of a category (the slug is immutable once created). */
export class UpdateAssociationCategoryDto {
  @IsString()
  @MaxLength(100)
  @IsOptional()
  label?: string;

  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;
}

/** Reorders categories: `orderedIds` in the desired top-to-bottom order. */
export class ReorderCategoriesDto {
  @IsArray()
  @IsUUID('4', { each: true })
  orderedIds: string[];
}
