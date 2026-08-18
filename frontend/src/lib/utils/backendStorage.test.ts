import type { BackendStorageUsage, MediaBucketUsage } from './backendStorage';

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('$lib/utils/apiUrl', () => ({ deliveryUrl: () => 'https://delivery.test' }));

const { apiFetch } = await import('$lib/utils/apiFetch');
const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const { getBackendStorageUsage, classifyRetention, unreachableBytes } =
  await import('./backendStorage');

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY;
const SWEEP_MS = 60 * 60 * 1000;

function media(overrides: Partial<MediaBucketUsage> = {}): MediaBucketUsage {
  return {
    totalBytes: 1000,
    objectCount: 10,
    recentBytesByWeek: [400, 300, 200, 100],
    olderBytes: 0,
    undatedCount: 0,
    overdueCount: 0,
    overdueBytes: 0,
    overdueOldestMs: null,
    untrackedCount: 0,
    untrackedBytes: 0,
    tombstonedCount: 0,
    tombstonedBytes: 0,
    publicAssetCount: 0,
    publicAssetBytes: 0,
    retentionMs: RETENTION_MS,
    sweepIntervalMs: SWEEP_MS,
    ...overrides,
  };
}

describe('getBackendStorageUsage', () => {
  beforeEach(() => fetchMock.mockReset());

  it('fetches the admin storage endpoint and returns the parsed breakdown', async () => {
    const body: BackendStorageUsage = {
      diskTotalBytes: 100,
      diskUsedBytes: 40,
      postgresBytes: 20,
      redisBytes: 5,
      media: media(),
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

describe('classifyRetention', () => {
  it('calls nothing overdue healthy', () => {
    expect(classifyRetention(media())).toEqual({ kind: 'healthy' });
  });

  it('reads an object that expired minutes ago as waiting for the next sweep, not as a fault', () => {
    // Retention closes the moment the window elapses; the sweep runs on its own schedule. The gap
    // between those two events is the design, and calling it a fault would cry wolf every hour.
    const verdict = classifyRetention(
      media({ overdueCount: 2, overdueBytes: 50, overdueOldestMs: RETENTION_MS + 60_000 })
    );
    expect(verdict).toEqual({ kind: 'pending', count: 2, bytes: 50 });
  });

  it('calls it stalled once the oldest overdue object has outlived a whole sweep interval', () => {
    // A pass ran and did not take it. That is the only reading left.
    const oldest = RETENTION_MS + SWEEP_MS + 1;
    const verdict = classifyRetention(
      media({ overdueCount: 1, overdueBytes: 11, overdueOldestMs: oldest })
    );
    expect(verdict).toEqual({ kind: 'stalled', count: 1, bytes: 11, oldestMs: oldest });
  });

  it('never reports stalled without an age, since that is the evidence for the verdict', () => {
    // A missing oldest age cannot be treated as "very old": the panel would accuse the sweep on
    // the strength of a number the server did not send.
    const verdict = classifyRetention(
      media({ overdueCount: 3, overdueBytes: 9, overdueOldestMs: null })
    );
    expect(verdict.kind).toBe('pending');
  });
});

describe('unreachableBytes', () => {
  it('adds up what no sweep can ever reach, keeping both causes in the total', () => {
    // An object with no metadata entry is invisible to a sweep that iterates the metadata; a
    // tombstoned entry whose object survives is a delete that failed, and becomes the first case
    // once the tombstone is trimmed. Neither clears by waiting, so both belong in one number.
    expect(unreachableBytes(media({ untrackedBytes: 11_000_000, tombstonedBytes: 2_000 }))).toBe(
      11_002_000
    );
  });
});
