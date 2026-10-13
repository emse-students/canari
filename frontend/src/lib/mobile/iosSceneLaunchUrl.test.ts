import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A link that LAUNCHES the iOS app must reach the deep-link plugin.
 *
 * Since tao 0.37 the app runs on the scene lifecycle, where a cold-start link arrives only in the
 * connection options of `scene:willConnectToSession:options:` - which tao's scene delegate ignores.
 * `canari_ios.mm` wraps that method and hands the options to the two methods tao implements for a
 * running app. Nothing compiles this file on a workstation, and losing the wrapper loses every
 * cold-start link silently (the app opens on its default page), so its shape is pinned here.
 * See docs/wiki/frontend/mobile.md#a-cold-start-on-the-scene-lifecycle-lost-its-link.
 */
const here = dirname(fileURLToPath(import.meta.url));
const iosMm = readFileSync(
  resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_ios.mm'),
  'utf8'
);

/** The body of the C function `name`, up to its closing brace at column 0. */
function functionBody(name: string): string {
  const start = iosMm.indexOf(`static void ${name}(`);
  expect(start, `${name} not found in canari_ios.mm`).toBeGreaterThanOrEqual(0);
  const end = iosMm.indexOf('\n}\n', start);
  return iosMm.slice(start, end);
}

describe('iOS cold-start launch url', () => {
  it('wraps the scene delegate tao registers', () => {
    const install = functionBody('CanariInstallSceneLaunchUrlHook');
    expect(install).toContain('NSClassFromString(@"TaoSceneDelegate")');
    expect(install).toContain('@selector(scene:willConnectToSession:options:)');
    expect(install).toContain('method_setImplementation');
  });

  it('installs the wrapper synchronously when launching finishes, before the scene connects', () => {
    // `queue:nil` runs the block on the posting thread at once; the main queue would run it after
    // UIKit had already connected the first scene and dropped the link.
    expect(iosMm).toMatch(
      /addObserverForName:UIApplicationDidFinishLaunchingNotification\s+object:nil\s+queue:nil\s+usingBlock:\^\(__unused NSNotification \*note\) \{\s+CanariInstallSceneLaunchUrlHook\(\);/
    );
  });

  it('lets tao start the app first, then hands it the launch urls and Universal Links', () => {
    const wrapper = functionBody('CanariSceneWillConnect');
    const original = wrapper.indexOf(
      'CanariOrigSceneWillConnect(self, _cmd, scene, session, options)'
    );
    const urls = wrapper.indexOf('scene:scene openURLContexts:urls');
    const activity = wrapper.indexOf('scene:scene continueUserActivity:activity');
    expect(original).toBeGreaterThanOrEqual(0);
    expect(urls).toBeGreaterThan(original);
    expect(activity).toBeGreaterThan(original);
    expect(wrapper).toContain('options.URLContexts');
    expect(wrapper).toContain('NSUserActivityTypeBrowsingWeb');
  });
});
