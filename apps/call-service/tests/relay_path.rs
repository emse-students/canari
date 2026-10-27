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
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use rtc::interceptor::Registry;
use rtc::media_stream::MediaStreamTrack;
use rtc::rtp;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::time::timeout;
use turn::auth::{generate_auth_key, AuthHandler};
use turn::relay::relay_static::RelayAddressGeneratorStatic;
use turn::server::config::{ConnConfig, ServerConfig};
use turn::server::Server;
use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::static_rtp::TrackLocalStaticRTP;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCConfigurationBuilder, RTCIceConnectionState, RTCIceGatheringState, RTCIceServer,
    RTCIceTransportPolicy, SettingEngineBuilder,
};
use webrtc_util::vnet::net::Net;

// The SFU's own forwarding module, compiled into this test: `main.rs` is a binary, and the
// fan-out is exactly what a webrtc bump can break.
#[path = "../src/forward.rs"]
#[allow(dead_code)]
mod forward;

const REALM: &str = "canari.test";
const USER: &str = "relay-user";
const PASSWORD: &str = "relay-pass";
/// Generous on purpose: this bounds a hang, it never measures speed.
const LIVENESS: Duration = Duration::from_secs(30);
const AUDIO_SSRC: u32 = 0x1234_5678;
const OPUS_PAYLOAD_TYPE: u8 = 111;

struct OneUser {
    key: Vec<u8>,
}

impl AuthHandler for OneUser {
    fn auth_handle(
        &self,
        username: &str,
        _realm: &str,
        _src_addr: SocketAddr,
    ) -> Result<Vec<u8>, turn::Error> {
        if username == USER {
            Ok(self.key.clone())
        } else {
            Err(turn::Error::ErrFakeErr)
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

/// What a peer reports, as channels the test waits on (event-driven: no polling, no sleeping).
struct Peer {
    gathered_tx: mpsc::Sender<()>,
    ice_tx: mpsc::Sender<RTCIceConnectionState>,
    data_tx: mpsc::Sender<String>,
    track_tx: mpsc::Sender<Arc<dyn TrackRemote>>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Peer {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered_tx.try_send(());
        }
    }

    async fn on_ice_connection_state_change(&self, state: RTCIceConnectionState) {
        let _ = self.ice_tx.send(state).await;
    }

    async fn on_data_channel(&self, channel: Arc<dyn DataChannel>) {
        let data_tx = self.data_tx.clone();
        tokio::spawn(async move {
            while let Some(event) = channel.poll().await {
                if let DataChannelEvent::OnMessage(message) = event {
                    let _ = data_tx
                        .send(String::from_utf8_lossy(&message.data).into_owned())
                        .await;
                }
            }
        });
    }

    async fn on_track(&self, remote: Arc<dyn TrackRemote>) {
        let _ = self.track_tx.send(remote).await;
    }
}

/// The first RTP packet a remote track delivers.
async fn first_packet(remote: &Arc<dyn TrackRemote>) -> rtp::Packet {
    while let Some(event) = remote.poll().await {
        if let TrackRemoteEvent::OnRtpPacket(packet) = event {
            return packet;
        }
    }
    panic!("the remote track ended before any RTP packet arrived");
}

struct Harness {
    pc: Arc<dyn PeerConnection>,
    gathered_rx: mpsc::Receiver<()>,
    ice_rx: mpsc::Receiver<RTCIceConnectionState>,
    data_rx: mpsc::Receiver<String>,
    track_rx: mpsc::Receiver<Arc<dyn TrackRemote>>,
}

/// A peer built the way the SFU builds its own: default codecs, mDNS off, and RELAY as the only
/// transport policy, which is what production sets once it holds a TURN server.
async fn relay_peer(turn: SocketAddr, registry: Registry) -> Harness {
    let (gathered_tx, gathered_rx) = mpsc::channel(1);
    let (ice_tx, ice_rx) = mpsc::channel(16);
    let (data_tx, data_rx) = mpsc::channel(4);
    let (track_tx, track_rx) = mpsc::channel(4);
    let handler = Arc::new(Peer {
        gathered_tx,
        ice_tx,
        data_tx,
        track_tx,
    });

    let mut media = MediaEngine::default();
    media.register_default_codecs().expect("default codecs");
    let settings = SettingEngineBuilder::new()
        .with_multicast_dns_mode(rtc::ice::mdns::MulticastDnsMode::Disabled)
        .build();
    let config = RTCConfigurationBuilder::new()
        .with_ice_servers(vec![RTCIceServer {
            urls: vec![format!("turn:{turn}?transport=udp")],
            username: USER.to_owned(),
            credential: PASSWORD.to_owned(),
        }])
        .with_ice_transport_policy(RTCIceTransportPolicy::Relay)
        .build();
    let pc = PeerConnectionBuilder::new()
        .with_configuration(config)
        .with_media_engine(media)
        .with_setting_engine(settings)
        .with_interceptor_registry(registry)
        .with_handler(handler as Arc<dyn PeerConnectionEventHandler>)
        // The socket the TURN client talks from; relay policy means it never offers a host path.
        .with_udp_addrs(vec!["127.0.0.1:0"])
        .build()
        .await
        .expect("new peer connection");
    Harness {
        pc: Arc::new(pc),
        gathered_rx,
        ice_rx,
        data_rx,
        track_rx,
    }
}

/// Offer/answer with every candidate in the SDP (no trickle), so the exchange has no ordering to
/// get wrong and the only moving part is the library.
async fn negotiate(offerer: &mut Harness, answerer: &mut Harness) {
    let offer = offerer.pc.create_offer(None).await.expect("create offer");
    offerer
        .pc
        .set_local_description(offer)
        .await
        .expect("offerer local description");
    timeout(LIVENESS, offerer.gathered_rx.recv())
        .await
        .expect("offerer gathering timed out");
    let offer = offerer
        .pc
        .local_description()
        .await
        .expect("offerer description");

    answerer
        .pc
        .set_remote_description(offer)
        .await
        .expect("answerer remote description");
    let answer = answerer
        .pc
        .create_answer(None)
        .await
        .expect("create answer");
    answerer
        .pc
        .set_local_description(answer)
        .await
        .expect("answerer local description");
    timeout(LIVENESS, answerer.gathered_rx.recv())
        .await
        .expect("answerer gathering timed out");
    let answer = answerer
        .pc
        .local_description()
        .await
        .expect("answerer description");

    offerer
        .pc
        .set_remote_description(answer)
        .await
        .expect("offerer remote description");
}

/// Two peers whose only possible path is the TURN relay exchange a data-channel message and an
/// SRTP audio packet.
#[tokio::test]
async fn two_peers_connect_through_a_turn_relay_and_carry_data_and_audio() {
    let (turn, turn_addr) = start_turn().await;
    let mut caller = relay_peer(turn_addr, Registry::new()).await;
    let mut callee = relay_peer(turn_addr, Registry::new()).await;

    // The media half: the caller sends opus, the callee must receive a packet of it.
    let track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
        "canari-relay-test".to_owned(),
        "audio".to_owned(),
        "audio".to_owned(),
        RtpCodecKind::Audio,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters {
                ssrc: Some(AUDIO_SSRC),
                ..Default::default()
            },
            active: true,
            codec: RTCRtpCodec {
                mime_type: "audio/opus".to_owned(),
                clock_rate: 48000,
                channels: 2,
                ..Default::default()
            },
            ..Default::default()
        }],
    )));
    caller
        .pc
        .add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
        .await
        .expect("add audio track");

    // The data half: SCTP over DTLS over the relayed ICE pair.
    let channel = caller
        .pc
        .create_data_channel("relay", None)
        .await
        .expect("create data channel");
    let (open_tx, mut open_rx) = mpsc::channel::<()>(1);
    let opener = Arc::clone(&channel);
    tokio::spawn(async move {
        while let Some(event) = opener.poll().await {
            if matches!(event, DataChannelEvent::OnOpen) {
                let _ = open_tx.send(()).await;
                return;
            }
        }
    });

    negotiate(&mut caller, &mut callee).await;

    // Every candidate either side offered is a RELAY candidate - the policy held, so a pass cannot
    // be a direct path that merely happened to work.
    for (name, peer) in [("caller", &caller), ("callee", &callee)] {
        let sdp = peer
            .pc
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
        while let Some(state) = caller.ice_rx.recv().await {
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
    let received = timeout(LIVENESS, callee.data_rx.recv())
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
                let packet = rtp::Packet {
                    header: rtp::header::Header {
                        version: 2,
                        payload_type: OPUS_PAYLOAD_TYPE,
                        sequence_number: sequence,
                        timestamp: u32::from(sequence) * 960,
                        ssrc: AUDIO_SSRC,
                        ..Default::default()
                    },
                    payload: vec![0xf8, 0xff, 0xfe].into(),
                };
                if track.write_rtp(packet).await.is_err() {
                    break;
                }
                sequence = sequence.wrapping_add(1);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    });
    let audio = timeout(LIVENESS, async {
        let remote = callee.track_rx.recv().await.expect("remote audio track");
        first_packet(&remote).await
    })
    .await;
    sender.abort();
    audio.expect("no SRTP audio packet arrived over the relay");

    caller.pc.close().await.expect("close caller");
    callee.pc.close().await.expect("close callee");
    turn.close().await.expect("close turn");
}

/// A registry that surfaces keyframe requests to the application, as the SFU's own does.
fn sfu_registry() -> Registry {
    Registry::new().with(
        rtc::interceptor::Slot::from(14_000),
        forward::RtcpForwarderInterceptor::default(),
    )
}

const VIDEO_SSRC: u32 = 0x0abc_def0;
const VP8_PAYLOAD_TYPE: u8 = 96;
const VIDEO_PAYLOAD: [u8; 5] = [0x10, 0x00, 0x9d, 0x01, 0x2a];

/// What the SFU adds to a call, end to end over the relay: one published video track is fanned out
/// to a subscriber on its OWN SSRC and the payload type that leg negotiated, and the subscriber's
/// keyframe request travels back to the publisher.
///
/// Four peers, all relay-only: publisher -> SFU ingest, SFU egress -> viewer. This is
/// `src/forward.rs` linked in, so a `webrtc` bump that changes what a local track accepts, what a
/// remote track delivers, or whether RTCP reaches the application fails here and not in a call.
#[tokio::test]
async fn the_sfu_fans_a_published_track_out_and_relays_a_keyframe_request_back() {
    use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
    use webrtc::media_stream::track_local::TrackLocalEvent;

    let (turn, turn_addr) = start_turn().await;
    let mut publisher = relay_peer(turn_addr, sfu_registry()).await;
    let mut sfu_in = relay_peer(turn_addr, sfu_registry()).await;
    let mut sfu_out = relay_peer(turn_addr, sfu_registry()).await;
    let mut viewer = relay_peer(turn_addr, Registry::new()).await;

    let pub_track = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
        "publisher-stream".to_owned(),
        "publisher-video".to_owned(),
        "video".to_owned(),
        RtpCodecKind::Video,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters {
                ssrc: Some(VIDEO_SSRC),
                ..Default::default()
            },
            active: true,
            codec: RTCRtpCodec {
                mime_type: "video/VP8".to_owned(),
                clock_rate: 90000,
                ..Default::default()
            },
            ..Default::default()
        }],
    )));
    publisher
        .pc
        .add_track(Arc::clone(&pub_track) as Arc<dyn TrackLocal>)
        .await
        .expect("add video track");
    negotiate(&mut publisher, &mut sfu_in).await;

    // The publisher keeps sending (the SFU's remote track only exists once SRTP arrives).
    let sender = tokio::spawn({
        let track = Arc::clone(&pub_track);
        async move {
            let mut sequence = 0u16;
            loop {
                let packet = rtp::Packet {
                    header: rtp::header::Header {
                        version: 2,
                        payload_type: VP8_PAYLOAD_TYPE,
                        sequence_number: sequence,
                        timestamp: u32::from(sequence) * 3000,
                        ssrc: VIDEO_SSRC,
                        ..Default::default()
                    },
                    payload: VIDEO_PAYLOAD.to_vec().into(),
                };
                if track.write_rtp(packet).await.is_err() {
                    break;
                }
                sequence = sequence.wrapping_add(1);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    });

    let ingest = timeout(LIVENESS, sfu_in.track_rx.recv())
        .await
        .expect("the SFU never received the published track")
        .expect("ingest track");
    let published = Arc::new(
        forward::PublishedTrack::from_remote(ingest, "sfu-track".to_owned())
            .await
            .expect("published track description"),
    );
    assert!(published.is_video, "a VP8 track must be described as video");
    published.spawn_publisher_pump("relay_path test".to_owned());

    published
        .subscribe(&sfu_out.pc, "viewer")
        .await
        .expect("subscribe the viewer's leg");
    negotiate(&mut sfu_out, &mut viewer).await;

    let viewed = timeout(LIVENESS, viewer.track_rx.recv())
        .await
        .expect("the viewer never received the forwarded track")
        .expect("viewer track");
    let packet = timeout(LIVENESS, first_packet(&viewed))
        .await
        .expect("no forwarded RTP packet reached the viewer");
    assert_ne!(
        packet.header.ssrc, VIDEO_SSRC,
        "the leg must carry its own SSRC, not the publisher's"
    );
    assert_eq!(
        packet.header.payload_type, VP8_PAYLOAD_TYPE,
        "the leg's negotiated VP8 payload type"
    );
    assert_eq!(
        packet.payload.as_ref(),
        &VIDEO_PAYLOAD,
        "the payload is forwarded untouched"
    );

    // The viewer asks for a keyframe; only the publisher can make one, so the request must reach it.
    viewed
        .write_rtcp(vec![Box::new(PictureLossIndication {
            sender_ssrc: 0,
            media_ssrc: packet.header.ssrc,
        })])
        .await
        .expect("viewer keyframe request");
    let relayed = timeout(LIVENESS, async {
        while let Some(event) = pub_track.poll().await {
            let TrackLocalEvent::OnRtcpPacket(packets) = event else {
                continue;
            };
            for packet in &packets {
                if let Some(pli) = packet.as_any().downcast_ref::<PictureLossIndication>() {
                    return pli.media_ssrc;
                }
            }
        }
        panic!("the publisher's track ended before a keyframe request arrived");
    })
    .await
    .expect("the viewer's keyframe request never reached the publisher");
    assert_eq!(
        relayed, VIDEO_SSRC,
        "the request names the publisher's stream"
    );

    sender.abort();
    for peer in [&publisher, &sfu_in, &sfu_out, &viewer] {
        peer.pc.close().await.expect("close peer");
    }
    turn.close().await.expect("close turn");
}
