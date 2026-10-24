### Security - the WebSocket services accept only an access token

chat-gateway and call-service now check the token's kind at the upgrade, as core-service does on its own routes ([chat-gateway](docs/wiki/services/chat-gateway.md#websocket-authentication)).
