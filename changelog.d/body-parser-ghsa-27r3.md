### Security - body-parser 2.4.0, multer 2.5.0 and fast-uri 3.1.9 in the four NestJS services

New advisories (GHSA-27r3-jxmh-p828 on body-parser, GHSA-q7qp-rjg7-q26m on multer, GHSA-w74x-v6f9-j3xg and GHSA-wjr9-j795-jxcr on fast-uri) turned every pull request's dependency audit red; each service now overrides the three to their fixed releases. See [cicd](docs/wiki/cicd.md#dependency-updates-and-the-auto-merge-that-ships-them).
