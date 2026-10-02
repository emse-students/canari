import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** A global admin bans a user from the ranked minesweeper. */
export class BanMinesweeperUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  userId!: string;

  /** Why - shown to the other admins in the ban list. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
