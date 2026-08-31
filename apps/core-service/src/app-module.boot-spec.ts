import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
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

  it('issues a real query through every entity the app registered', async () => {
    // THE GATE THAT RETIRES `typeorm` FROM THE AUTO-MERGE CEILING. The test above proves the schema
    // BUILDS - `forRootAsync` resolves, every entity's metadata is constructed, `synchronize` runs -
    // and stops there. The ORM ITSELF was never watched returning a row: all 1105 unit tests mock
    // their repositories, so a major that changed how a query is BUILT would pass every one of them
    // and fail in production on the first request.
    //
    // EVERY ENTITY, NOT A NAMED ONE. A gate that picks its subject by name does not cover the entity
    // nobody added to the list, and this repository has already paid for that shape. `find` builds a
    // SELECT through the metadata, the query builder and the driver, which is the whole path an ORM
    // major moves.
    const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });

    try {
      // `init` rather than `listen`: no request is made here, and binding a socket would be a second
      // reason for this test to fail.
      await app.init();

      const dataSource = app.get(DataSource, { strict: false });
      expect(dataSource.entityMetadatas.length).toBeGreaterThan(0);

      for (const metadata of dataSource.entityMetadatas) {
        // `take: 1` because the assertion is that the query RUNS, not what it returns - the schema
        // is freshly synchronised and every table is empty. A thrown query is the failure.
        await dataSource.getRepository(metadata.target).find({ take: 1 });
      }
    } finally {
      await app.close();
    }
  }, 120_000);
});
