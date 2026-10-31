import { MlsDeliveryApi, type MlsDeliveryFetch } from './mlsDeliveryApi';

/**
 * Ending ANOTHER user's device row is refused once that row is `active` (403
 * `MEMBERSHIP_NOT_ALLOWED`): the pending-invitation sweep meets it when the invitation it read was
 * honoured meanwhile. That race is expected, so it is a debug line - classified by status and code
 * at the throw - while every other refusal stays an error.
 */
function makeApi(fetchImpl: MlsDeliveryFetch): MlsDeliveryApi {
  return new MlsDeliveryApi({
    historyUrl: 'https://test.local',
    getToken: async () => 'tok',
    fetchImpl,
  });
}

const refusal = (status: number, code: string) =>
  new Response(JSON.stringify({ code, message: 'refused' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('deleteDeviceMembership', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the active-row refusal as an expected race: a debug line, no error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const api = makeApi(async () => refusal(403, 'MEMBERSHIP_NOT_ALLOWED'));

    await expect(api.deleteDeviceMembership('u2', 'd2', 'g1')).resolves.toEqual({
      status: 'refused',
      affected: 0,
    });
    expect(error).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('active now'));
  });

  it('still accuses any other refusal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = makeApi(async () => refusal(403, 'NOT_A_MEMBER'));

    await expect(api.deleteDeviceMembership('u2', 'd2', 'g1')).resolves.toEqual({
      status: 'error',
      affected: 0,
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('403'));
  });
});
