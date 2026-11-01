import { describe, it, expect } from 'vitest';
import { fileInputAnswersEveryClose } from './fileInputCancel';

const androidWebView = (major: number) =>
  `Mozilla/5.0 (Linux; Android 11; M1908F1XE Build/RKQ1.200826.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${major}.0.0.0 Mobile Safari/537.36`;
const wkWebView = (major: number, minor: number) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${major}_${minor} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148`;

describe('fileInputAnswersEveryClose', () => {
  it('a Chromium from 113 answers every close; an older one is silent on an empty close', () => {
    expect(fileInputAnswersEveryClose(androidWebView(113))).toBe(true);
    expect(fileInputAnswersEveryClose(androidWebView(141))).toBe(true);
    expect(fileInputAnswersEveryClose(androidWebView(112))).toBe(false);
  });

  it('WebKit counts from 17, since its agent cannot tell 16.0 from 16.4', () => {
    expect(fileInputAnswersEveryClose(wkWebView(17, 0))).toBe(true);
    expect(fileInputAnswersEveryClose(wkWebView(16, 4))).toBe(false);
    expect(fileInputAnswersEveryClose(wkWebView(15, 7))).toBe(false);
  });

  it('Firefox answers from 91, and an unknown engine counts as silent', () => {
    expect(
      fileInputAnswersEveryClose(
        'Mozilla/5.0 (X11; Linux x86_64; rv:91.0) Gecko/20100101 Firefox/91.0'
      )
    ).toBe(true);
    expect(fileInputAnswersEveryClose('Mozilla/5.0 (X11; Linux x64) HappyDOM/0.0.0')).toBe(false);
  });
});
