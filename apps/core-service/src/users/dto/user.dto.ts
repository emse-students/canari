import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsOptional()
  stripeCustomerId?: string;
}

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  stripeCustomerId?: string;
}
