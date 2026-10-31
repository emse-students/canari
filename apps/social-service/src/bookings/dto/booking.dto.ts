import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsValidAnswers } from '../../forms/dto/form.dto';

/**
 * AN INSTANT CARRIES ITS ZONE: ISO 8601 ending in `Z` or an offset. `IsDateString` alone accepts
 * `2026-11-02T10:00`, which `Date.parse` reads in the SERVER's zone - an instant that depends on
 * where the container runs. Every instant of the module (a booking's range, a block's, a space's
 * opening) is checked by this one shape.
 */
export const ZONED_INSTANT = /(Z|[+-]\d{2}:\d{2})$/;
export const ZONED_INSTANT_MESSAGE = 'an instant must end in Z or an offset';

/**
 * A reminder's delay before the slot, in minutes (WP-N, D53): from five minutes to a week. The
 * database's CHECKs (migration 115) hold the same bounds.
 */
export const REMINDER_MIN_MINUTES = 5;
export const REMINDER_MAX_MINUTES = 10_080;

/** At most this many characters in the word an organiser sends with a cancellation (Q-R3). */
export const CANCEL_MESSAGE_MAX = 500;

/** At most this many participants in one request: far above any `maxPeople` an organiser sets. */
export const MAX_PARTICIPANTS_PER_REQUEST = 50;

/** `POST bookings/spaces/:spaceId/bookings` - book a range of one resource (D4, D7, D20). */
export class CreateBookingDto {
  @IsUUID()
  resourceId: string;

  /** UTC instants of the half-open range, ISO 8601. */
  @IsDateString()
  @Matches(ZONED_INSTANT, { message: ZONED_INSTANT_MESSAGE })
  startsAt: string;

  @IsDateString()
  @Matches(ZONED_INSTANT, { message: ZONED_INSTANT_MESSAGE })
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

  /**
   * The HOLDER's own reminder delay (Q-R1); null = no reminder. Absent: the space's default. The
   * participants start at the space's default and each changes their own (`PATCH :id/reminder`).
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(REMINDER_MIN_MINUTES)
  @Max(REMINDER_MAX_MINUTES)
  reminderMinutes?: number | null;
}

/** `POST bookings/:bookingId/cancel` - an optional word to the booking's people (Q-R3). */
export class CancelBookingDto {
  /** Carried by the notification only: never stored with the booking (Q-R3). */
  @IsOptional()
  @IsString()
  @MaxLength(CANCEL_MESSAGE_MAX)
  message?: string;
}

/** `PATCH bookings/:bookingId/reminder` - one person's own reminder delay (Q-R1). */
export class ReminderDto {
  /** Minutes before the slot; null = no reminder. */
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(REMINDER_MIN_MINUTES)
  @Max(REMINDER_MAX_MINUTES)
  minutes: number | null;
}

/** `POST bookings/resources/:resourceId/blocks` - "Indisponible" over a range (D10, D20). */
export class CreateBlockDto {
  @IsDateString()
  @Matches(ZONED_INSTANT, { message: ZONED_INSTANT_MESSAGE })
  startsAt: string;

  @IsDateString()
  @Matches(ZONED_INSTANT, { message: ZONED_INSTANT_MESSAGE })
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
