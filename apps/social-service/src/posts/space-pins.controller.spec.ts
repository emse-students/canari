/**
 * The pin routes validate their body: the global ValidationPipe validates only a body whose
 * `design:paramtypes` metatype is a class. A union typed in a way TypeScript serialises as `Object`
 * skips validation silently, and the required `spaceId` (floor `1.6.6`,
 * docs/wiki/legacy-compatibility.md) would then never be checked.
 */
import 'reflect-metadata';
import { PinPostDto } from './dto/post.dto';
import { SpacePinsController } from './space-pins.controller';

describe('SpacePinsController body metatype', () => {
  it.each(['pinPost', 'unpinPost'] as const)('%s declares PinPostDto as its body', (method) => {
    const types = Reflect.getMetadata(
      'design:paramtypes',
      SpacePinsController.prototype,
      method
    ) as unknown[];
    expect(types[3]).toBe(PinPostDto);
  });
});
