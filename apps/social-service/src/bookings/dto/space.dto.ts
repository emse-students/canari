import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { FormItemDto } from '../../forms/dto/form.dto';
import { ZONED_INSTANT, ZONED_INSTANT_MESSAGE } from './booking.dto';

/** At most this many questions, availability lines and exceptions: far above any real space. */
export const MAX_SPACE_ITEMS = 50;
export const MAX_AVAILABILITY_LINES = 200;
export const MAX_AVAILABILITY_EXCEPTIONS = 100;
/**
 * At most this many PERSONAL spaces per account, and resources per space (review of #2006): far
 * above the cases that bound the design (one music room; 14-21 alumni columns), and low enough that
 * one account cannot fill a table. Refused `too-many-spaces` / `too-many-resources`.
 */
export const MAX_PERSONAL_SPACES = 20;
export const MAX_RESOURCES_PER_SPACE = 60;

/**
 * The length of one fixed slot a 'slots' space may store (migration 116): the creation wizard's
 * choices span it (`SLOT_LENGTH_CHOICES`, 15 to 120 minutes), and the CHECK
 * `booking_spaces_slot_minutes` holds the same pair.
 */
export const SLOT_MINUTES_MIN = 15;
export const SLOT_MINUTES_MAX = 120;

/** A wall time `HH:MM` or `HH:MM:SS`, `24:00` included (the end of a day). */
export const WALL_TIME = /^(([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?|24:00(:00)?)$/;
/** A calendar date's shape; whether it EXISTS is checked by `isCalendarDate`. */
export const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** The image types a poster may be: what the client's compression produces, and what a phone picks. */
export const POSTER_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * A space's poster (D35): the reference `MediaService.encryptAndUpload` returns for an image, its
 * per-file key travelling here as a post image's does. The service copies these fields and no
 * other (`posterOf`), so a key a client adds is never stored.
 */
export class PosterDto {
  @IsIn(['image'])
  type: 'image';

  @IsUUID()
  mediaId: string;

  /** AES-256-GCM key, 32 bytes in hex. */
  @Matches(/^[0-9a-f]{64}$/i)
  key: string;

  /** AES-GCM nonce, 12 bytes in hex. */
  @Matches(/^[0-9a-f]{24}$/i)
  iv: string;

  @IsIn(POSTER_MIME_TYPES)
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(64 * 1024 * 1024)
  size: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20_000)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20_000)
  height?: number;
}

/**
 * Every setting of a space the organiser writes (D35). Each is optional: a PATCH sends what changed.
 * `null` clears a nullable setting, `undefined` (absent) leaves it.
 */
export class SpaceSettingsDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(4000)
  description?: string | null;

  /** An IANA zone; checked against the runtime's zone database in the service. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timeZone?: string;

  @IsOptional()
  @IsIn(['step', 'slots'])
  slotMode?: 'step' | 'slots';

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(5)
  @Max(1440)
  stepMinutes?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(96)
  maxSteps?: number | null;

  /**
   * How long one fixed slot lasts, on a 'slots' space only (a step space carrying one is refused
   * `slot-shape`); null = not stored, the painter infers it from the lines. Absent on a switch to
   * 'step' = cleared by the service.
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(SLOT_MINUTES_MIN)
  @Max(SLOT_MINUTES_MAX)
  slotMinutes?: number | null;

  @IsOptional()
  @IsIn(['names', 'occupied'])
  nameVisibility?: 'names' | 'occupied';

  @IsOptional()
  @IsIn(['listed', 'link'])
  discoverability?: 'listed' | 'link';

  /** The forms' audience predicate (D6), validated by `parseAudienceCondition`; null = everybody. */
  @IsOptional()
  audience?: unknown;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SPACE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => FormItemDto)
  items?: FormItemDto[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(4000)
  privateInfo?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  @Matches(ZONED_INSTANT, { message: ZONED_INSTANT_MESSAGE })
  opensAt?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(525_600)
  minNoticeMinutes?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(730)
  horizonDays?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxActiveBookings?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(10_080)
  maxMinutesPerPeriod?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['day', 'week'])
  quotaPeriod?: 'day' | 'week' | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(525_600)
  participantWithdrawMinMinutes?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(50)
  maxPeople?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  retentionDays?: number;

  /** The poster (D35), encrypted by the client; null removes it. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @ValidateNested()
  @Type(() => PosterDto)
  poster?: PosterDto | null;
}

/** A resource's own fields (D10, D32). */
export class ResourceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(2000)
  privateInfo?: string | null;

  /** The account that sees this resource's bookings and may block it (D10); null unlinks. */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(255)
  linkedUserId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  position?: number;
}

/** `POST bookings/spaces/:id/resources`: a name is required. */
export class CreateResourceDto extends ResourceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare name: string;
}

/** One availability line: weekly (`weekday` 1 = Monday .. 7) or dated (`onDate`), never both. */
export class AvailabilityLineDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(7)
  weekday?: number | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(DATE_SHAPE)
  onDate?: string | null;

  @Matches(WALL_TIME)
  startTime: string;

  @Matches(WALL_TIME)
  endTime: string;
}

/** A closure over local dates, both included. */
export class AvailabilityExceptionDto {
  @Matches(DATE_SHAPE)
  fromDate: string;

  @Matches(DATE_SHAPE)
  toDate: string;
}

/** `PUT bookings/resources/:id/availability` - the resource's WHOLE availability, replaced (D11, D29). */
export class AvailabilityDto {
  @IsArray()
  @ArrayMaxSize(MAX_AVAILABILITY_LINES)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityLineDto)
  lines: AvailabilityLineDto[];

  @IsArray()
  @ArrayMaxSize(MAX_AVAILABILITY_EXCEPTIONS)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityExceptionDto)
  exceptions: AvailabilityExceptionDto[];
}

/**
 * `POST bookings/spaces` - a new space, personal or of an entity the actor manages (D2, D16).
 * Declared after {@link AvailabilityDto} because it names it as a property type, whose decorator
 * metadata is read when this class is defined.
 */
export class CreateSpaceDto extends SpaceSettingsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare name: string;

  /** The owning association, list or institution; absent = a personal space. */
  @IsOptional()
  @IsUUID()
  associationId?: string;

  /**
   * The first hours of the space's ONE default column (D44), written in the creation's own
   * transaction, so the creation wizard (D52) never leaves a space without them when a second call
   * fails. Absent = the column starts closed, as a column added later does.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => AvailabilityDto)
  availability?: AvailabilityDto;
}
