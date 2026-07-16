import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
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
 * Ranked submit body. `claimedDurationMs` is ignored for scoring (anti-cheat);
 * the server uses wall-clock elapsed since challenge start.
 */
export class SubmitMinesweeperDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20_000)
  @ValidateNested({ each: true })
  @Type(() => MinesweeperMoveDto)
  moves!: MinesweeperMoveDto[];

  /** Client timer — accepted only as a soft upper bound sanity check. */
  @IsInt()
  @Min(0)
  @Max(7_200_000)
  claimedDurationMs!: number;
}
