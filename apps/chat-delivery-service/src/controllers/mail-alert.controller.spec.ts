/// <reference types="jest" />

import { BadRequestException, HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MailAlertThrottlerGuard } from '../guards/mail-alert-throttler.guard';
import {
  MAIL_ALERT_REFUSAL,
  MailAlertRefusal,
  type MailAlertService,
} from '../services/mail-alert.service';
import { hashMailAlertToken } from '../utils/mail-alert';
import { MAIL_ALERT_LIMIT_PER_MINUTE, MailAlertController } from './mail-alert.controller';

const TOKEN = '0123456789abcdef0123456789abcdef';

describe('MailAlertController', () => {
  const service = {
    alert: jest.fn(async () => ({ status: 'pushed', sent: 1, failed: 0 })),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    state: jest.fn(),
  };
  const controller = new MailAlertController(service as unknown as MailAlertService);
  let error: jest.SpyInstance;

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MAIL_ALERT_HOOK_SECRET = 'the-worker-secret';
  });

  it('refuses a post without the secret, with a wrong one, and on an estate with none', async () => {
    await expect(controller.hook(undefined, { token: TOKEN })).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    await expect(controller.hook('guess', { token: TOKEN })).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    process.env.MAIL_ALERT_HOOK_SECRET = '';
    await expect(controller.hook('', { token: TOKEN })).rejects.toBeInstanceOf(
      UnauthorizedException
    );
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'MAIL_ALERT_HOOK_SECRET is unset'
    );
    expect(service.alert).not.toHaveBeenCalled();
  });

  it('refuses a body with no well-formed token, and hands a good one to the service', async () => {
    await expect(
      controller.hook('the-worker-secret', { token: 'n-0123@x' })
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await controller.hook('the-worker-secret', { token: TOKEN })).toEqual({
      status: 'pushed',
      sent: 1,
      failed: 0,
    });
    expect(service.alert).toHaveBeenCalledWith(TOKEN);
  });

  it('answers a typed refusal of a subscription with its status and error', async () => {
    service.subscribe.mockRejectedValueOnce(new MailAlertRefusal(MAIL_ALERT_REFUSAL.off, 409));
    const refused = await controller
      .subscribe('u1', { deviceId: 'd1', token: TOKEN })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getStatus()).toBe(409);
    expect((refused as HttpException).getResponse()).toMatchObject({ error: 'mail_push_off' });
    await expect(controller.subscribe('u1', { deviceId: 'd1', token: 'x' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(controller.subscribe('u1', { token: TOKEN })).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('throttles per token hash, never the token, and one bucket for a body without one', async () => {
    const guard = Object.create(MailAlertThrottlerGuard.prototype) as {
      getTracker(req: Record<string, unknown>): Promise<string>;
    };
    expect(await guard.getTracker({ body: { token: TOKEN } })).toBe(
      `mail-alert:${hashMailAlertToken(TOKEN)}`
    );
    expect(await guard.getTracker({ body: { token: 'nope' } })).toBe('mail-alert:none');
    expect(await guard.getTracker({})).toBe('mail-alert:none');
    expect(MAIL_ALERT_LIMIT_PER_MINUTE).toBeGreaterThan(0);
  });

  it('the edge routes the hook to this service with no session and every trust header stripped', () => {
    const nginx = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'infrastructure', 'local', 'Dockerfile.frontend'),
      'utf8'
    );
    const start = nginx.indexOf('location = /api/hooks/mail-alert {');
    expect(start).toBeGreaterThan(-1);
    const block = nginx.slice(start, nginx.indexOf('    }', start));
    expect(block).toContain('proxy_pass http://$target_chat_delivery_service;');
    expect(block).not.toContain('auth_request');
    expect(block).toContain('limit_req zone=mail_alert_hook burst=200 nodelay;');
    expect(nginx).toContain(
      'limit_req_zone $mail_alert_hook_key zone=mail_alert_hook:1m rate=20r/s;'
    );
    for (const header of ['X-User-Id', 'X-Global-Admin', 'X-Internal-Token', 'X-Internal-Secret']) {
      expect(block).toMatch(new RegExp(`proxy_set_header ${header} "(false)?";`));
    }
  });
});
