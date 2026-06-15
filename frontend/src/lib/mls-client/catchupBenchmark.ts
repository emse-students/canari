/**
 * Catch-up duration benchmarking (startup sync, MLS queue drain, bulk UI flush).
 *
 * Enable structured reports:
 *   localStorage.setItem('canari_catchup_bench', '1')
 * then reload. In development, benchmarks also run when `import.meta.env.DEV` is true.
 *
 * DevTools console API (when enabled):
 *   window.__canariCatchupBench.getReports()
 *   window.__canariCatchupBench.getLatest('startup')
 *   window.__canariCatchupBench.clear()
 */
import type { Conversation } from '$lib/types';
import { isTauriRuntime } from '$lib/utils/openExternal';

/** Single timed step inside a catch-up session. */
export interface CatchupBenchPhase {
  name: string;
  durationMs: number;
  conversationCount?: number;
  messageCount?: number;
  meta?: Record<string, number | string>;
}

/** Aggregated catch-up benchmark report (one row per session). */
export interface CatchupBenchReport {
  id: string;
  kind: 'startup' | 'queue_drain' | 'bulk_ui_flush';
  platform: 'web' | 'tauri';
  startedAt: number;
  endedAt: number;
  durationMs: number;
  conversationCount: number;
  localMessageCount: number;
  pendingFetchedCount: number;
  messagesProcessed: number;
  messagesAcked: number;
  conversationsTouched: number;
  newMessagesIngested: number;
  /** durationMs / messagesProcessed when > 0. */
  msPerMessage: number | null;
  /** durationMs / conversationCount when > 0. */
  msPerConversation: number | null;
  /** Cumulative WASM `saveState` (Argon2) time during this session. */
  mlsSaveStateMs: number;
  /** Number of encrypted MLS checkpoints written during this session. */
  mlsSaveStateCount: number;
  phases: CatchupBenchPhase[];
}

interface ActivePhase {
  name: string;
  startedAt: number;
}

interface ActiveSession {
  id: string;
  kind: CatchupBenchReport['kind'];
  platform: 'web' | 'tauri';
  startedAt: number;
  phases: CatchupBenchPhase[];
  activePhase: ActivePhase | null;
  conversationCount: number;
  localMessageCount: number;
  pendingFetchedCount: number;
  messagesProcessed: number;
  messagesAcked: number;
  conversationsTouched: Set<string>;
  newMessagesIngested: number;
  mlsSaveStateMs: number;
  mlsSaveStateCount: number;
}

const MAX_REPORTS = 50;
const reports: CatchupBenchReport[] = [];

let activeStartup: ActiveSession | null = null;
let activeQueueDrain: ActiveSession | null = null;
let activeBulkFlush: ActiveSession | null = null;

/** Returns true when catch-up benchmarks should be recorded and logged. */
export function isCatchupBenchEnabled(): boolean {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('canari_catchup_bench') === '1') {
    return true;
  }
  return import.meta.env.DEV;
}

/** Counts conversations and in-memory messages from the reactive map. */
export function summarizeConversationStats(
  conversations: Iterable<Conversation> | Map<string, Conversation>
): { conversationCount: number; localMessageCount: number } {
  let conversationCount = 0;
  let localMessageCount = 0;
  for (const conv of conversations instanceof Map ? conversations.values() : conversations) {
    conversationCount += 1;
    localMessageCount += conv.messages?.length ?? 0;
  }
  return { conversationCount, localMessageCount };
}

function perfMark(label: string): void {
  if (!isCatchupBenchEnabled() || typeof performance === 'undefined') return;
  try {
    performance.mark(`canari:catchup:${label}`);
  } catch {
    /* ignore */
  }
}

function perfMeasure(name: string, startMark: string, endMark: string): void {
  if (!isCatchupBenchEnabled() || typeof performance === 'undefined') return;
  try {
    performance.measure(
      `canari:catchup:${name}`,
      `canari:catchup:${startMark}`,
      `canari:catchup:${endMark}`
    );
  } catch {
    /* ignore */
  }
}

function createSession(kind: CatchupBenchReport['kind']): ActiveSession {
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  perfMark(`${kind}:start`);
  return {
    id,
    kind,
    platform: isTauriRuntime() ? 'tauri' : 'web',
    startedAt: Date.now(),
    phases: [],
    activePhase: null,
    conversationCount: 0,
    localMessageCount: 0,
    pendingFetchedCount: 0,
    messagesProcessed: 0,
    messagesAcked: 0,
    conversationsTouched: new Set(),
    newMessagesIngested: 0,
    mlsSaveStateMs: 0,
    mlsSaveStateCount: 0,
  };
}

function beginPhase(session: ActiveSession, name: string): void {
  if (session.activePhase) endPhase(session);
  session.activePhase = { name, startedAt: Date.now() };
  perfMark(`${session.kind}:${name}:start`);
}

function endPhase(
  session: ActiveSession,
  extra?: Pick<CatchupBenchPhase, 'conversationCount' | 'messageCount' | 'meta'>
): void {
  const phase = session.activePhase;
  if (!phase) return;
  const durationMs = Date.now() - phase.startedAt;
  perfMark(`${session.kind}:${phase.name}:end`);
  perfMeasure(
    phase.name,
    `${session.kind}:${phase.name}:start`,
    `${session.kind}:${phase.name}:end`
  );
  session.phases.push({
    name: phase.name,
    durationMs,
    ...extra,
  });
  if (extra?.conversationCount !== undefined) {
    session.conversationCount = Math.max(session.conversationCount, extra.conversationCount);
  }
  if (extra?.messageCount !== undefined) {
    session.localMessageCount = Math.max(session.localMessageCount, extra.messageCount);
  }
  session.activePhase = null;
}

function mergeIntoStartup(patch: Partial<CatchupBenchReport>): void {
  if (!activeStartup) return;
  if (patch.pendingFetchedCount !== undefined) {
    activeStartup.pendingFetchedCount += patch.pendingFetchedCount;
  }
  if (patch.messagesProcessed !== undefined) {
    activeStartup.messagesProcessed += patch.messagesProcessed;
  }
  if (patch.messagesAcked !== undefined) {
    activeStartup.messagesAcked += patch.messagesAcked;
  }
  if (patch.newMessagesIngested !== undefined) {
    activeStartup.newMessagesIngested += patch.newMessagesIngested;
  }
  if (patch.conversationCount !== undefined) {
    activeStartup.conversationCount = Math.max(
      activeStartup.conversationCount,
      patch.conversationCount
    );
  }
  if (patch.localMessageCount !== undefined) {
    activeStartup.localMessageCount = Math.max(
      activeStartup.localMessageCount,
      patch.localMessageCount
    );
  }
}

function finalizeSession(session: ActiveSession): CatchupBenchReport {
  if (session.activePhase) endPhase(session);
  const endedAt = Date.now();
  perfMark(`${session.kind}:end`);
  perfMeasure(session.kind, `${session.kind}:start`, `${session.kind}:end`);

  const durationMs = endedAt - session.startedAt;
  const messagesDenominator =
    session.messagesProcessed > 0 ? session.messagesProcessed : session.newMessagesIngested;
  const report: CatchupBenchReport = {
    id: session.id,
    kind: session.kind,
    platform: session.platform,
    startedAt: session.startedAt,
    endedAt,
    durationMs,
    conversationCount: session.conversationCount,
    localMessageCount: session.localMessageCount,
    pendingFetchedCount: session.pendingFetchedCount,
    messagesProcessed: session.messagesProcessed,
    messagesAcked: session.messagesAcked,
    conversationsTouched: session.conversationsTouched.size,
    newMessagesIngested: session.newMessagesIngested,
    mlsSaveStateMs: Math.round(session.mlsSaveStateMs * 10) / 10,
    mlsSaveStateCount: session.mlsSaveStateCount,
    msPerMessage:
      messagesDenominator > 0 ? Math.round((durationMs / messagesDenominator) * 10) / 10 : null,
    msPerConversation:
      session.conversationCount > 0
        ? Math.round((durationMs / session.conversationCount) * 10) / 10
        : null,
    phases: session.phases,
  };

  reports.push(report);
  if (reports.length > MAX_REPORTS) reports.shift();

  if (isCatchupBenchEnabled()) {
    try {
      console.info('[CATCHUP][BENCH]', JSON.stringify(report));
    } catch {
      /* ignore */
    }
  }

  return report;
}

/** Formats a report as a single debug-log line. */
export function formatCatchupBenchSummary(report: CatchupBenchReport): string {
  const parts = [
    `[BENCH] ${report.kind}`,
    `${(report.durationMs / 1000).toFixed(2)}s`,
    `${report.conversationCount} conv`,
    `${report.localMessageCount} msgs locaux`,
  ];
  if (report.pendingFetchedCount > 0) parts.push(`${report.pendingFetchedCount} pending`);
  if (report.messagesProcessed > 0) parts.push(`${report.messagesProcessed} traités`);
  if (report.newMessagesIngested > 0) parts.push(`${report.newMessagesIngested} ingestés UI`);
  if (report.conversationsTouched > 0) parts.push(`${report.conversationsTouched} conv touchées`);
  if (report.msPerMessage !== null) parts.push(`${report.msPerMessage} ms/msg`);
  if (report.msPerConversation !== null) parts.push(`${report.msPerConversation} ms/conv`);
  if (report.mlsSaveStateCount > 0) {
    parts.push(`${report.mlsSaveStateMs} ms saveState (${report.mlsSaveStateCount}x)`);
  }
  return parts.join(' | ');
}

/** Starts timing the post-MLS startup catch-up (loginImpl). */
export function beginStartupCatchupBench(): void {
  if (!isCatchupBenchEnabled()) return;
  activeStartup = createSession('startup');
}

/** Opens a named phase on the active startup session. */
export function beginStartupCatchupPhase(name: string): void {
  if (!activeStartup) return;
  beginPhase(activeStartup, name);
}

/** Closes the current startup phase with optional counts. */
export function endStartupCatchupPhase(
  extra?: Pick<CatchupBenchPhase, 'conversationCount' | 'messageCount' | 'meta'>
): void {
  if (!activeStartup) return;
  endPhase(activeStartup, extra);
}

/** Updates aggregate counts on the startup session. */
export function updateStartupCatchupCounts(
  patch: Partial<
    Pick<
      CatchupBenchReport,
      | 'conversationCount'
      | 'localMessageCount'
      | 'pendingFetchedCount'
      | 'messagesProcessed'
      | 'messagesAcked'
      | 'newMessagesIngested'
    >
  >
): void {
  if (!activeStartup) return;
  if (patch.conversationCount !== undefined)
    activeStartup.conversationCount = patch.conversationCount;
  if (patch.localMessageCount !== undefined)
    activeStartup.localMessageCount = patch.localMessageCount;
  if (patch.pendingFetchedCount !== undefined) {
    activeStartup.pendingFetchedCount += patch.pendingFetchedCount;
  }
  if (patch.messagesProcessed !== undefined) {
    activeStartup.messagesProcessed += patch.messagesProcessed;
  }
  if (patch.messagesAcked !== undefined) activeStartup.messagesAcked += patch.messagesAcked;
  if (patch.newMessagesIngested !== undefined) {
    activeStartup.newMessagesIngested += patch.newMessagesIngested;
  }
}

/** Ends the startup session and returns the report (also logs when enabled). */
export function finishStartupCatchupBench(log?: (msg: string) => void): CatchupBenchReport | null {
  if (!activeStartup) return null;
  const session = activeStartup;
  activeStartup = null;
  const report = finalizeSession(session);
  log?.(formatCatchupBenchSummary(report));
  return report;
}

/** Cancels startup bench without recording (e.g. login failure). */
export function cancelStartupCatchupBench(): void {
  if (!activeStartup) return;
  if (activeStartup.activePhase) activeStartup.activePhase = null;
  activeStartup = null;
}

/** Starts queue-drain benchmarking when the MLS scheduler begins draining. */
export function beginQueueDrainBench(pendingCount: number): void {
  if (!isCatchupBenchEnabled()) return;
  activeQueueDrain = createSession('queue_drain');
  activeQueueDrain.pendingFetchedCount = pendingCount;
  beginPhase(activeQueueDrain, 'process_queue');
}

/** Records one processed queue item (optionally tagged with group id). */
export function recordQueueDrainMessage(groupId?: string): void {
  if (!activeQueueDrain) return;
  activeQueueDrain.messagesProcessed += 1;
  if (groupId) activeQueueDrain.conversationsTouched.add(groupId);
}

/** Ends queue-drain benchmarking and merges counts into an active startup session. */
export function finishQueueDrainBench(ackedCount: number): CatchupBenchReport | null {
  if (!activeQueueDrain) return null;
  activeQueueDrain.messagesAcked = ackedCount;
  const session = activeQueueDrain;
  activeQueueDrain = null;
  endPhase(session, { messageCount: session.messagesProcessed });
  const report = finalizeSession(session);
  mergeIntoStartup({
    messagesProcessed: report.messagesProcessed,
    messagesAcked: report.messagesAcked,
    pendingFetchedCount: report.pendingFetchedCount,
  });
  return report;
}

/** Records how many pending messages were fetched from the delivery API. */
export function recordPendingMessagesFetched(count: number): void {
  if (!isCatchupBenchEnabled() || count <= 0) return;
  updateStartupCatchupCounts({ pendingFetchedCount: count });
  if (activeQueueDrain) activeQueueDrain.pendingFetchedCount = count;
}

/** Starts bulk UI flush benchmarking (batchAddMessages at end of catch-up). */
export function beginBulkUiFlushBench(conversationCount: number, messageCount: number): void {
  if (!isCatchupBenchEnabled()) return;
  activeBulkFlush = createSession('bulk_ui_flush');
  activeBulkFlush.conversationCount = conversationCount;
  activeBulkFlush.newMessagesIngested = messageCount;
  beginPhase(activeBulkFlush, 'batch_add_messages');
}

/** Ends bulk UI flush benchmarking. */
export function finishBulkUiFlushBench(): CatchupBenchReport | null {
  if (!activeBulkFlush) return null;
  const session = activeBulkFlush;
  activeBulkFlush = null;
  endPhase(session, {
    conversationCount: session.conversationCount,
    messageCount: session.newMessagesIngested,
  });
  const report = finalizeSession(session);
  mergeIntoStartup({
    newMessagesIngested: report.newMessagesIngested,
    conversationCount: report.conversationCount,
  });
  return report;
}

/** Returns all recorded benchmark reports (newest last). */
export function getCatchupBenchReports(): readonly CatchupBenchReport[] {
  return reports;
}

/** Returns the most recent report for a kind, if any. */
export function getLatestCatchupBenchReport(
  kind?: CatchupBenchReport['kind']
): CatchupBenchReport | undefined {
  for (let i = reports.length - 1; i >= 0; i -= 1) {
    const r = reports[i];
    if (!kind || r.kind === kind) return r;
  }
  return undefined;
}

/** Records duration of a WASM `saveState` (encrypted checkpoint) call. */
export function recordMlsSaveStateMs(durationMs: number): void {
  if (!isCatchupBenchEnabled() || durationMs < 0) return;
  for (const session of [activeStartup, activeQueueDrain, activeBulkFlush]) {
    if (!session) continue;
    session.mlsSaveStateMs += durationMs;
    session.mlsSaveStateCount += 1;
  }
}

/** Clears in-memory benchmark history. */
export function clearCatchupBenchReports(): void {
  reports.length = 0;
}

declare global {
  interface Window {
    __canariCatchupBench?: {
      getReports: () => readonly CatchupBenchReport[];
      getLatest: (kind?: CatchupBenchReport['kind']) => CatchupBenchReport | undefined;
      clear: () => void;
      isEnabled: () => boolean;
    };
  }
}

/** Exposes `window.__canariCatchupBench` for manual inspection in DevTools. */
export function installCatchupBenchDevTools(): void {
  if (typeof window === 'undefined') return;
  window.__canariCatchupBench = {
    getReports: getCatchupBenchReports,
    getLatest: getLatestCatchupBenchReport,
    clear: clearCatchupBenchReports,
    isEnabled: isCatchupBenchEnabled,
  };
}
