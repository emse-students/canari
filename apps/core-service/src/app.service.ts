import { Injectable } from '@nestjs/common';

/** Root service providing a basic greeting for health-check purposes. */
@Injectable()
export class AppService {
  /** Returns a simple hello-world greeting string. */
  getHello(): string {
    return 'Hello World!';
  }
}
