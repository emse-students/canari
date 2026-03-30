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
import { UsersService } from '../users/users.service';

interface OidcCallbackDto {
  code: string;
  redirect_uri: string;
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
  private readonly authentikBaseUrl: string;
  private readonly authentikClientId: string;
  private readonly authentikClientSecret: string;

  constructor(private readonly usersService: UsersService) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'change-me-in-production') {
      throw new Error(
        'JWT_SECRET must be set to a strong random value (e.g. openssl rand -hex 32)',
      );
    }
    this.jwtSecret = secret;

    this.authentikBaseUrl = (
      process.env.AUTHENTIK_BASE_URL || ''
    ).replace(/\/+$/, '');
    this.authentikClientId = process.env.AUTHENTIK_CLIENT_ID || '';
    this.authentikClientSecret = process.env.AUTHENTIK_CLIENT_SECRET || '';
  }

  // ─── OIDC callback (Authentik) ─────────────────────────────────────────────
  // The frontend redirects the user to Authentik, which redirects back with a
  // `code`.  The frontend then POSTs that code here so we can exchange it for
  // tokens server-side (keeping the client_secret safe).
  @Post('oidc/callback')
  @HttpCode(200)
  async oidcCallback(
    @Body() body: OidcCallbackDto,
  ): Promise<TokenPair & { user: { id: string; email: string; displayName: string } }> {
    const { code, redirect_uri } = body ?? {};
    if (!code) throw new BadRequestException('code is required');
    if (!redirect_uri) throw new BadRequestException('redirect_uri is required');

    if (
      !this.authentikBaseUrl ||
      !this.authentikClientId ||
      !this.authentikClientSecret
    ) {
      throw new BadRequestException(
        'Authentik OIDC is not configured on the server',
      );
    }

    // 1. Exchange authorization code for tokens
    const tokenUrl = `${this.authentikBaseUrl}/application/o/token/`;
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri,
        client_id: this.authentikClientId,
        client_secret: this.authentikClientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      throw new UnauthorizedException(
        `Authentik token exchange failed (${tokenRes.status}): ${errText}`,
      );
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
    };

    // 2. Fetch user info from Authentik
    const userinfoUrl = `${this.authentikBaseUrl}/application/o/userinfo/`;
    const userinfoRes = await fetch(userinfoUrl, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userinfoRes.ok) {
      throw new UnauthorizedException(
        'Failed to fetch user info from Authentik',
      );
    }

    const userinfo = (await userinfoRes.json()) as {
      sub: string;
      email?: string;
      preferred_username?: string;
      name?: string;
    };

    if (!userinfo.sub) {
      throw new UnauthorizedException('Invalid userinfo response from Authentik');
    }

    // 3. Upsert local user
    const user = await this.usersService.findOrCreateFromOidc(
      userinfo.sub,
      userinfo.email || null,
      userinfo.name || userinfo.preferred_username || null,
    );

    // 4. Issue internal JWT pair
    const access_token = jwt.sign({ sub: user.id }, this.jwtSecret, {
      expiresIn: '1h',
    });
    const refresh_token = jwt.sign(
      { sub: user.id, type: 'refresh' },
      this.jwtSecret,
      { expiresIn: '7d' },
    );

    return {
      access_token,
      refresh_token,
      user: {
        id: user.id,
        email: user.email || '',
        displayName: user.displayName || '',
      },
    };
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
