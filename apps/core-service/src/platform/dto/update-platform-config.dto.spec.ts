import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdatePlatformConfigDto } from './update-platform-config.dto';

/**
 * The calls kill switch takes exactly the three values the column's CHECK constraint allows
 * (migration 014): a fourth would pass the DTO and be refused by Postgres as a 500, so it is
 * refused here as a 400 instead.
 */
describe('UpdatePlatformConfigDto.callsMode', () => {
  const errorsFor = (callsMode: unknown) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { callsMode }));

  it.each(['off', 'audio', 'audio_video'])('accepts %s', async (mode) => {
    expect(await errorsFor(mode)).toHaveLength(0);
  });

  it.each(['on', 'testers', 'video', '', 'AUDIO'])('refuses %s', async (mode) => {
    const errors = await errorsFor(mode);
    expect(errors.map((e) => e.property)).toEqual(['callsMode']);
  });
});

/** The lives kill switch takes exactly the two values migration 015's CHECK allows. */
describe('UpdatePlatformConfigDto.livesMode', () => {
  const errorsFor = (livesMode: unknown) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { livesMode }));

  it.each(['off', 'on'])('accepts %s', async (mode) => {
    expect(await errorsFor(mode)).toHaveLength(0);
  });

  it.each(['ON', 'true', 'audio', '', 'viewers', true])('refuses %s', async (mode) => {
    const errors = await errorsFor(mode);
    expect(errors.map((e) => e.property)).toEqual(['livesMode']);
  });
});

/** The push switch takes exactly the two values migration 018's CHECK allows. */
describe('UpdatePlatformConfigDto.pushMode', () => {
  const errorsFor = (pushMode: unknown) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { pushMode }));

  it.each(['full', 'wake'])('accepts %s', async (mode) => {
    expect(await errorsFor(mode)).toHaveLength(0);
  });

  it.each(['WAKE', 'off', 'on', '', true])('refuses %s', async (mode) => {
    const errors = await errorsFor(mode);
    expect(errors.map((e) => e.property)).toEqual(['pushMode']);
  });
});

/** The checkpoint-skip switch takes exactly the two values migration 020's CHECK allows. */
describe('UpdatePlatformConfigDto.checkpointSkipMode', () => {
  const errorsFor = (checkpointSkipMode: unknown) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { checkpointSkipMode }));

  it.each(['off', 'on'])('accepts %s', async (mode) => {
    expect(await errorsFor(mode)).toHaveLength(0);
  });

  it.each(['ON', 'true', 'full', '', '100', true, 100])('refuses %s', async (mode) => {
    const errors = await errorsFor(mode);
    expect(errors.map((e) => e.property)).toEqual(['checkpointSkipMode']);
  });
});

/** The live replays switch takes exactly the two values migration 021's CHECK allows. */
describe('UpdatePlatformConfigDto.liveReplaysMode', () => {
  const errorsFor = (liveReplaysMode: unknown) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { liveReplaysMode }));

  it.each(['off', 'on'])('accepts %s', async (mode) => {
    expect(await errorsFor(mode)).toHaveLength(0);
  });

  it.each(['ON', 'true', 'always', '', true, 3])('refuses %s', async (mode) => {
    const errors = await errorsFor(mode);
    expect(errors.map((e) => e.property)).toEqual(['liveReplaysMode']);
  });
});

/** The mail switch takes exactly the two values migration 033's CHECK allows. */
describe('UpdatePlatformConfigDto.mailMode', () => {
  const errorsFor = (mailMode: unknown) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { mailMode }));

  it.each(['off', 'on'])('accepts %s', async (mode) => {
    expect(await errorsFor(mode)).toHaveLength(0);
  });

  it.each(['ON', 'true', 'always', '', true, 3])('refuses %s', async (mode) => {
    const errors = await errorsFor(mode);
    expect(errors.map((e) => e.property)).toEqual(['mailMode']);
  });
});

/** The group calls switch takes exactly the two values migration 022's CHECK allows. */
describe('UpdatePlatformConfigDto.groupCallsMode', () => {
  const errorsFor = (groupCallsMode: unknown) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { groupCallsMode }));

  it.each(['off', 'mesh'])('accepts %s', async (mode) => {
    expect(await errorsFor(mode)).toHaveLength(0);
  });

  it.each(['MESH', 'on', 'sfu', '', true, 3])('refuses %s', async (mode) => {
    const errors = await errorsFor(mode);
    expect(errors.map((e) => e.property)).toEqual(['groupCallsMode']);
  });
});

/** The call relay takes exactly the three values migration 026's CHECK allows. */
describe('UpdatePlatformConfigDto.callRelay', () => {
  const errorsFor = (callRelay: unknown) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { callRelay }));

  it.each(['none', 'call-service', 'cloudflare'])('accepts %s', async (relay) => {
    expect(await errorsFor(relay)).toHaveLength(0);
  });

  it.each(['Cloudflare', 'CALL-SERVICE', 'sfu', '', true, 1])('refuses %s', async (relay) => {
    const errors = await errorsFor(relay);
    expect(errors.map((e) => e.property)).toEqual(['callRelay']);
  });
});

/**
 * Each retention duration takes a whole number of days within its column's CHECK (migration 025):
 * a 0 would delete new content at the next sweep, and Postgres would refuse it as a 500.
 */
describe('UpdatePlatformConfigDto retention durations', () => {
  it.each([
    ['retentionReelDays', 1, 3650],
    ['retentionLiveReplayDays', 1, 365],
    ['retentionChatReelDays', 1, 365],
    ['retentionIdleFileDays', 1, 3650],
  ])('%s accepts %d to %d days and nothing else', async (key, min, max) => {
    const errorsFor = (value: unknown) =>
      validate(plainToInstance(UpdatePlatformConfigDto, { [key]: value }));
    expect(await errorsFor(min)).toHaveLength(0);
    expect(await errorsFor(max)).toHaveLength(0);
    for (const bad of [0, min - 1, max + 1, 1.5, '30', null, true]) {
      if (bad === null) continue;
      const errors = await errorsFor(bad);
      expect(errors.map((e) => e.property)).toEqual([key]);
    }
  });
});

/** The client floor takes `x.y.z` or `x.y.z-alpha.N` and nothing else: a typo is a 400, not a lockout. */
describe('UpdatePlatformConfigDto.minClientVersion', () => {
  const errorsFor = (minClientVersion: unknown) =>
    validate(plainToInstance(UpdatePlatformConfigDto, { minClientVersion }));

  it.each(['1.8.3', '0.0.0', '1.8.3-alpha.1', '1.8.3-alpha.12', '1.8.3-alpha.0'])(
    'accepts %s',
    async (version) => {
      expect(await errorsFor(version)).toHaveLength(0);
    }
  );

  it.each([
    '',
    '1.8',
    '1.8.3-',
    '1.8.3-alpha',
    '1.8.3-alpha.',
    '1.8.3-alpha.01',
    '1.8.3-beta.1',
    '1.8.3-rc.1',
    '1.8.3-alpha.1.2',
    '1.8.3+build',
    'v1.8.3',
    ' 1.8.3',
    'latest',
    130,
  ])('refuses %j', async (version) => {
    const errors = await errorsFor(version);
    expect(errors.map((e) => e.property)).toEqual(['minClientVersion']);
  });
});
