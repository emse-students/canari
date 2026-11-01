/**
 * `decryptData` calls a payload UNREADABLE for exactly two answers - a tag that does not verify
 * (WebCrypto's `OperationError`) and a plaintext that is not JSON (`SyntaxError`) - and rethrows
 * everything else as it is (review of #2824, D). The order-key derivation keys an unreadable row for
 * good and leaves any other failure for its next run, so a transient engine failure filed as
 * "unreadable" would freeze a row on its `sentAt` for ever.
 */
import { decryptData, encryptData, PayloadUnreadableError, sealBytes } from './encryption';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const OTHER_KEY = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

describe('decryptData - what counts as unreadable', () => {
  it('another key: unreadable', async () => {
    const sealed = await encryptData({ content: 'x' }, OTHER_KEY);
    await expect(decryptData(sealed.cipherText, sealed.iv, KEY)).rejects.toBeInstanceOf(
      PayloadUnreadableError
    );
  });

  it('a plaintext that is not JSON: unreadable', async () => {
    const sealed = await sealBytes(new TextEncoder().encode('not json {'), KEY);
    await expect(decryptData(sealed.cipherText, sealed.iv, KEY)).rejects.toBeInstanceOf(
      PayloadUnreadableError
    );
  });

  it('any other failure of the engine is rethrown as it is, never as unreadable', async () => {
    const sealed = await encryptData({ content: 'x' }, KEY);
    const engine = new TypeError('the engine went away');
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockRejectedValueOnce(engine);
    await expect(decryptData(sealed.cipherText, sealed.iv, KEY)).rejects.toBe(engine);
    decrypt.mockRestore();
  });
});
