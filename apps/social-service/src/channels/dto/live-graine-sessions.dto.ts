import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import { MAX_LIVE_SESSION_QUERY } from '../channel.service';

/**
 * Body for `POST /api/channels/graine/live-sessions`.
 *
 * The bound is declared here as well as in the service on purpose: this one rejects at the edge
 * with a readable message, the service's guards the method against any other caller. Neither is
 * allowed to truncate - an answer missing ids reads as "those are dead" and would delete live
 * seeds.
 */
export class LiveGraineSessionsDto {
  @IsArray()
  @ArrayMaxSize(MAX_LIVE_SESSION_QUERY)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  sessionIds!: string[];
}
