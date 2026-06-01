/** Re-exports MLS connection helpers from `$lib/mls-client`. */
export {
  setupMessageHandler,
  initializeConnection,
  openGatewayConnection,
  syncConnectionAfterWsOpen,
  initTabLeadershipAsync,
  getIsTabLeader,
  setTabLeaderPromotedHandler,
  type MessageHandlerDeps,
  type ConnectionDeps,
  type SyncAfterConnectDeps,
} from '$lib/mls-client';
