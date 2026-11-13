### Changed - snapdom 3.7.2 and mediabunny 1.65.2; marked held at 18.1.1

marked 18.1.2 and later draw `x**b *c* d**` with stray asterisks where CommonMark draws a strong
around an em, so the toolbar fuzz failed on #3254. Dependabot skips marked `>= 18.1.2` until the new
CommonMark case in `composerFormatFuzz.test.ts` passes on a release (`.github/dependabot.yml`).
