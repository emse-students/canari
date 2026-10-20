import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { LIVE_CHAT_MESSAGE_MAX_CHARS } from '../../lives/live.constants';

/** DTO for reporting a piece of content. */
export class CreateReportDto {
  @IsIn(['post', 'comment', 'user', 'live', 'live_chat'])
  contentType: 'post' | 'comment' | 'user' | 'live' | 'live_chat';

  @IsString()
  @IsNotEmpty()
  contentId: string;

  @IsIn(['spam', 'harassment', 'inappropriate', 'other'])
  reason: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  details?: string;

  /**
   * `live_chat` only (WP-L8b): the live the line was read on. The server reads the live from the
   * message row; a value naming another live is refused as `LIVE_NOT_FOUND`.
   */
  @IsUUID()
  @IsOptional()
  liveId?: string;

  /**
   * `live_chat` only: the line's PLAINTEXT as the reporter's client opened it. The server checks it
   * against the sealed line (`LIVE_CHAT_REPORT_MISMATCH` otherwise) and keeps it for staff.
   */
  @IsString()
  @IsOptional()
  @MaxLength(LIVE_CHAT_MESSAGE_MAX_CHARS)
  message?: string;

  /** The user ID of the content's author (sent by the client, optional). Used to enable quick moderation actions. */
  @IsString()
  @IsOptional()
  reportedUserId?: string;
}

/** DTO for reviewing a report (dismiss or mark actioned). */
export class ReviewReportDto {
  @IsIn(['reviewed', 'dismissed'])
  action: 'reviewed' | 'dismissed';
}

/** DTO for muting a user. */
export class MuteUserDto {
  @IsString()
  @IsOptional()
  @MaxLength(500)
  reason?: string;
}
