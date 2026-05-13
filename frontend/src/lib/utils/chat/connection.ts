/** Re-exports MLS connection helpers from `$lib/mls-client`. */
export {
  setupMessageHandler,
  initializeConnection,
  initTabLeadershipAsync,
  getIsTabLeader,
  type MessageHandlerDeps,
  type ConnectionDeps,
} from '$lib/mls-client';
