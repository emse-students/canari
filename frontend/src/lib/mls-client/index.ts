/**
 * `$lib/mls-client` - MLS runtime surface (types, queue policy, WASM load).
 * Import from `$lib/mls-client`; prefer not to deep-import internal paths from app code.
 */
export type { IMlsService, GroupMeta, UserGroupRow } from './IMlsService';
export { loadAndInitWasm } from './mlsWasmLoader';
export {
  shouldAckAfterSuccess,
  shouldAckAfterException,
  shouldAckGroupResetControl,
  type QueueMsgFlags,
} from './mlsQueueAckPolicy';
export { commitBaseEpochForValidation } from './mlsDesyncPrevention';
export { logMlsMetric, type MlsMetricEvent } from './mlsRecoveryMetrics';

export {
  initTabLeadershipAsync,
  getIsTabLeader,
  setTabLeaderPromotedHandler,
  releaseLeadership,
  requestLeadershipTakeover,
} from './tabLeader';
export {
  setupMessageHandler,
  type MessageHandlerDeps,
} from './messagePipeline/setupMessageHandler';
export {
  initializeConnection,
  openGatewayConnection,
  syncConnectionAfterWsOpen,
  type ConnectionDeps,
  type SyncAfterConnectDeps,
} from './initializeConnection';
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
