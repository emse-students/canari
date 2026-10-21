import type { AddressInfo } from 'net';
import { ForbiddenException, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BookingCalendarController } from './booking-calendar.controller';
import { BookingsService } from './bookings.service';

/**
 * THE ONE ROUTE WITH NO SESSION, AT THE HTTP LAYER: what a calendar app receives. The rules behind
 * it are `bookings.service.integration.spec.ts`'s; here, its headers and the order of its checks -
 * a malformed id, or a repeated `u`/`sig` that Express would hand over as an array, is a 400 from
 * a pipe, before any signature is computed.
 */
describe('GET bookings/:id/calendar.ics', () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  const calls: unknown[][] = [];
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const service = {
      calendarIcs: async (...args: unknown[]) => {
        calls.push(args);
        if (args[2] !== 'good') throw new ForbiddenException({ code: 'calendar-signature' });
        return 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
      },
    };
    @Module({
      controllers: [BookingCalendarController],
      providers: [{ provide: BookingsService, useValue: service }],
    })
    class HttpModule {}
    app = await NestFactory.create(HttpModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('serves a calendar no shared cache keeps', async () => {
    const res = await fetch(`${base}/bookings/${ID}/calendar.ics?u=alice&sig=good`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toContain('BEGIN:VCALENDAR');
    expect(calls).toEqual([[ID, 'alice', 'good']]);
  });

  it('refuses a malformed id with a 400 before the signature is looked at', async () => {
    const res = await fetch(`${base}/bookings/not-a-uuid/calendar.ics?u=alice&sig=good`);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers the service's refusal as it is typed", async () => {
    const res = await fetch(`${base}/bookings/${ID}/calendar.ics?u=alice&sig=bad`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'calendar-signature' });
  });

  it.each([
    ['a repeated recipient', 'u=alice&u=bob&sig=good'],
    ['a repeated signature', 'u=alice&sig=good&sig=good'],
  ])('refuses %s with a 400 before the signature is looked at', async (_what, query) => {
    const res = await fetch(`${base}/bookings/${ID}/calendar.ics?${query}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'query-not-a-string' });
    expect(calls).toEqual([]);
  });

  it('still hands an absent recipient and signature to the service, which refuses them', async () => {
    const res = await fetch(`${base}/bookings/${ID}/calendar.ics`);
    expect(res.status).toBe(403);
    expect(calls).toEqual([[ID, undefined, undefined]]);
  });
});
