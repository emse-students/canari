import 'reflect-metadata';
import { OPTIONAL_PROPERTY_DEPS_METADATA, PROPERTY_DEPS_METADATA } from '@nestjs/common/constants';
import { AlumniDuplicateQueue } from './alumni-duplicate-queue.service';
import { AlumniMergeService } from './alumni-merge.service';
import { UsersService } from './users.service';
import { UsersModule } from './users.module';

/**
 * The two services that feed the Alumni duplicates' admin queue take their collaborator by PROPERTY
 * (their hand-built specs need no new argument). This proves the wiring no boot spec does: each
 * declares the dependency, NOT as optional - so Nest refuses to boot rather than run with a queue
 * nobody is told about. (The pattern of social-service's `admin-queue-signal.wiring.spec`.)
 */
describe('Alumni duplicate queue wiring', () => {
  it.each([
    ['AlumniMergeService', AlumniMergeService, 'queue', AlumniDuplicateQueue],
    ['UsersService', UsersService, 'alumniMerge', AlumniMergeService],
  ])('%s declares %s as a required property dependency', (_name, service, key, type) => {
    const deps: { key: string; type: unknown }[] =
      Reflect.getMetadata(PROPERTY_DEPS_METADATA, service) ?? [];
    expect(deps).toContainEqual({ key, type });
    const optional: string[] = Reflect.getMetadata(OPTIONAL_PROPERTY_DEPS_METADATA, service) ?? [];
    expect(optional).not.toContain(key);
  });

  it('the users module provides the queue the page, the sign-in and the mark all reach', () => {
    const providers: unknown[] = Reflect.getMetadata('providers', UsersModule) ?? [];
    expect(providers).toContain(AlumniDuplicateQueue);
  });
});
