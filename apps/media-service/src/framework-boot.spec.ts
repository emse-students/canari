import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

/**
 * THE GATE THIS REPOSITORY DID NOT HAVE, AND THE ONE AN AUTOMATIC DEPENDENCY MERGE RESTS ON.
 *
 * On 2026-08-31 an auto-merge with no ceiling took `@nestjs/platform-express` from 11 to 12 into
 * two deployed services while `@nestjs/common` and `@nestjs/core` stayed at 11, and all three
 * gates said yes for three different reasons: a peer-dependency mismatch is a WARNING to bun and
 * never an error, `tsc` only checks the surface the code happens to use, and NO TEST ANYWHERE
 * INSTANTIATED A NEST APPLICATION - so the one object the mismatch lives inside was never built.
 * The first thing that would have said no was the post-deploy healthcheck, which is an outage.
 *
 * The two tests below are the two halves of "a framework moves as one piece":
 *
 *   1. The DECLARED half. Every `@nestjs/*` package states, in its own `peerDependencies`, which
 *      majors of `@nestjs/common` and `@nestjs/core` it was built against. Reading them is reading
 *      the warning bun printed and nobody saw. It covers every `@nestjs/*` package installed here,
 *      including the ones no boot could reach without a database.
 *   2. The OBSERVED half. `NestFactory.create` is what actually welds `@nestjs/core`'s injector to
 *      the HTTP adapter that `@nestjs/platform-express` provides, and no amount of type-checking
 *      substitutes for running it. The probe module below deliberately imports NOTHING but the
 *      three packages all four services share, so this file is identical everywhere and needs no
 *      database, no broker and no network.
 *
 * WHY THIS FILE IS DUPLICATED IN EACH SERVICE RATHER THAN FACTORED INTO ONE PLACE: the four
 * services are four independent bun packages with four `node_modules`. The subject of the test is
 * precisely WHICH VERSIONS THIS SERVICE RESOLVED, so a shared copy would answer for whichever tree
 * it happened to load and prove nothing about the other three.
 *
 * WHAT IT DOES NOT COVER, stated so nobody reads more into a green run than it earns: the probe
 * module boots no `TypeOrmModule`, so a database-layer incompatibility surfaces here only through
 * the declared half above. Booting the real `AppModule` needs a real Postgres and belongs to a
 * separate, infrastructure-bearing job.
 */

/** Minimal route, so the request below travels the real adapter rather than a mock. */
@Controller()
class BootProbeController {
  @Get('ping')
  ping(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [BootProbeController] })
class BootProbeModule {}

/** The packages whose majors must agree; every other `@nestjs/*` is checked against these. */
const CORE_PACKAGES = ['@nestjs/common', '@nestjs/core'] as const;

interface InstalledPackage {
  name: string;
  version: string;
  peerDependencies: Record<string, string>;
}

/**
 * Reads every installed `@nestjs/*` package's own manifest. This is the resolved tree, not the
 * declared range in our `package.json` - the difference between the two is where the incident was.
 */
function installedNestPackages(): InstalledPackage[] {
  const scope = join(__dirname, '..', 'node_modules', '@nestjs');
  return readdirSync(scope)
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(scope, dir, 'package.json'), 'utf8')) as {
        version: string;
        peerDependencies?: Record<string, string>;
      };
      return {
        name: `@nestjs/${dir}`,
        version: manifest.version,
        peerDependencies: manifest.peerDependencies ?? {},
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The majors a semver range admits, read as a set of leading numbers. Nest's peer ranges are
 * unions of carets (`^10.0.0 || ^11.0.0`), so the majors are the whole question and a full range
 * parser would be a dependency this test does not need.
 */
function majorsAccepted(range: string): Set<string> {
  return new Set(Array.from(range.matchAll(/(\d+)\.\d+\.\d+/g), (m) => m[1]));
}

/** The major of an exact installed version. */
function majorOf(version: string): string {
  return version.split('.')[0];
}

describe('the NestJS packages installed in this service cohere', () => {
  it('every @nestjs package accepts the @nestjs/common and @nestjs/core it will actually be given', () => {
    const installed = installedNestPackages();
    const byName = new Map(installed.map((p) => [p.name, p]));

    // A service that somehow lost one of these has a bigger problem than a version skew, and the
    // loop below would silently pass by finding nothing to compare.
    for (const core of CORE_PACKAGES) {
      expect(byName.get(core)).toBeDefined();
    }

    const violations: string[] = [];
    for (const pkg of installed) {
      for (const core of CORE_PACKAGES) {
        const range = pkg.peerDependencies[core];
        if (range === undefined) continue;
        const given = byName.get(core)!;
        const accepted = majorsAccepted(range);
        if (!accepted.has(majorOf(given.version))) {
          violations.push(
            `${pkg.name}@${pkg.version} wants ${core} ${range}, but ${given.version} is installed`
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('creates the express adapter, serves a request through it, and shuts down', async () => {
    // `logger: false` because a passing boot must be silent: a line a reader learns to skip is the
    // one that hides the next defect.
    const app = await NestFactory.create(BootProbeModule, { logger: false });
    app.setGlobalPrefix('api');

    try {
      // Port 0 lets the OS pick, so parallel jest workers and a busy developer machine cannot
      // collide - a test that depends on a free port is a test that fails for the wrong reason.
      await app.listen(0, '127.0.0.1');

      const address = app.getHttpServer().address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}/api/ping`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
