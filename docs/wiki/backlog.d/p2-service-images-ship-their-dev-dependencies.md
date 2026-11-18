## P2 - every service image ships its dev dependencies in the runtime stage

target: 1.7.1

Measured 2026-11-17, while the picomatch advisory was being traced
([what we ship](../cicd.md#the-audit-blocks-on-what-we-ship-2026-11-17)). The four NestJS
Dockerfiles (`infrastructure/local/Dockerfile.core-service`, `Dockerfile.social-service`,
`Dockerfile.media-service`, `Dockerfile.chat-delivery-service`) share one shape:

- the builder stage runs `bun install --frozen-lockfile` with no `--production`, because it needs
  `tsc` and `@nestjs/cli` to compile;
- the runtime stage then runs `COPY --from=builder .../node_modules ./node_modules`, so the image
  carries jest, `@nestjs/cli`, `@angular-devkit`, ts-jest and every other devDependency next to
  `dist/`.

`bun dist/main.js` never loads them, so the audit's production closure (`bun audit --prod`) is what
RUNS. But they are on the image's disk, they cost size and pull time, and the image scan reads them.
A production install in the runtime stage (or a second, `--production` install copied instead)
closes it. Check `media-service`'s `bun run build` and `social-service`'s extra build step still
have what they need in the builder, and add a check that the runtime `node_modules` holds no
devDependency, so the image cannot grow its tools back.
