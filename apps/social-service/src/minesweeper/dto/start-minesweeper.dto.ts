import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Body of `POST /minesweeper/challenges`. Absent from every build that predates generator versions,
 * so an empty body is valid and means "generator 1".
 */
export class StartMinesweeperDto {
  /** The newest mine-placement generator the client can produce; the server issues at most this. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxGeneratorVersion?: number;
}
