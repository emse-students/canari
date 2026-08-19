import axios from 'axios';
import { PaymentWebhookController } from './webhook.controller';
import type { PaymentService } from './payment.service';
import type { UsersService } from '../users/users.service';
import type { ConfigService } from '@nestjs/config';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function makeController(verified: boolean) {
  const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
  const usersService = {} as UsersService;
  const paymentService = {
    verifyLydiaRequestCallback: jest.fn().mockReturnValue(verified),
  } as unknown as PaymentService;
  return new PaymentWebhookController(config, usersService, paymentService);
}

describe('PaymentWebhookController.handleLydiaRequestCallback', () => {
  afterEach(() => jest.clearAllMocks());

  it('rejects an invalid outcome', async () => {
    const controller = makeController(true);
    await expect(
      controller.handleLydiaRequestCallback('bogus', { request_id: 'r1', sig: 's1' })
    ).rejects.toThrow(/outcome/);
  });

  it('rejects a callback missing request_id or sig', async () => {
    const controller = makeController(true);
    await expect(controller.handleLydiaRequestCallback('confirm', {})).rejects.toThrow(
      /request_id|sig/
    );
  });

  it('rejects a callback with an invalid signature, without touching social-service', async () => {
    const controller = makeController(false);
    await expect(
      controller.handleLydiaRequestCallback('confirm', {
        request_id: 'r1',
        order_ref: 'form:sub-1',
        sig: 'bad-sig',
      })
    ).rejects.toThrow(/signature/);
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('marks a form submission paid on a confirmed form order_ref', async () => {
    mockedAxios.post.mockResolvedValue({ data: {} });
    const controller = makeController(true);

    const result = await controller.handleLydiaRequestCallback('confirm', {
      request_id: 'r1',
      order_ref: 'form:sub-1',
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/submissions/sub-1/mark-paid');
    expect(body).toEqual({ sessionId: 'r1' });
  });

  it('fulfills a boutique purchase on a confirmed product order_ref', async () => {
    mockedAxios.post.mockResolvedValue({ data: {} });
    const controller = makeController(true);

    await controller.handleLydiaRequestCallback('confirm', {
      request_id: 'r1',
      amount: '12.34',
      order_ref: `product:${PRODUCT_ID}:${USER_ID}`,
      sig: 'valid-sig',
    });

    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain(`/products/${PRODUCT_ID}/purchase-completed`);
    expect(body).toEqual({ userId: USER_ID, amountCents: 1234, paymentIntentId: 'r1' });
  });

  it('cancels a pending submission on a cancelled/expired form order_ref', async () => {
    mockedAxios.post.mockResolvedValue({ data: {} });
    const controller = makeController(true);

    await controller.handleLydiaRequestCallback('expire', {
      request_id: 'r1',
      order_ref: 'form:sub-1',
      sig: 'valid-sig',
    });

    expect(mockedAxios.post.mock.calls).toHaveLength(1);
    const [url] = mockedAxios.post.mock.calls[0];
    expect(url).toContain('/submissions/sub-1/cancel-pending');
  });

  it('does nothing on a cancelled/expired product order_ref - no pending row exists to undo', async () => {
    const controller = makeController(true);

    const result = await controller.handleLydiaRequestCallback('cancel', {
      request_id: 'r1',
      order_ref: `product:${PRODUCT_ID}:${USER_ID}`,
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });

  it('acknowledges but does not act on an unrecognized order_ref', async () => {
    const controller = makeController(true);

    const result = await controller.handleLydiaRequestCallback('confirm', {
      request_id: 'r1',
      order_ref: 'something-unknown',
      sig: 'valid-sig',
    });

    expect(result).toEqual({ received: true });
    expect(mockedAxios.post.mock.calls).toHaveLength(0);
  });
});
