import { Controller, Get, Head, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';

@Controller('auth')
export class AuthController {
  @Get('verify')
  verifyStart(@Req() req: Request, @Res() res: Response) {
    this.check(req, res);
  }

  @Head('verify')
  verify(@Req() req: Request, @Res() res: Response) {
    this.check(req, res);
  }

  private check(req: Request, res: Response) {
    const rawHeaders = req.headers['authorization'];

    // Default: not logged in
    res.set('X-Logged-In', 'false');
    res.set('X-User-Id', '');

    if (!rawHeaders) {
      return res.status(200).send();
    }

    const parts = String(rawHeaders).split(' ');
    const token = parts.length > 1 ? parts[1] : parts[0];
    if (!token) {
      return res.status(200).send();
    }

    try {
      const payload = jwt.verify(
        token,
        process.env.JWT_SECRET || 'change-me-in-production',
      ) as { sub: string };

      // Set the X-User-Id header for downstream services (e.g., Nginx)
      res.set('X-User-Id', payload.sub);
      res.set('X-Logged-In', 'true');
      return res.status(200).send();
    } catch {
      // Invalid token -> treat as anonymous, but do not return 401
      return res.status(200).send();
    }
  }
}
