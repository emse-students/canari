/**
 * Hands the in-app log ({@link ./appLog}) to the member, as a text file, when they ask for it.
 *
 * USER-INITIATED ONLY. Nothing calls this but the Settings > About button: the log is never sent,
 * uploaded or attached automatically. The file goes through the same save path as every other
 * download ({@link downloadDecryptedFile}): the browser's download on the web, the native save
 * dialog in the app (Android's document picker, iOS's Files picker, the desktop save panel), from
 * where the member sends it however they choose.
 *
 * Kept apart from `appLog.ts` because it imports the toast store and the messages, and `appLog.ts`
 * is loaded by `hooks.client.ts` before anything else.
 */
import { currentUpdatePlatform, getClientAppVersion } from './appVersion';
import { readAppLog, type AppLogSnapshot } from './appLog';
import { downloadDecryptedFile } from './fileDownload';

/** Which build this is, in the words a reader of the file needs - never the device model. */
function platformLabel(): string {
  const p = currentUpdatePlatform();
  if (p.android) return 'android-app';
  if (p.ios) return 'ios-app';
  return p.native ? 'desktop-app' : 'web';
}

/** `+02:00` for the device's current offset, so local stamps can be lined up with a server log. */
function utcOffset(now: Date): string {
  const minutes = -now.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * The file's text: a header saying what the log is and what it lacks, then the lines. Pure, so the
 * header is tested without a runtime.
 */
export function formatAppLogExport(
  snapshot: AppLogSnapshot,
  meta: { version: string; platform: string; exportedAt: Date }
): string {
  const header = [
    '# Canari in-app log',
    `# version ${meta.version} - ${meta.platform}`,
    `# exported ${meta.exportedAt.toISOString()} - local times below are UTC${utcOffset(meta.exportedAt)}`,
    `# ${snapshot.lines} lines - ${snapshot.redactedValues} values redacted - ${snapshot.droppedLines} lines dropped`,
    `# stored: ${snapshot.persistence}${snapshot.persistenceError ? ` (${snapshot.persistenceError})` : ''}`,
    '# levels: L log, I info, W warn, E error. Debug lines and workers are not recorded.',
    '',
  ];
  return `${header.join('\n')}${snapshot.text}\n`;
}

/** The suggested file name: version and local date, nothing about the member. */
export function appLogFileName(version: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `canari-log-${version}-${day}-${p(now.getHours())}${p(now.getMinutes())}.txt`;
}

/** Reads the log and offers it as a file. Failures are reported by the download wrapper. */
export async function exportAppLog(): Promise<void> {
  const snapshot = await readAppLog();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read once, never stored
  const now = new Date();
  const version = getClientAppVersion();
  console.info(`[APPLOG] exporting ${snapshot.lines} lines (${snapshot.text.length} chars)`);
  const text = formatAppLogExport(snapshot, {
    version,
    platform: platformLabel(),
    exportedAt: now,
  });
  await downloadDecryptedFile(
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
    appLogFileName(version, now)
  );
}
