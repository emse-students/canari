/**
 * `$lib/mls-client` - MLS runtime surface (types, queue policy, WASM load).
 * Import from `$lib/mls-client`; prefer not to deep-import internal paths from app code.
 */
export type {
  IMlsService,
  GroupMeta,
  UserGroupRow,
  MlsInitOptions,
  MlsBatchProcessResult,
  BulkIngestPhase,
  BulkIngestObserver,
} from './IMlsService';
export { MLS_LOCAL_STATE_UNDECRYPTABLE } from './IMlsService';
export { loadAndInitWasm } from './mlsWasmLoader';
export {
  shouldAckAfterSuccess,
  shouldAckAfterException,
  shouldAckGroupResetControl,
  type QueueMsgFlags,
} from './mlsQueueAckPolicy';
export { logMlsMetric, type MlsMetricEvent } from './mlsRecoveryMetrics';
export {
  isCatchupBenchEnabled,
  beginStartupCatchupBench,
  beginStartupCatchupPhase,
  endStartupCatchupPhase,
  updateStartupCatchupCounts,
  finishStartupCatchupBench,
  cancelStartupCatchupBench,
  beginQueueDrainBench,
  recordQueueDrainMessage,
  finishQueueDrainBench,
  recordPendingMessagesFetched,
  beginBulkUiFlushBench,
  finishBulkUiFlushBench,
  getCatchupBenchReports,
  getLatestCatchupBenchReport,
  clearCatchupBenchReports,
  summarizeConversationStats,
  formatCatchupBenchSummary,
  installCatchupBenchDevTools,
  type CatchupBenchReport,
  type CatchupBenchPhase,
} from './catchupBenchmark';

export {
  initTabLeadershipAsync,
  getIsTabLeader,
  setTabLeaderPromotedHandler,
  setTabLeaderDemotedHandler,
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
  MLS_ADD_LOCK_TTL_MS,
  MLS_REBOOT_LOCK_TTL_MS,
  type MlsDeliveryApiOptions,
  type MlsDeliveryFetch,
} from './mlsDeliveryApi';
export { detectRuntimeDeviceOs } from './mlsPlatform';
