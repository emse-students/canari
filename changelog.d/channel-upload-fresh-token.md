### Sending a file in a community no longer fails with "your session expired"

The salon upload reused the token copied at sign-in, which expires after 15 minutes (`401 JWT expired`). It now asks `getToken` at every send, like the DM path. Test: `useMessaging.channelUploadToken.svelte.test.ts`.
