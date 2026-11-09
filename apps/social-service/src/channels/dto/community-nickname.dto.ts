import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Body of `PUT channels/workspaces/:workspaceId/nicknames/:userId`. `null`, absent or a value empty
 * once normalized clears the nickname. The bound here only caps what is read; the real limit (100
 * code points once normalized) is the service's, answered as the typed `nickname_too_long`.
 */
export class SetCommunityNicknameDto {
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsString()
  @MaxLength(1000)
  nickname?: string | null;
}
