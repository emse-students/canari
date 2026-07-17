import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** One dig / flag action from the client move log. */
export class MinesweeperMoveDto {
  @IsIn(['reveal', 'flag'])
  type!: 'reveal' | 'flag';

  @IsInt()
  @Min(0)
  @Max(63)
  x!: number;

  @IsInt()
  @Min(0)
  @Max(63)
  y!: number;
}

/**
 * Ranked submit body. The client timer is trusted only when it stays within a
 * capped window below the server wall-clock (network / generation lag).
 */
export class SubmitMinesweeperDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20_000)
  @ValidateNested({ each: true })
  @Type(() => MinesweeperMoveDto)
  moves!: MinesweeperMoveDto[];

  /** Local play timer from first dig to win (preferred when plausible). */
  @Transform(({ value }) => Math.round(Number(value)))
  @IsInt()
  @Min(0)
  @Max(7_200_000)
  claimedDurationMs!: number;

  /**
   * Measured client RTT for `POST /challenges` (request start → response).
   * Used to size the network credit; the server never trusts emit timestamps
   * directly (it only sees arrival time).
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null ? undefined : Math.round(Number(value))
  )
  @IsInt()
  @Min(0)
  @Max(60_000)
  challengeRoundTripMs?: number;
}
