import { describe, expect, it } from 'vitest';
import {
  acceptFor,
  attachRuntimeFrom,
  attachSourcesFor,
  capturesFor,
  multipleFor,
  opensNatively,
  type AttachRuntime,
  type AttachSource,
} from './attachSources';

const facts = { iosApp: false, androidApp: false, os: 'web', narrow: true };

describe('attachRuntimeFrom', () => {
  it('names the apps by their compile-time target, whatever the width', () => {
    expect(attachRuntimeFrom({ ...facts, iosApp: true, narrow: false })).toBe('ios-app');
    expect(attachRuntimeFrom({ ...facts, androidApp: true })).toBe('android-app');
  });

  it('names a phone browser by its OS, and a wide window a desktop', () => {
    expect(attachRuntimeFrom({ ...facts, os: 'ios' })).toBe('ios-web');
    expect(attachRuntimeFrom({ ...facts, os: 'android' })).toBe('android-web');
    expect(attachRuntimeFrom({ ...facts, os: 'ios', narrow: false })).toBe('desktop');
    expect(attachRuntimeFrom({ ...facts, os: 'linux' })).toBe('desktop');
  });
});

describe('the one menu', () => {
  it('offers library, camera and files in the iOS app, and opens two of them natively', () => {
    expect(attachSourcesFor('ios-app')).toEqual(['library', 'camera', 'files']);
    expect(opensNatively('ios-app', 'library')).toBe(true);
    expect(opensNatively('ios-app', 'files')).toBe(true);
    // The camera stays a file input: with `capture`, WebKit opens the camera with no sheet.
    expect(opensNatively('ios-app', 'camera')).toBe(false);
  });

  it('offers two camera entries on Android, whose capture intents are photo OR video', () => {
    expect(attachSourcesFor('android-app')).toEqual([
      'library',
      'camera-photo',
      'camera-video',
      'files',
    ]);
    expect(attachSourcesFor('android-web')).toEqual(attachSourcesFor('android-app'));
  });

  it('draws no Canari menu where the system sheet is the menu, or on a desktop', () => {
    expect(attachSourcesFor('ios-web')).toEqual([]);
    expect(attachSourcesFor('desktop')).toEqual([]);
  });

  it('opens nothing natively outside the iOS app', () => {
    const others: AttachRuntime[] = ['android-app', 'android-web', 'ios-web', 'desktop'];
    for (const r of others) expect(opensNatively(r, 'library')).toBe(false);
  });
});

describe('the inputs', () => {
  it('asks for media only on the library and camera entries - which is what picks the picker', () => {
    expect(acceptFor('library')).toBe('image/*,video/*');
    expect(acceptFor('camera-photo')).toBe('image/*');
    expect(acceptFor('camera-video')).toBe('video/*');
    expect(acceptFor('files')).toContain('application/pdf');
  });

  it('captures, and takes one file, on the camera entries only', () => {
    const all: AttachSource[] = ['library', 'camera', 'camera-photo', 'camera-video', 'files'];
    expect(all.filter(capturesFor)).toEqual(['camera', 'camera-photo', 'camera-video']);
    expect(all.filter(multipleFor)).toEqual(['library', 'files']);
  });
});
