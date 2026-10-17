import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { IsValidAnswers } from '../../forms/dto/form.dto';

/** At most this many participants in one request: far above any `maxPeople` an organiser sets. */
export const MAX_PARTICIPANTS_PER_REQUEST = 50;

/** `POST bookings/spaces/:spaceId/bookings` - book a range of one resource (D4, D7, D20). */
export class CreateBookingDto {
  @IsUUID()
  resourceId: string;

  /** UTC instants of the half-open range, ISO 8601. */
  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  /** The other people of the booking, Canari accounts (D4, D34). The holder is not one of them. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PARTICIPANTS_PER_REQUEST)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  participantIds?: string[];

  /** Answers to the space's questions, the forms' shape (D7). */
  @IsOptional()
  @IsValidAnswers()
  answers?: Record<string, string | string[] | number>;

  /** Booking ON BEHALF of this account (D20): only an organiser may name someone else. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  holderId?: string;
}

/** `POST bookings/resources/:resourceId/blocks` - "Indisponible" over a range (D10, D20). */
export class CreateBlockDto {
  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Whether bookers see the reason, or only "Indisponible". */
  @IsOptional()
  @IsBoolean()
  reasonVisible?: boolean;
}
