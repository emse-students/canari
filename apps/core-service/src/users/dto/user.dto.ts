import {
  IsEmail,
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

  @IsEmail()
  email: string;

  @IsString()
  @IsOptional()
  displayName?: string;

  @IsInt()
  @Min(2000)
  @IsOptional()
  firstYearOfSchool?: number;

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
  avatarMediaId?: string;

  @IsString()
  @IsOptional()
  stripeCustomerId?: string;
}

export class PublicUserDto {
  id: string;
  email: string | null;
  displayName: string | null;
  firstYearOfSchool: number | null;
  avatarMediaId: string | null;
  bio: string | null;
  createdAt: Date;
}
