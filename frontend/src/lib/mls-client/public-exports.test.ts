import type { IMlsService } from '$lib/mls-client';
import {
  loadAndInitWasm,
  shouldAckAfterSuccess,
  shouldAckAfterException,
  logMlsMetric,
  initTabLeadershipAsync,
  getIsTabLeader,
  setupMessageHandler,
  initializeConnection,
  resolveMlsPublicUrls,
  assertOkMlsDeliveryResponse,
  deliveryKeepalivePost,
  MlsDeliveryApi,
  detectRuntimeDeviceOs,
} from '$lib/mls-client';

/** Ensures the barrel re-exports every symbol the app relies on. */
describe('$lib/mls-client public barrel', () => {
  it('exports types and functions without throwing on import', () => {
    expect(typeof loadAndInitWasm).toBe('function');
    expect(typeof shouldAckAfterSuccess).toBe('function');
    expect(typeof shouldAckAfterException).toBe('function');
    expect(typeof logMlsMetric).toBe('function');
    expect(typeof initTabLeadershipAsync).toBe('function');
    expect(typeof getIsTabLeader).toBe('function');
    expect(typeof setupMessageHandler).toBe('function');
    expect(typeof initializeConnection).toBe('function');
    expect(typeof resolveMlsPublicUrls).toBe('function');
    expect(typeof assertOkMlsDeliveryResponse).toBe('function');
    expect(typeof deliveryKeepalivePost).toBe('function');
    expect(typeof MlsDeliveryApi).toBe('function');
    expect(typeof detectRuntimeDeviceOs).toBe('function');
    const x = null as unknown as IMlsService;
    expect(x).toBeNull();
  });
});
