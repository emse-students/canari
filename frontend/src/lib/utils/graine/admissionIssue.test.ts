import { webCryptoEngine } from '$lib/crypto/graineV2.testEngine';
import {
  decodeAdmissionVoucher,
  encodeInviteLinkGrant,
  mintInviteLinkGrant,
} from '$lib/crypto/graineAdmission';
import { voucherFromInviteFragment } from './admissionIssue';

vi.mock('$lib/mls-client/platformGraineSignatureEngine', async () => {
  const { webCryptoEngine: engine } = await import('$lib/crypto/graineV2.testEngine');
  return { platformGraineSignatureEngine: () => engine };
});

/**
 * What a newcomer's device puts in the voucher it redeems: the subject in the ONE canonical form
 * (`canonicalUserId`, Rust's `to_ascii_lowercase`), the form every member compares it in. A user
 * id is printable ASCII without ':' (#2276), so that form lowercases its letters and nothing else.
 */

const DEVICE_SECRET = Uint8Array.from({ length: 32 }, (_, i) => 10 + i);

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('names the newcomer canonically, however the session spells them', async () => {
  const grant = await mintInviteLinkGrant(
    'ws-1',
    { userId: 'carol', deviceId: 'dev-c' },
    { keyGroupId: 'kg-1', epoch: 7 },
    1_800_000_000_000,
    1_900_000_000_000,
    webCryptoEngine,
    (m) => webCryptoEngine.signWithSessionKey(DEVICE_SECRET, m)
  );

  const voucher = decodeAdmissionVoucher(
    await voucherFromInviteFragment(encodeInviteLinkGrant(grant), 'ELODIE')
  );

  expect(voucher.subjectUserId).toBe('elodie');
});
