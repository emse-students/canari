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
