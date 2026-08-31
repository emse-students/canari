# Kafka

**Image**: `confluentinc/cp-kafka:7.5.0` + `confluentinc/cp-zookeeper:7.5.0`
**Internal port**: 29092 (service-to-service)
**External port**: 9092 (canonical) / 9093 (dev host)

## What is actually on the bus: NOTHING, measured on prod 2026-08-31

**This page described an architecture that does not exist.** It claimed a `chat.messages` topic
produced and consumed by chat-delivery-service to trigger push notifications, and a `post_created`
topic produced by social-service. Neither was true, and the push path it credited to Kafka has never
gone anywhere near it - pushes are sent by `messaging.service.ts` over the single FCM gateway, see
[chat-delivery](../services/chat-delivery.md).

What the broker actually held, 42 hours into an uptime, with every service up:

```
$ kafka-topics --bootstrap-server localhost:29092 --list
__consumer_offsets                       <- Kafka's own, no application topic has ever existed

$ kafka-consumer-groups --bootstrap-server localhost:29092 --list
chat-delivery-consumer-server            <- removed by the change below; subscribed to nothing

$ kafka-consumer-groups --describe --group chat-gateway-broadcast
Error: Consumer group 'chat-gateway-broadcast' does not exist.
```

| Topic | Producer | Consumer | State |
|---|---|---|---|
| `post.created` | **nobody** | chat-gateway (`subscribers.rs`, group `chat-gateway-broadcast`) | the topic does not exist; the consumer logs `UnknownTopicOrPartition` at boot and receives nothing |
| `chat.messages` | - | - | never existed; this page invented it |

## chat-gateway consumer - live code, no traffic

`spawn_kafka_consumer` (`apps/chat-gateway/src/subscribers.rs:342`) subscribes to **`post.created`**
- a dot, not the underscore this page used to print - under group `chat-gateway-broadcast`, with
auto-commit disabled and manual offset commits after delivery (at-least-once). On each message it
would broadcast `{ type: "post_created", data: <payload> }` to every connected WebSocket client.

It works. Nothing produces the topic, so at boot it logs one line and then nothing:

```
INFO  [kafka] Subscribed to topic 'post.created' (at-least-once mode)
WARN  [kafka] Receive error: Message consumption error: UnknownTopicOrPartition
```

**Whether social-service should produce it, or the consumer should go, is an open question** - see
[backlog](../backlog.md).

## chat-delivery-service: no Kafka transport since 2026-08-31

It used to call `connectMicroservice({ transport: Transport.KAFKA })` in `main.ts` and had **never**
declared a single `@MessagePattern` or `@EventPattern`. Nest's `ServerKafka` still created and
connected a producer for handler replies, whose only send path is a reply to a handler that does not
exist - so it could not emit a record, and creating it printed the KafkaJS v2 partitioner warning on
every boot.

That warning is what sent anyone looking. The question it raised - *legacy partitioner or default?* -
had no answer, because **the producer could never send anything, keyed or otherwise**. Setting
`KAFKAJS_NO_PARTITIONER_WARNING=1` would have hidden the line and kept the producer; the transport
was removed instead, along with `@nestjs/microservices`, `kafkajs`, and the service's `KAFKA_BROKERS`
and `depends_on: kafka` in both compose files.

## Listener configuration

| Listener | Address | Use |
|---|---|---|
| `PLAINTEXT` | `kafka:29092` | Internal Docker network (service-to-service) |
| `PLAINTEXT_HOST` | `localhost:9092` (prod) / `localhost:9093` (dev) | Host machine access |

Services connect via the internal listener. **`docker-compose.dev.yml` points chat-gateway at
`kafka:29093`, which no listener binds** - the broker listens on `29092` internally and `9093` only
on the host interface. Prod is correct (`kafka:29092`). Nothing has noticed because nothing produces.

## Note on Zookeeper

Kafka 7.5 still requires Zookeeper. The `zookeeper` container runs on port 2181, internal only, and
no application code touches it.
