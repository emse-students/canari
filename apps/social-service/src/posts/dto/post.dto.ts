import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { AudienceRuleDto } from '../../spaces/dto/space.dto';

/**
 * A post needs a body OR a media entry - the rule the composer's Publier button already applies
 * (`hasContent` in `frontend/src/lib/posts/composerReadiness.ts`, the client's one spelling).
 *
 * The body was `@IsNotEmpty()` alone, so a photo or a video posted without a caption - which the
 * composer enables and which a reel is by default - went through the whole publish (preparation,
 * encryption, upload) and was then refused here with a 400, the uploaded blob left behind. Found on
 * the Mi 9T on 2026-10-02 (`markdown should not be empty`). Whitespace counts as empty, as it does
 * on the client.
 */
@ValidatorConstraint({ name: 'postBodyOrMedia', async: false })
export class PostBodyOrMediaConstraint implements ValidatorConstraintInterface {
  validate(markdown: unknown, args: ValidationArguments): boolean {
    if (typeof markdown === 'string' && markdown.trim().length > 0) return true;
    const post = args.object as { media?: unknown[]; images?: unknown[] };
    return (post.media?.length ?? 0) + (post.images?.length ?? 0) > 0;
  }

  defaultMessage(): string {
    return 'markdown should not be empty unless the post carries media';
  }
}

export class PostMediaDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(['image', 'video', 'audio', 'file'])
  type: string;

  @IsString()
  @IsNotEmpty()
  mediaId: string;

  @IsString()
  @IsNotEmpty()
  key: string;

  @IsString()
  @IsNotEmpty()
  iv: string;

  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @IsNumber()
  @Min(0)
  size: number;

  @IsString()
  @IsOptional()
  fileName?: string;

  @IsInt()
  @IsOptional()
  @Min(1)
  width?: number;

  @IsInt()
  @IsOptional()
  @Min(1)
  height?: number;

  /**
   * How the blob is sealed (CanaReels R2, `frontend/src/lib/mediaSegmented.ts`): absent for the
   * single AES-GCM block every post was written with until then, `'segmented-v1'` for the STREAM
   * format a video can be played from while it downloads.
   *
   * DECLARED HERE IN THE READER RELEASE, BEFORE ANY CLIENT WRITES IT: `whitelist: true` deletes an
   * undeclared field, and a segmented blob stored without its encoding would be read by every
   * client as a single block and refused - the post's video lost, silently, at the first save.
   * A value outside the list is a 400, never stored: the server cannot read the bytes either way,
   * but it can refuse to record a format no client knows.
   */
  @IsString()
  @IsOptional()
  @IsIn(['segmented-v1'])
  encoding?: string;
}

export class PollOptionInputDto {
  /**
   * The option's existing id, when a poll is being EDITED.
   *
   * It was not here, and `whitelist: true` therefore deleted it from every payload: each save
   * minted new ids, no stored vote matched an option any more, and fixing a typo in a question
   * emptied the poll. An option the editor did not touch keeps its id, and with it its votes.
   */
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  label: string;
}

export class PollInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  question: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => PollOptionInputDto)
  options: PollOptionInputDto[];

  @IsBoolean()
  @IsOptional()
  multipleChoice?: boolean;

  /**
   * How many options one voter may pick, or absent/null for no limit.
   *
   * `@IsOptional()` passes `null` through untouched, which is how the composer CLEARS a cap: an
   * omitted field and an explicit `null` must mean the same thing here, because the update path
   * rebuilds the poll from this payload alone.
   */
  @IsInt()
  @Min(2)
  @IsOptional()
  maxSelections?: number | null;

  @IsDateString()
  @IsOptional()
  endsAt?: string;

  /**
   * Store votes without their voter: a tally and a list of who voted, never joined. FIXED at
   * creation - the stored value wins on an edit - and final for the voter (see `anonymous-poll.ts`).
   */
  @IsBoolean()
  @IsOptional()
  anonymous?: boolean;
}

export class FormOptionInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsNumber()
  priceModifier: number;
}

export class FormItemInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsBoolean()
  required: boolean;

  @IsString()
  @IsNotEmpty()
  type: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormOptionInputDto)
  @IsOptional()
  options?: FormOptionInputDto[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  rows?: string[];

  @IsOptional()
  scale?: {
    min: number;
    max: number;
    minLabel?: string;
    maxLabel?: string;
  };
}

export class FormInputDto {
  @IsString()
  @IsOptional()
  id?: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  eventId: string;

  @IsNumber()
  @Min(0)
  basePrice: number;

  @IsString()
  currency: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FormItemInputDto)
  items: FormItemInputDto[];
}

export class CreatePostDto {
  @IsString()
  @IsOptional()
  authorId?: string;

  /**
   * `'reel'` publishes a CanaReel (one video, expires after a month); absent or `'post'` is the
   * post that has always existed. The rest of the reel's shape is `assertCreateKindShape`.
   */
  @IsIn(['post', 'reel'])
  @IsOptional()
  kind?: 'post' | 'reel';

  /** The reel's length in ms as the CLIENT declares it; refused above `REEL_MAX_DURATION_MS`. */
  @IsInt()
  @IsOptional()
  durationMs?: number;

  /** Text or media (a reel always carries its video, so its caption may be empty). */
  @IsString()
  @Validate(PostBodyOrMediaConstraint)
  @MaxLength(50_000)
  markdown: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  media?: PostMediaDto[];

  /** @deprecated Use `media` instead. Kept for backward-compatibility with older clients. */
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  images?: PostMediaDto[];

  @IsString()
  @IsOptional()
  attachedFormId?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PollInputDto)
  polls?: PollInputDto[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FormInputDto)
  forms?: FormInputDto[];

  @IsString()
  @IsOptional()
  associationId?: string;

  /**
   * Server decides precedence when both are set: `PostsController.createPost` forces this false
   * whenever `associationId` is present, never trusting the client to have respected the
   * mutual exclusivity the composer's own UI already enforces.
   */
  @IsBoolean()
  @IsOptional()
  anonymous?: boolean;

  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedCalendarEventId?: string;

  @IsDateString()
  @IsOptional()
  scheduledAt?: string;

  /**
   * The post's OWN audience rules (D33, docs/wiki/profiles-and-access.md): `null`/absent sides
   * mean "any". Absent or empty inherits the publishing association's rules. Every rule must stay
   * inside that association's own rules (its ceiling) - the server answers 400 otherwise - and a
   * personal post cannot carry any.
   */
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => AudienceRuleDto)
  audiences?: AudienceRuleDto[];
}

export class ListPostsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  offset?: number;

  /** Default `all` when omitted. */
  @IsOptional()
  @IsIn(['all', 'followed', 'custom', 'associations'])
  feed?: 'all' | 'followed' | 'custom' | 'associations';

  /**
   * Restricts the page to one kind. ABSENT MEANS BOTH - the feed shows reels where it shows posts
   * - and the full-screen reel viewer asks for `reel`.
   */
  @IsOptional()
  @IsIn(['post', 'reel'])
  kind?: 'post' | 'reel';

  /** Custom feed: filter by author promotion (personal posts only). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  promo?: number;

  /** Custom feed: filter by author formation (personal posts only), substring match. */
  @IsOptional()
  @IsString()
  formation?: string;
}

export class VotePollDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  optionIds: string[];
}

export class AddCommentDto {
  @IsString()
  @IsOptional()
  userId?: string;

  @IsString()
  @IsOptional()
  text?: string;

  @IsString()
  @IsOptional()
  parentId?: string;

  @IsObject()
  @IsOptional()
  media?: {
    mediaId: string;
    key: string;
    iv: string;
    mimeType: string;
    size: number;
    fileName?: string;
  };
}

export class AddReactionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  reactionType: string; // e.g. like, love, sad, laugh, angry, canari, hammer
}

export class EditCommentDto {
  @IsString()
  @IsNotEmpty()
  text: string;
}

export class UpdatePostDto {
  /** Text or media, as on create; a reel's caption can only be emptied in a request that still names its media. */
  @IsString()
  @Validate(PostBodyOrMediaConstraint)
  @MaxLength(50_000)
  markdown: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  media?: PostMediaDto[];

  /** @deprecated Use `media` instead. Kept for backward-compatibility with older clients. */
  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PostMediaDto)
  images?: PostMediaDto[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PollInputDto)
  polls?: PollInputDto[];

  @IsOptional()
  @ValidateIf((_, v) => v != null && v !== '')
  @IsUUID()
  attachedFormId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => typeof v === 'string' && v.length > 0)
  @IsUUID()
  linkedCalendarEventId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v != null && v !== '')
  @IsDateString()
  scheduledAt?: string | null;

  /**
   * The post's OWN audience rules (D33, docs/wiki/profiles-and-access.md): `null`/absent sides
   * mean "any". Absent or empty inherits the publishing association's rules. Every rule must stay
   * inside that association's own rules (its ceiling) - the server answers 400 otherwise - and a
   * personal post cannot carry any.
   */
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(16)
  @ValidateNested({ each: true })
  @Type(() => AudienceRuleDto)
  audiences?: AudienceRuleDto[];
}
