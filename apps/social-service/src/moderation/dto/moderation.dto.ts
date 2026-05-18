import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** DTO for reporting a piece of content. */
export class CreateReportDto {
  @IsIn(['post', 'comment', 'message'])
  contentType: 'post' | 'comment' | 'message';

  @IsString()
  @IsNotEmpty()
  contentId: string;

  @IsIn(['spam', 'harassment', 'inappropriate', 'other'])
  reason: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  details?: string;
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
