import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The iPhone turns only on the video and camera screens (docs/wiki/frontend/screen-orientation.md).
 *
 * Nothing compiles `canari_ios.mm` on a workstation, and every half of the mechanism fails SILENTLY:
 * an Info.plist that lists portrait alone keeps every screen upright whatever the page asks, a lost
 * hook leaves tao's mask (every orientation but upside down) and turns the WHOLE app with the phone,
 * and a lost handler drops the page's requests on the floor. So the shape is pinned here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const APPLE = resolve(here, '../../../src-tauri/gen/apple');
const iosMm = readFileSync(resolve(APPLE, 'Sources/canari/canari_ios.mm'), 'utf8');
const plist = readFileSync(resolve(APPLE, 'canari_iOS/Info.plist'), 'utf8');

describe('iOS screen orientation (anti-regression)', () => {
  it('lets the iPhone scene turn, portrait first', () => {
    const iphone = plist.match(
      /<key>UISupportedInterfaceOrientations<\/key>\s*<array>([\s\S]*?)<\/array>/
    )?.[1];
    expect(iphone).toBeDefined();
    const listed = [...(iphone ?? '').matchAll(/<string>(\w+)<\/string>/g)].map((m) => m[1]);
    expect(listed).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ]);
  });

  it("gates the turn on tao's root view controller, portrait until a screen asks", () => {
    expect(iosMm).toContain('NSClassFromString(@"TaoUIViewController")');
    expect(iosMm).toContain('@selector(supportedInterfaceOrientations)');
    expect(iosMm).toContain(
      'static UIInterfaceOrientationMask g_canariOrientationMask = UIInterfaceOrientationMaskPortrait;'
    );
    // Installed at the launch, before the first scene is shown.
    expect(iosMm).toContain('CanariInstallOrientationHook(@"launch")');
    expect(iosMm).toContain('CanariInstallOrientationHook(@"scene connection")');
  });

  it('hears the page and forces landscape through a geometry request', () => {
    expect(iosMm).toContain('name:@"canariOrientation"];');
    expect(iosMm).toContain('setNeedsUpdateOfSupportedInterfaceOrientations');
    expect(iosMm).toContain('requestGeometryUpdateWithPreferences:');
    const page = readFileSync(resolve(here, './screenOrientation.svelte.ts'), 'utf8');
    expect(page).toContain('messageHandlers?.canariOrientation');
  });

  it('locks a take to the ONE orientation on screen, an iPad included', () => {
    // A frozen take mapped to `portrait` would be tao's free mask on an iPad, and to `landscape` would
    // still flip between the two landscape sides under the recording.
    expect(iosMm).toContain('[mode isEqualToString:@"locked"]');
    expect(iosMm).toContain('(UIInterfaceOrientationMask)(1 << now)');
    expect(iosMm).toMatch(
      /g_canariOrientationForcedOnIpad = \[mode isEqualToString:@"landscape"\] \|\| \[mode isEqualToString:@"locked"\];/
    );
  });

  it("publishes the notch's side to the page after every turn", () => {
    expect(iosMm).toContain("'--safe-area-inset-left'");
    expect(iosMm).toContain("'--safe-area-inset-right'");
    expect(iosMm).toContain('forKeyPath:@"effectiveGeometry"');
  });
});
