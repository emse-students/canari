import type { BackendStorageUsage } from './backendStorage';

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('$lib/utils/apiUrl', () => ({ deliveryUrl: () => 'https://delivery.test' }));

const { apiFetch } = await import('$lib/utils/apiFetch');
const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const { getBackendStorageUsage } = await import('./backendStorage');

describe('getBackendStorageUsage', () => {
  beforeEach(() => fetchMock.mockReset());

  it('fetches the admin storage endpoint and returns the parsed breakdown', async () => {
    const body: BackendStorageUsage = {
      diskTotalBytes: 100,
      diskUsedBytes: 40,
      postgresBytes: 20,
      redisBytes: 5,
      garageBytes: 15,
      garageObjectCount: 3,
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => body });

    const usage = await getBackendStorageUsage();

    expect(fetchMock).toHaveBeenCalledWith('https://delivery.test/api/mls/admin/storage');
    expect(usage).toEqual(body);
  });

  it('throws on a non-2xx response rather than returning a half-formed object', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });

    await expect(getBackendStorageUsage()).rejects.toThrow('HTTP 403');
  });
});
