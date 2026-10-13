/**
 * The export: what the file says about itself, and that it goes through the one save path every
 * download uses - user-initiated, never sent anywhere by the app.
 */
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppLogSnapshot } from './appLog';

const download = vi.fn<(source: string | Blob, fileName: string) => Promise<void>>();
vi.mock('./fileDownload', () => ({
  downloadDecryptedFile: (source: string | Blob, fileName: string) => download(source, fileName),
}));
vi.mock('./appVersion', () => ({
  getClientAppVersion: () => '1.2.7',
  currentUpdatePlatform: () => ({ android: true, ios: false, native: true }),
}));

const snapshot: AppLogSnapshot = {
  text: '2026-10-13 09:11:51.157 W [SELECT] 67fde7aa… dropped',
  lines: 1,
  droppedLines: 0,
  redactedValues: 3,
  persistence: 'ok',
  persistenceError: '',
};

describe('formatAppLogExport', () => {
  it('says what the file is, what it withheld and what it lacks, then the lines', async () => {
    const { formatAppLogExport } = await import('./appLogExport');
    const text = formatAppLogExport(snapshot, {
      version: '1.2.7',
      platform: 'android-app',
      exportedAt: new Date('2026-10-13T10:00:00Z'),
    });
    expect(text).toContain('# version 1.2.7 - android-app');
    expect(text).toContain('# 1 lines - 3 values redacted - 0 lines dropped');
    expect(text).toContain('# stored: ok\n');
    expect(text).toContain('Debug lines and workers are not recorded');
    expect(text.trimEnd().endsWith(snapshot.text)).toBe(true);
  });

  it('names a storage failure, so an empty log is not read as a quiet app', async () => {
    const { formatAppLogExport } = await import('./appLogExport');
    const text = formatAppLogExport(
      { ...snapshot, persistence: 'failed', persistenceError: 'QuotaExceededError: full' },
      { version: '1', platform: 'web', exportedAt: new Date() }
    );
    expect(text).toContain('# stored: failed (QuotaExceededError: full)');
  });
});

describe('appLogFileName', () => {
  it('carries the version and the local date, nothing about the member', async () => {
    const { appLogFileName } = await import('./appLogExport');
    expect(appLogFileName('1.2.7', new Date(2026, 9, 13, 9, 5))).toBe(
      'canari-log-1.2.7-20261013-0905.txt'
    );
  });
});

describe('exportAppLog', () => {
  beforeEach(() => {
    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    download.mockReset();
    download.mockResolvedValue(undefined);
  });

  it('hands the redacted log to the save path as a text file', async () => {
    const appLog = await import('./appLog');
    appLog.captureConsoleLine('warn', ['[QUEUE] stuck for jean@emse.fr']);
    const { exportAppLog } = await import('./appLogExport');

    await exportAppLog();

    expect(download).toHaveBeenCalledTimes(1);
    const [blob, name] = download.mock.calls[0];
    expect(name).toMatch(/^canari-log-1\.2\.7-\d{8}-\d{4}\.txt$/);
    const text = await (blob as Blob).text();
    expect(text).toContain('android-app');
    expect(text).toContain('W [QUEUE] stuck for [email]');
    expect(text).not.toContain('jean@emse.fr');
    appLog.discardAppLog();
  });
});
