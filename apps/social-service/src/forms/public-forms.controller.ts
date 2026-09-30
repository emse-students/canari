import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ClientIpThrottlerGuard } from '../common/guards/client-ip-throttler.guard';
import { GuestSubmitFormDto } from './dto/form.dto';
import { FormsService } from './forms.service';

/**
 * A PUBLIC FORM, ANSWERED WITHOUT AN ACCOUNT (user, 2026-09-30) - the two routes a guest on a
 * shared link calls, under `/api/public/`, where nginx strips every identity header.
 *
 * There is no captcha: the edge that offered one is gone, and the user chose a throttle and a
 * honeypot instead. The throttle counts per visitor, and that visitor is an ADDRESS: a room of
 * guests behind one NAT - a school network at an event - shares it, which is why the limit sits
 * well above what one person types and bounds only what a script can make this service store.
 */
@Controller('public/forms')
export class PublicFormsController {
  private readonly logger = new Logger(PublicFormsController.name);

  constructor(private readonly service: FormsService) {}

  /** The questions of a public form. Unthrottled: a database read, as the post preview JSON is. */
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getPublic(id);
  }

  /**
   * One guest answer. The reply says nothing but that it was taken: a guest has nothing to come
   * back to, and a submission id would be a handle on a row they cannot read.
   */
  @UseGuards(ClientIpThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/submit')
  @HttpCode(200)
  async submit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GuestSubmitFormDto) {
    // A filled honeypot is answered exactly like a real answer, so the bot learns nothing, and
    // logged, so a rise in them is seen rather than guessed.
    if (dto.website) {
      this.logger.warn(`[FORMS] guest answer dropped by the honeypot form=${id.slice(0, 8)}`);
      return { ok: true };
    }
    await this.service.submit(id, { answers: dto.answers }, 'guest');
    this.logger.log(`[FORMS] guest answer stored form=${id.slice(0, 8)}`);
    return { ok: true };
  }
}
