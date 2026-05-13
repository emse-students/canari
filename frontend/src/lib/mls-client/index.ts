/**
 * `$lib/mls-client` — MLS runtime surface (types, queue policy, WASM load).
 * Import from `$lib/mls-client`; prefer not to deep-import internal paths from app code.
 */
export type { IMlsService, GroupMeta, UserGroupRow } from './IMlsService';
export { loadAndInitWasm } from './mlsWasmLoader';
export {
  shouldAckAfterSuccess,
  shouldAckAfterWebException,
  shouldAckAfterTauriGenericException,
  shouldAckGroupResetControl,
  type QueueMsgFlags,
} from './mlsQueueAckPolicy';
export { commitBaseEpochForValidation } from './mlsDesyncPrevention';
export { logMlsMetric, type MlsMetricEvent } from './mlsRecoveryMetrics';

export { initTabLeadershipAsync, getIsTabLeader } from './tabLeader';
export {
  setupMessageHandler,
  type MessageHandlerDeps,
} from './messagePipeline/setupMessageHandler';
export { initializeConnection, type ConnectionDeps } from './initializeConnection';
export {
  resolveMlsPublicUrls,
  assertOkMlsDeliveryResponse,
  deliveryKeepalivePost,
  type MlsPublicUrls,
} from './mlsDeliveryHttp';
export {
  MlsDeliveryApi,
  type MlsDeliveryApiOptions,
  type MlsDeliveryFetch,
} from './mlsDeliveryApi';
export { detectRuntimeDeviceOs } from './mlsPlatform';
