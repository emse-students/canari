import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsOptional()
  displayName?: string;

  @IsInt()
  @Min(1816)
  @IsOptional()
  promo?: number;

  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;

  @IsString()
  @IsOptional()
  formation?: string;

  @IsString()
  @IsOptional()
  stripeCustomerId?: string;
}

export class UpdateUserDto {
  @IsString()
  @MaxLength(500)
  @IsOptional()
  bio?: string;

  @IsString()
  @IsOptional()
  stripeCustomerId?: string;
}

export class PublicUserDto {
  id: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
  promo: number | null;
  formation: string | null;
  bio: string | null;
  createdAt: Date;
}
