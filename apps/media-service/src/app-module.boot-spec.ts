import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * THE ONLY TEST IN THIS REPOSITORY THAT CONSTRUCTS THE REAL APPLICATION.
 *
 * `src/framework-boot.spec.ts` proves the HTTP framework packages cohere, but it boots a probe
 * module that imports nothing else, so every DYNAMIC module - `TypeOrmModule.forRoot`,
 * `ConfigModule.forRoot`, `ThrottlerModule`, `ScheduleModule` - is covered there only by the peer
 * range it declares. A major that keeps its peer range honest and changes what happens INSIDE one
 * of them passes that gate untouched. This one instantiates the actual `AppModule`: every provider
 * is resolved, every entity's metadata is built, the schema is synchronised against a real
 * Postgres, and a request travels the real router to a real controller.
 *
 * WHY THE ORDINARY SUITE DOES NOT RUN IT, AND WHY IT IS STILL RUN. This file needs a Postgres, a
 * Redis and an S3 endpoint that a developer typing `bun run test` does not have, so it must stay
 * out of that suite - but a test guarded by a skip is a test nobody executes, which this repository
 * already has a durable rule about, and a scaffold that read as coverage and never ran was deleted
 * from here on the same day. So it is excluded by NAME rather than by a condition: the unit config's
 * `testRegex` is `.*\.spec\.ts$`, which needs a literal dot before `spec` and therefore does not
 * match `.boot-spec.ts`, while `jest-boot.json` matches nothing else. It runs, always, in exactly
 * one place: the `boot-nest-apps` job in `ci.yml`, which brings the infrastructure with it.
 *
 * It sits in `src/` because `tsconfig.json` sets `rootDir: ./src` and anything outside is a compile
 * error, and it stays out of `dist/` because `tsconfig.build.json` excludes every file whose name
 * ends in `spec.ts` (the glob is not written out here: it contains the two characters that close a
 * block comment) - a file
 * that social-service and media-service did not have until this was added, which is why they had
 * been shipping 111 and 9 compiled test artefacts into their production images.
 *
 * WHY IT MAY DESTROY A DATABASE: the services set `synchronize: process.env.NODE_ENV !==
 * 'production'`, so booting CREATES and ALTERS the schema. It must only ever be pointed at a
 * throwaway database, which is what the service container in CI is.
 */
describe('the real AppModule boots', () => {
  it('constructs every module, answers on its health route, and shuts down', async () => {
    // `['error', 'warn']` rather than `false`: silent on a boot that works, and loud on one that
    // does not. `false` was the first draft and it made a failure undiagnosable - Nest swallows the
    // cause into its own logger, so the test reported only that `create` threw.
    const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    app.setGlobalPrefix('api');

    try {
      // Port 0 lets the OS choose - nothing here may depend on a port being free.
      await app.listen(0, '127.0.0.1');

      const { port } = app.getHttpServer().address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);

      expect(response.status).toBe(200);
    } finally {
      // Closing matters as much as opening: it is what proves the module's own shutdown hooks run,
      // and a leaked handle here is a leaked handle in production.
      await app.close();
    }
    // Generous, because this boot connects to Postgres and synchronises a schema. It is a ceiling
    // on a hang, not a wait anybody expects to use.
  }, 120_000);

  it('still has no ORM, which is why it carries no query gate', () => {
    // ITS THREE SIBLINGS RUN A REAL `find` THROUGH EVERY REGISTERED ENTITY HERE, and this service
    // does not, for one reason: it declares no `typeorm` and holds no entity. That is a fact about
    // today's manifest, not a law, so it is ASSERTED rather than left as a comment - the day someone
    // gives media-service a database, this fails and names the test that has to come with it.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies?.typeorm).toBeUndefined();
  });
});
