## P3 - `[WS] Gateway connection failed: No address` is an ERROR with a stack while the phone is offline (1.6.8 logs, 2026-11-09)

target: 1.10.0

`mls-client/initializeConnection.ts` (~L271-285) already downgrades a gateway failure to one line when
the failure is a transport failure by TYPE or `connectivity.isOffline`. The native socket's own
rejection (`connectNativeSocket`, `services/nativeSocketConnect.ts`, from `NativeWebSocket.connect`)
is a bare string from the Rust plugin ("No address ..."), and the connectivity store has not yet
learned of the loss, so it falls to the `console.error` branch.

The fix belongs where the cause is known: the plugin must reject with a typed failure (a connect-phase
DNS or route failure versus a handshake the server answered), or `TauriMlsService` must wrap the
connect-phase rejection as `TransportFailureError` - which needs the plugin to say which phase
failed, because a handshake refused with an HTTP status is an ANSWER and must not be typed as no
answer. Reading the string is forbidden. Native-plugin change, so not done in the noise batch. The web
side of the same batch (`Failed to fetch presence`) was fixed at its catch.
