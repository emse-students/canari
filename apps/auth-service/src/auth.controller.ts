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
    if (!rawHeaders) {
      return res.status(401).send();
    }

    const token = rawHeaders.split(' ')[1];
    if (!token) {
      return res.status(401).send();
    }

    try {
      const payload = jwt.verify(
        token,
        process.env.JWT_SECRET || 'change-me-in-production',
      ) as { sub: string };

      // Set the X-User-Id header for Nginx to use
      res.set('X-User-Id', payload.sub);
      return res.status(200).send();
    } catch {
      return res.status(401).send();
    }
  }
}
