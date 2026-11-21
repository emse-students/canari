### Changed - the image scan names an `apk upgrade` its base no longer needs

For each image this repository builds, the scan now also reads the bare base and warns when a package the Dockerfile upgrades carries no fixable advisory there any more, so the line can go; the build context reader refuses the COPY forms it does not stage by name, and the release mapping and `no-cache` shape are asserted per image ([cicd](docs/wiki/cicd.md#container-images-are-scanned-2026-10-23)).
