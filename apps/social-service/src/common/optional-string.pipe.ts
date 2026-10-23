import { BadRequestException, Injectable, Logger, type PipeTransform } from '@nestjs/common';

/**
 * A query parameter that is ONE string or absent, and nothing else.
 *
 * A TypeScript annotation on `@Query('u') u: string` is a wish: Express hands a repeated key
 * (`?u=a&u=b`) over as an ARRAY, and nothing between the request and the handler checks it. An
 * array then reads as a string almost everywhere - `encodeURIComponent(['a', 'b'])` is the
 * signature input of the account `a,b`, `.trim()` throws a 500 - so the type is settled HERE, at
 * the boundary, as a 400, rather than coerced by whoever reads it next.
 */
@Injectable()
export class OptionalStringPipe implements PipeTransform<unknown, string | undefined> {
  private readonly logger = new Logger(OptionalStringPipe.name);

  transform(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return value;
    this.logger.debug(
      `[PIPE] refused a query parameter of type ${Array.isArray(value) ? 'array' : typeof value}`
    );
    throw new BadRequestException({ code: 'query-not-a-string' });
  }
}
