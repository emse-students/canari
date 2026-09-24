import { Controller, Get } from '@nestjs/common';

/** Liveness probe - no authentication required. */
@Controller()
export class HealthController {
  /** Liveness for Docker / probes - no authentication. */
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
