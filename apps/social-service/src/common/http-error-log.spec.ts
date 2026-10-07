import { AxiosError, AxiosHeaders } from 'axios';
import { describeHttpError, redactSecrets } from './http-error-log';

describe('describeHttpError', () => {
  function secretCarryingError(): AxiosError {
    const config = {
      method: 'post',
      url: 'http://core-service:3000/payments/create-checkout-session?token=QUERYSECRET',
      headers: new AxiosHeaders({ 'x-internal-secret': 'S3CR3T' }),
      data: '{"api_token":"TOK123"}',
    };
    return new AxiosError(
      'Request failed with status code 400',
      'ERR_BAD_REQUEST',
      config as never,
      {},
      {
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        config: config as never,
        data: { message: 'Lydia refused', api_token: 'TOK123', private_token: 'PRIV456' },
      }
    );
  }

  it('renders method, url without query, status and the provider message', () => {
    expect(describeHttpError(secretCarryingError())).toBe(
      'POST http://core-service:3000/payments/create-checkout-session -> 400: Lydia refused'
    );
  });

  it('never carries a header value, a query secret or a token', () => {
    const rendered = describeHttpError(secretCarryingError());
    for (const leak of ['S3CR3T', 'QUERYSECRET', 'TOK123', 'PRIV456', 'x-internal-secret']) {
      expect(rendered).not.toContain(leak);
    }
  });

  it('scrubs a secret that the provider echoes inside its own message', () => {
    expect(redactSecrets('bad call, x-internal-secret: S3CR3T and api_token=TOK123')).not.toMatch(
      /S3CR3T|TOK123/
    );
  });

  it('renders a plain Error by its message and a non-Error by its string form', () => {
    expect(describeHttpError(new Error('boom'))).toBe('boom');
    expect(describeHttpError('nope')).toBe('nope');
    expect(describeHttpError(undefined)).toBe('unknown error');
  });

  it('says so when the call got no response at all', () => {
    const err = new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED', {
      method: 'get',
      url: 'http://x/y',
      headers: new AxiosHeaders({ 'x-internal-secret': 'S3CR3T' }),
    } as never);
    expect(describeHttpError(err)).toBe('GET http://x/y -> no response: connect ECONNREFUSED');
  });
});
