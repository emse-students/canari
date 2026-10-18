/**
 * THE LISTS OF KEYS A REQUEST MAY WRITE, HELD AGAINST THE DTOs THEY SERVE (review of #2006).
 *
 * `BookingSpacesService` copies a body onto an entity by NAMED keys only, never by the body's own
 * keys. The cost of that is drift: a setting added to the DTO and forgotten in the list would be
 * accepted by validation and then silently never saved. So every property the DTO validates must be
 * in the list (or be the one converted on its own), and nothing else may be.
 */
import { getMetadataStorage } from 'class-validator';
import { RESOURCE_KEYS, SPACE_SETTING_KEYS } from './booking-spaces.service';
import { ResourceDto, SpaceSettingsDto } from './dto/space.dto';

/** The property names class-validator knows for a DTO class. */
function validatedProperties(target: new () => object): string[] {
  const metas = getMetadataStorage().getTargetValidationMetadatas(target, '', true, false);
  return [...new Set(metas.map((m) => m.propertyName))].sort();
}

describe('the keys a request may write', () => {
  it('a space: every setting of SpaceSettingsDto, opensAt and the poster converted on their own', () => {
    expect([...SPACE_SETTING_KEYS, 'opensAt', 'poster'].sort()).toEqual(
      validatedProperties(SpaceSettingsDto)
    );
  });

  it('a resource: every field of ResourceDto', () => {
    expect([...RESOURCE_KEYS].sort()).toEqual(validatedProperties(ResourceDto));
  });

  it('never an identity, an owner or a parent', () => {
    for (const forbidden of ['id', 'ownerId', 'associationId', 'spaceId', 'createdAt']) {
      expect(SPACE_SETTING_KEYS as readonly string[]).not.toContain(forbidden);
      expect(RESOURCE_KEYS as readonly string[]).not.toContain(forbidden);
    }
  });
});
