import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Head,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';

interface LoginDto {
  userId: string;
}

interface RefreshDto {
  refresh_token: string;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

@Controller('auth')
export class AuthController {
  private readonly jwtSecret: string;

  constructor() {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'change-me-in-production') {
      throw new Error(
        'JWT_SECRET must be set to a strong random value (e.g. openssl rand -hex 32)',
      );
    }
    this.jwtSecret = secret;
  }

  // ─── Dev-phase login ───────────────────────────────────────────────────────
  // No password required: the user provides their userId and gets a token pair.
  // The PIN is handled separately by the delivery service for MLS key access.
  @Post('login')
  @HttpCode(200)
  devLogin(@Body() body: LoginDto): TokenPair {
    const userId = body?.userId?.trim();
    if (!userId) throw new BadRequestException('userId is required');

    const access_token = jwt.sign({ sub: userId }, this.jwtSecret, {
      expiresIn: '1h',
    });
    const refresh_token = jwt.sign(
      { sub: userId, type: 'refresh' },
      this.jwtSecret,
      { expiresIn: '7d' },
    );
    return { access_token, refresh_token };
  }

  // ─── Token refresh ─────────────────────────────────────────────────────────
  @Post('refresh')
  @HttpCode(200)
  refreshToken(@Body() body: RefreshDto): TokenPair {
    const { refresh_token } = body ?? {};
    if (!refresh_token)
      throw new UnauthorizedException('refresh_token is required');

    let payload: { sub: string; type: string };
    try {
      payload = jwt.verify(refresh_token, this.jwtSecret) as {
        sub: string;
        type: string;
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (payload.type !== 'refresh')
      throw new UnauthorizedException('Invalid token type');

    const access_token = jwt.sign({ sub: payload.sub }, this.jwtSecret, {
      expiresIn: '1h',
    });
    const new_refresh = jwt.sign(
      { sub: payload.sub, type: 'refresh' },
      this.jwtSecret,
      { expiresIn: '7d' },
    );
    return { access_token, refresh_token: new_refresh };
  }

  // ─── Verify (used by nginx auth_request) ──────────────────────────────────
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

    // Default: not authenticated — headers are always set so downstream services
    // receive a consistent shape regardless of whether a token was provided.
    res.set('X-User-Id', '');
    res.set('X-Logged-In', 'false');

    if (!rawHeaders) {
      return res.status(200).send();
    }

    const parts = String(rawHeaders).split(' ');
    const token = parts.length > 1 ? parts[1] : parts[0];
    if (!token) {
      return res.status(200).send();
    }

    try {
      const payload = jwt.verify(token, this.jwtSecret) as { sub: string };

      res.set('X-User-Id', payload.sub);
      res.set('X-Logged-In', 'true');
      return res.status(200).send();
    } catch {
      // Invalid/expired token — pass through as anonymous; the service decides
      // whether to reject the request.
      return res.status(200).send();
    }
  }
}
