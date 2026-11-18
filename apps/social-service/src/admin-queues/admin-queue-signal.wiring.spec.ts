import 'reflect-metadata';
import { OPTIONAL_PROPERTY_DEPS_METADATA, PROPERTY_DEPS_METADATA } from '@nestjs/common/constants';
import { AssociationsService } from '../associations/associations.service';
import { LivesService } from '../lives/lives.service';
import { AdminQueueSignal } from './admin-queue-signal.service';

/**
 * The services that move a queue item themselves take the badges' signal by PROPERTY (their
 * hand-built specs need no new argument). This proves the wiring no boot spec does: each declares
 * the dependency, and NOT as optional - so Nest refuses to boot rather than run with silent badges.
 */
describe('AdminQueueSignal wiring', () => {
  it.each([
    ['AssociationsService', AssociationsService],
    ['LivesService', LivesService],
  ])('%s declares the signal as a required property dependency', (_name, service) => {
    const deps: { key: string; type: unknown }[] =
      Reflect.getMetadata(PROPERTY_DEPS_METADATA, service) ?? [];
    expect(deps).toContainEqual({ key: 'adminQueueSignal', type: AdminQueueSignal });
    const optional: string[] = Reflect.getMetadata(OPTIONAL_PROPERTY_DEPS_METADATA, service) ?? [];
    expect(optional).not.toContain('adminQueueSignal');
  });
});
