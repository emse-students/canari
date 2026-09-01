import { afterEach, describe, expect, it, vi } from 'vitest';
import { deployEnvironment, isNonProductionDeployment } from './deployEnvironment';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('deployEnvironment', () => {
  it('treats an unset variable as production, so a missing value never brands prod', () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', '');

    expect(deployEnvironment()).toBeNull();
    expect(isNonProductionDeployment()).toBe(false);
  });

  it.each(['development', 'dev', 'DEV', ' Development '])('recognises %j as dev', (value) => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', value);

    expect(deployEnvironment()).toBe('development');
    expect(isNonProductionDeployment()).toBe(true);
  });

  it.each(['production', 'prod', 'PRODUCTION'])('recognises %j as production', (value) => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', value);

    expect(deployEnvironment()).toBeNull();
  });

  /**
   * The banner's text is localised, so a value nobody planned for has no translation. Falling back
   * to production means such a value costs a MISSING banner on a non-production box - which whoever
   * is looking at it can see - rather than a banner shown to every member of production.
   */
  it('treats an unrecognised label as production rather than rendering it raw', () => {
    vi.stubEnv('VITE_DEPLOY_ENVIRONMENT', 'staging-eu-2');

    expect(deployEnvironment()).toBeNull();
    expect(isNonProductionDeployment()).toBe(false);
  });
});
