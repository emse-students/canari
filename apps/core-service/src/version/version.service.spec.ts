import { VersionService } from './version.service';
import type { PlatformService } from '../platform/platform.service';

/**
 * The build identity is REPORTED beside the version, never folded into it.
 *
 * That separation is the whole subject of this file. The plan for the dev environment first
 * described the suffix as going into `/api/version`'s `version` field, and the frontend DECIDES on
 * that field: `compareSemver` parses it, `releaseTag` turns it into `vX.Y.Z`, and
 * `getReleaseApkDownloadUrl` builds a GitHub download URL from it. A `version` of
 * `0.14.15+dev.abc1234` would therefore have offered dev clients an update from the tag
 * `v0.14.15+dev.abc1234`, which is a 404.
 */
describe('VersionService', () => {
  const platform = {
    getConfig: jest.fn().mockResolvedValue({
      minClientVersion: '0.14.0',
      maintenanceEnabled: false,
      maintenanceMessage: null,
      callsMode: 'audio',
      livesMode: 'on',
      checkpointSkipMode: 'on',
      liveReplaysMode: 'on',
      groupCallsMode: 'mesh',
      callRelay: 'none',
      retentionReelDays: 365,
      retentionLiveReplayDays: 3,
      retentionChatReelDays: 14,
      retentionIdleMediaDays: 90,
    }),
  } as unknown as PlatformService;

  const service = new VersionService(platform);

  afterEach(() => {
    delete process.env.DEPLOY_BUILD;
  });

  it('publishes the calls kill switch, so a client hides what the server would refuse', async () => {
    const out = await service.getVersion();

    expect(out.calls).toEqual({ mode: 'audio', groupMode: 'mesh', relay: 'none' });
  });

  it('publishes the lives kill switch, so a client hides the live surfaces the server would refuse', async () => {
    const out = await service.getVersion();

    expect(out.lives).toEqual({ mode: 'on' });
  });

  it('publishes the checkpoint-skip switch, which the client alone enforces on its own durability', async () => {
    const out = await service.getVersion();

    expect(out.checkpointSkip).toEqual({ mode: 'on' });
  });

  it('publishes the live replays switch, which social-service enforces at the start of a live', async () => {
    const out = await service.getVersion();

    expect(out.liveReplays).toEqual({ mode: 'on' });
  });

  it('publishes the retention durations in force, which the privacy policy renders', async () => {
    const out = await service.getVersion();

    expect(out.retention).toEqual({
      reelDays: 365,
      liveReplayDays: 3,
      chatReelDays: 14,
      idleMediaDays: 90,
    });
  });

  it('says it forwards a PKCE verifier, so a client challenges only a server that will redeem it', async () => {
    const out = await service.getVersion();

    expect(out.oidcPkce).toBe(true);
  });

  it('says its gateway takes presence ids in a POST body, so a client sends them there only when it does', async () => {
    const out = await service.getVersion();

    expect(out.presencePost).toBe(true);
  });

  it('says its estate serves the background publish queue, so a client queues posts only when it does', async () => {
    const out = await service.getVersion();

    expect(out.publishQueue).toBe(true);
  });

  it('says its estate builds forms as drafts, so a form editor uses drafts only when it does', async () => {
    const out = await service.getVersion();

    expect(out.formDrafts).toBe(true);
    expect(out.rankedFeeds).toBe(true);
    expect(out.eventReach).toBe(true);
  });

  it('says its estate lets a respondent change their answer, so a client offers it only then', async () => {
    const out = await service.getVersion();

    expect(out.formAnswerEdit).toBe(true);
  });

  it("says its estate stores each priced grid's own switch, so a form client draws it only then", async () => {
    const out = await service.getVersion();

    expect(out.gridRequiredSwitch).toBe(true);
  });

  it('reports no build when the environment was not given one', async () => {
    delete process.env.DEPLOY_BUILD;

    const out = await service.getVersion();

    expect(out.build).toBeNull();
  });

  it('reports the build the deployment was given, without touching the version', async () => {
    process.env.DEPLOY_BUILD = 'dev.abc1234';

    const out = await service.getVersion();

    expect(out.build).toBe('dev.abc1234');
    // THE INVARIANT IS THAT `version` NAMES A RELEASE TAG THAT EXISTS, and a pre-release suffix
    // satisfies it while BUILD METADATA does not. `releaseTag` turns this field into `vX.Y.Z`, so a
    // `version` of `0.14.15+dev.abc1234` offered a download from `v0.14.15+dev.abc1234` - a 404,
    // which is the defect this test was written against. `0.15.0-alpha.1` IS a real release, tagged
    // by the deploy-at-bump chain, so `/^\d+\.\d+\.\d+$/` was the assertion being wider than its
    // reason: it forbade the legitimate shape along with the broken one. What must never appear is
    // the `+`.
    expect(out.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(out.version).not.toContain('+');
    expect(out.version).not.toContain('dev');
  });

  it('treats a blank build as absent rather than reporting an empty string', async () => {
    process.env.DEPLOY_BUILD = '   ';

    const out = await service.getVersion();

    expect(out.build).toBeNull();
  });
});
