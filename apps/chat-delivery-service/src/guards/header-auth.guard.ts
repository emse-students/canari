import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';

@Injectable()
export class HeaderAuthGuard implements CanActivate {
  private readonly logger = new Logger(HeaderAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const loggedIn = request.headers['x-user-logged-in'];

    if (loggedIn === 'true') {
      return true;
    }

    const path = String(request?.originalUrl ?? request?.url ?? 'unknown');
    if (path.includes('/push/')) {
      this.logger.warn(
        `[AUTH_GUARD] denied ${String(request?.method ?? 'UNKNOWN')} ${path} ` +
          `x-user-logged-in=${String(loggedIn ?? '')} ` +
          `x-user-id=${String(request?.headers?.['x-user-id'] ?? '')} ` +
          `hasAuth=${request?.headers?.authorization ? 'yes' : 'no'}`,
      );
    }

    throw new UnauthorizedException('User is not authenticated');
  }
}
