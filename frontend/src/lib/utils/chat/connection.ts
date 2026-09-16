/** Re-exports MLS connection helpers from `$lib/mls-client`. */
export {
  setupMessageHandler,
  initializeConnection,
  openGatewayConnection,
  startGatewayHandshake,
  syncConnectionAfterWsOpen,
  initTabLeadershipAsync,
  getIsTabLeader,
  setTabLeaderPromotedHandler,
  setTabLeaderDemotedHandler,
  requestLeadershipTakeover,
  releaseLeadership,
  type MessageHandlerDeps,
  type ConnectionDeps,
  type SyncAfterConnectDeps,
  type StartedHandshake,
} from '$lib/mls-client';
