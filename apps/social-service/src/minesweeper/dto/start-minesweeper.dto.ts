import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Body of `POST /minesweeper/challenges`. Absent from every build that predates generator versions:
 * an empty body is valid, and means a client that cannot be ranked (`426 generator_update_required`).
 */
export class StartMinesweeperDto {
  /** The newest mine-placement generator the client can produce; ranked needs the server's latest. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxGeneratorVersion?: number;
}
