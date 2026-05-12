import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

/** Root controller providing a basic health-check greeting. */
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** Returns a simple hello-world greeting string. */
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
