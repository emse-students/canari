# Kafka

**Image**: `confluentinc/cp-kafka:7.5.0` + `confluentinc/cp-zookeeper:7.5.0`  
**Internal port**: 29092 (service-to-service)  
**External port**: 9092 (canonical) / 9093 (dev host)

## Topics

| Topic | Producer | Consumer | Payload type | Purpose |
|---|---|---|---|---|
| `chat.messages` | chat-delivery-service | chat-delivery-service (push notifications) | `MessageSentEvent` | Trigger FCM push for offline recipients |
| `post_created` | social-service | chat-gateway | `PostCreatedEvent` | Broadcast new post to all connected WebSocket clients |

## chat-gateway consumer

- Consumer group: `chat-gateway-broadcast`.
- Subscribes to `post_created`.
- On each message, broadcasts `{ type: "post_created", data: <post payload> }` to **all** connected WebSocket clients.
- Auto-commit disabled; offsets committed manually after delivery attempts (at-least-once semantics).
- Offset is committed even if no clients are connected (avoids replay storms after restart).

## chat-delivery-service consumer

- Subscribes to `chat.messages`.
- Triggers FCM push notifications for devices that are offline (not reachable via Redis pub/sub).
- This ensures messages are delivered even when the recipient is not connected.

## Listener configuration

Two listeners are configured in the Confluent Kafka image:

| Listener | Address | Use |
|---|---|---|
| `PLAINTEXT` | `kafka:29092` | Internal Docker network (service-to-service) |
| `PLAINTEXT_HOST` | `localhost:9093` | Host machine access (dev only) |

Services always connect via the internal listener (`kafka:29092`).

## Note on Zookeeper

Kafka 7.5 still requires Zookeeper. The `zookeeper` container runs on port 2181, internal only. No direct interaction is needed from application code.
