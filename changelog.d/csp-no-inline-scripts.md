### Security - a stricter Content-Security-Policy on the web and in the native apps

Scripts run only from the app itself or by hash: no `'unsafe-inline'` or `'unsafe-eval'`, the web page's policy now written by SvelteKit and the native WebView given one at last ([cloudflare-edge](docs/wiki/infrastructure/cloudflare-edge.md#no-script-runs-unless-the-policy-names-it-2026-10-22)).
