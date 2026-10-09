//! The relay-path call the dependency ceiling used to ask for, taken in-process.
//!
//! WHY THIS FILE EXISTS. `ci.yml`'s `Dependency ceiling` refused every `webrtc`-family update on
//! the grounds that "the SFU has ten tests and not one of them touches the ICE stack". Production
//! forces `iceTransportPolicy: relay` whenever it has a TURN server (see `create_peer_connection`
//! in `src/main.rs`), so the path that matters is: allocate on a TURN server, gather a RELAY
//! candidate, pair two relay candidates, run DTLS over the pair, move SCTP and SRTP across it.
//! This test does exactly that with the library's own TURN server on loopback - no network, no
//! credentials, no second process - and a failure in any layer (STUN/TURN allocation, ICE pairing,
//! DTLS handshake, SCTP data channel, SRTP media) is a failure here.
//!
//! WHAT IT DOES NOT COVER, so nobody mistakes the scope: it is one pair of peers, not the SFU's
//! forwarding logic (`main.rs` is a binary and this file links the library directly), and not a
//! browser. It is the part of "does a call connect" that a `webrtc` bump can break and that no
//! other gate here ever ran.
//!
//! THE TIMEOUTS ARE LIVENESS GUARDS ONLY. Each wait is event-driven (a channel the peer's callback
//! signals); the `timeout` exists so a hang fails instead of stalling CI, and it is asserted on
//! nothing else.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::time::timeout;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS};
use webrtc::api::setting_engine::SettingEngine;
use webrtc::api::APIBuilder;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::turn::auth::{generate_auth_key, AuthHandler};
use webrtc::turn::relay::relay_static::RelayAddressGeneratorStatic;
use webrtc::turn::server::config::{ConnConfig, ServerConfig};
use webrtc::turn::server::Server;
use webrtc::util::vnet::net::Net;

const REALM: &str = "canari.test";
const USER: &str = "relay-user";
const PASSWORD: &str = "relay-pass";
/// Generous on purpose: this bounds a hang, it never measures speed.
const LIVENESS: Duration = Duration::from_secs(30);

struct OneUser {
    key: Vec<u8>,
}

impl AuthHandler for OneUser {
    fn auth_handle(
        &self,
        username: &str,
        _realm: &str,
        _src_addr: SocketAddr,
    ) -> Result<Vec<u8>, webrtc::turn::Error> {
        if username == USER {
            Ok(self.key.clone())
        } else {
            Err(webrtc::turn::Error::ErrFakeErr)
        }
    }
}

/// A TURN server on a loopback UDP port, relaying on loopback.
async fn start_turn() -> (Server, SocketAddr) {
    let conn = Arc::new(
        UdpSocket::bind("127.0.0.1:0")
            .await
            .expect("bind turn socket"),
    );
    let addr = conn.local_addr().expect("turn address");
    let mut users = HashMap::new();
    users.insert(USER.to_owned(), generate_auth_key(USER, REALM, PASSWORD));
    let server = Server::new(ServerConfig {
        conn_configs: vec![ConnConfig {
            conn,
            relay_addr_generator: Box::new(RelayAddressGeneratorStatic {
                relay_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
                address: "127.0.0.1".to_owned(),
                net: Arc::new(Net::new(None)),
            }),
        }],
        realm: REALM.to_owned(),
        auth_handler: Arc::new(OneUser {
            key: users.remove(USER).expect("user key"),
        }),
        channel_bind_timeout: Duration::from_secs(0),
        alloc_close_notify: None,
    })
    .await
    .expect("start turn server");
    (server, addr)
}

/// A peer built the way the SFU builds its own: default codecs and interceptors, mDNS off, and
/// RELAY as the only transport policy, which is what production sets once it holds a TURN server.
async fn relay_peer(turn: SocketAddr) -> RTCPeerConnection {
    let mut media = MediaEngine::default();
    media.register_default_codecs().expect("default codecs");
    let registry =
        register_default_interceptors(Registry::new(), &mut media).expect("default interceptors");
    let mut settings = SettingEngine::default();
    settings.set_ice_multicast_dns_mode(MulticastDnsMode::Disabled);
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_setting_engine(settings)
        .build();
    api.new_peer_connection(RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec![format!("turn:{turn}?transport=udp")],
            username: USER.to_owned(),
            credential: PASSWORD.to_owned(),
        }],
        ice_transport_policy: RTCIceTransportPolicy::Relay,
        ..Default::default()
    })
    .await
    .expect("new peer connection")
}

/// Offer/answer with every candidate in the SDP (no trickle), so the exchange has no ordering to
/// get wrong and the only moving part is the library.
async fn negotiate(offerer: &RTCPeerConnection, answerer: &RTCPeerConnection) {
    let offer = offerer.create_offer(None).await.expect("create offer");
    let mut gathered = offerer.gathering_complete_promise().await;
    offerer
        .set_local_description(offer)
        .await
        .expect("offerer local description");
    let _ = timeout(LIVENESS, gathered.recv())
        .await
        .expect("offerer gathering timed out");
    let offer = offerer
        .local_description()
        .await
        .expect("offerer description");

    answerer
        .set_remote_description(offer)
        .await
        .expect("answerer remote description");
    let answer = answerer.create_answer(None).await.expect("create answer");
    let mut gathered = answerer.gathering_complete_promise().await;
    answerer
        .set_local_description(answer)
        .await
        .expect("answerer local description");
    let _ = timeout(LIVENESS, gathered.recv())
        .await
        .expect("answerer gathering timed out");
    let answer = answerer
        .local_description()
        .await
        .expect("answerer description");

    offerer
        .set_remote_description(answer)
        .await
        .expect("offerer remote description");
}

/// Two peers whose only possible path is the TURN relay exchange a data-channel message and an
/// SRTP audio packet.
#[tokio::test]
async fn two_peers_connect_through_a_turn_relay_and_carry_data_and_audio() {
    let (turn, turn_addr) = start_turn().await;
    let caller = relay_peer(turn_addr).await;
    let callee = relay_peer(turn_addr).await;

    // The media half: the caller sends opus, the callee must receive a packet of it.
    let track = Arc::new(TrackLocalStaticRTP::new(
        RTCRtpCodecCapability {
            mime_type: MIME_TYPE_OPUS.to_owned(),
            ..Default::default()
        },
        "audio".to_owned(),
        "canari-relay-test".to_owned(),
    ));
    caller
        .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
        .await
        .expect("add audio track");

    // The data half: SCTP over DTLS over the relayed ICE pair.
    let (data_tx, mut data_rx) = mpsc::channel::<String>(4);
    callee.on_data_channel(Box::new(move |channel| {
        let data_tx = data_tx.clone();
        Box::pin(async move {
            channel.on_message(Box::new(move |message| {
                let data_tx = data_tx.clone();
                Box::pin(async move {
                    let _ = data_tx
                        .send(String::from_utf8_lossy(&message.data).into_owned())
                        .await;
                })
            }));
        })
    }));
    let channel = caller
        .create_data_channel("relay", None)
        .await
        .expect("create data channel");
    let (open_tx, mut open_rx) = mpsc::channel::<()>(1);
    channel.on_open(Box::new(move || {
        let open_tx = open_tx.clone();
        Box::pin(async move {
            let _ = open_tx.send(()).await;
        })
    }));

    let (audio_tx, mut audio_rx) = mpsc::channel::<u16>(1);
    callee.on_track(Box::new(move |remote, _receiver, _transceiver| {
        let audio_tx = audio_tx.clone();
        Box::pin(async move {
            if let Ok((packet, _)) = remote.read_rtp().await {
                let _ = audio_tx.send(packet.header.sequence_number).await;
            }
        })
    }));

    let (state_tx, mut state_rx) = mpsc::channel::<RTCIceConnectionState>(8);
    caller.on_ice_connection_state_change(Box::new(move |state| {
        let state_tx = state_tx.clone();
        Box::pin(async move {
            let _ = state_tx.send(state).await;
        })
    }));

    negotiate(&caller, &callee).await;

    // Every candidate either side offered is a RELAY candidate - the policy held, so a pass cannot
    // be a direct path that merely happened to work.
    for (name, peer) in [("caller", &caller), ("callee", &callee)] {
        let sdp = peer
            .local_description()
            .await
            .expect("local description")
            .sdp;
        assert!(
            sdp.contains("typ relay"),
            "{name} gathered no relay candidate; SDP was:\n{sdp}"
        );
        assert!(
            !sdp.contains("typ host") && !sdp.contains("typ srflx"),
            "{name} offered a non-relay candidate under the relay policy; SDP was:\n{sdp}"
        );
    }

    timeout(LIVENESS, async {
        while let Some(state) = state_rx.recv().await {
            if state == RTCIceConnectionState::Connected {
                return;
            }
            assert_ne!(
                state,
                RTCIceConnectionState::Failed,
                "ICE failed over the relay"
            );
        }
    })
    .await
    .expect("ICE never connected over the relay");

    timeout(LIVENESS, open_rx.recv())
        .await
        .expect("data channel never opened (DTLS/SCTP over the relay)")
        .expect("open signal");
    channel
        .send_text("through-the-relay")
        .await
        .expect("send over the data channel");
    let received = timeout(LIVENESS, data_rx.recv())
        .await
        .expect("data message never arrived")
        .expect("data message");
    assert_eq!(received, "through-the-relay");

    // The packet is rewritten each time it is sent: the receiving track only exists once the first
    // SRTP packet has arrived, so one write is not enough to wake `on_track`.
    let sender = tokio::spawn({
        let track = Arc::clone(&track);
        async move {
            let mut sequence = 0u16;
            loop {
                let packet = Packet {
                    header: webrtc::rtp::header::Header {
                        version: 2,
                        payload_type: 111,
                        sequence_number: sequence,
                        timestamp: u32::from(sequence) * 960,
                        ..Default::default()
                    },
                    payload: vec![0xf8, 0xff, 0xfe].into(),
                };
                if track.write_rtp(&packet).await.is_err() {
                    break;
                }
                sequence = sequence.wrapping_add(1);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    });
    let audio = timeout(LIVENESS, audio_rx.recv()).await;
    sender.abort();
    audio
        .expect("no SRTP audio packet arrived over the relay")
        .expect("audio signal");

    assert_eq!(caller.connection_state(), RTCPeerConnectionState::Connected);
    caller.close().await.expect("close caller");
    callee.close().await.expect("close callee");
    turn.close().await.expect("close turn");
}
