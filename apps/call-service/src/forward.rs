//! The SFU's media plane on webrtc-rs 0.21: one published track fans out to one local track per
//! subscriber.
//!
//! WHY A FAN-OUT AND NOT ONE SHARED LOCAL TRACK. Up to 0.17 a `TrackLocalStaticRTP` could be added
//! to any number of peer connections and rewrote the SSRC and payload type per binding. In 0.21 a
//! local track is bound to exactly ONE connection (a second `add_track` replaces the first
//! binding), and the sender REJECTS a packet whose SSRC, payload type or header-extension ids are
//! not the ones negotiated on its own leg. So each subscriber gets its own local track, fed from a
//! broadcast of the publisher's packets, and this module rewrites what the leg requires.
//!
//! WHY AN INTERCEPTOR. Inbound RTCP stops at the end of the interceptor chain unless something
//! marks it for the application. A subscriber's PLI/FIR is the one RTCP packet the SFU must act on
//! (relay it to the publisher, which alone can produce a keyframe), so [`RtcpForwarderInterceptor`]
//! marks exactly those and drops the rest.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Instant;

use rtc::interceptor::{Attribute, Interceptor, Packet, StreamInfo, TaggedPacket};
use rtc::media_stream::MediaStreamTrack;
use rtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use rtc::sansio::Protocol;
use rtc::shared::error::Error as RtcError;
use tokio::sync::{broadcast, watch};
use tracing::{debug, info, warn};
use uuid::Uuid;
use webrtc::media_stream::track_local::static_rtp::TrackLocalStaticRTP;
use webrtc::media_stream::track_local::{TrackLocal, TrackLocalEvent};
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::peer_connection::PeerConnection;
use webrtc::rtp_transceiver::RtpSender;

/// Packets a lagging subscriber may fall behind by before it loses the oldest ones. A video track
/// carries a few hundred packets a second, so this is about a second of slack: enough to ride out
/// a scheduling hiccup, short enough that a stalled subscriber cannot hold memory.
const FANOUT_CAPACITY: usize = 512;

/// Passes inbound keyframe requests (PLI and FIR) to the application and drops every other inbound
/// RTCP packet. It must sit LAST in the chain, so every interceptor that reads RTCP has already
/// seen all of it.
#[derive(Default)]
pub struct RtcpForwarderInterceptor {
    read_queue: VecDeque<TaggedPacket>,
    write_queue: VecDeque<TaggedPacket>,
}

/// Whether an RTCP packet asks for a keyframe.
pub fn is_keyframe_request(packet: &dyn rtc::rtcp::Packet) -> bool {
    let any = packet.as_any();
    any.is::<PictureLossIndication>() || any.is::<FullIntraRequest>()
}

impl Protocol<TaggedPacket, TaggedPacket, ()> for RtcpForwarderInterceptor {
    type Rout = TaggedPacket;
    type Wout = TaggedPacket;
    type Eout = ();
    type Error = RtcError;
    type Time = Instant;

    fn handle_read(&mut self, mut msg: TaggedPacket) -> Result<(), Self::Error> {
        if let Packet::Rtcp(packets) = &msg.message.packet {
            let requests: Vec<Box<dyn rtc::rtcp::Packet>> = packets
                .iter()
                .filter(|p| is_keyframe_request(p.as_ref()))
                .cloned()
                .collect();
            if requests.is_empty() {
                // Receiver reports, NACKs and the like are for the interceptors, which have
                // already acted on them.
                return Ok(());
            }
            msg.message.packet = Packet::Rtcp(requests);
            msg.message.add(Attribute::DeliverToApplication);
        }
        self.read_queue.push_back(msg);
        Ok(())
    }

    fn poll_read(&mut self) -> Option<Self::Rout> {
        self.read_queue.pop_front()
    }

    fn handle_write(&mut self, msg: TaggedPacket) -> Result<(), Self::Error> {
        self.write_queue.push_back(msg);
        Ok(())
    }

    fn poll_write(&mut self) -> Option<Self::Wout> {
        self.write_queue.pop_front()
    }
}

impl Interceptor for RtcpForwarderInterceptor {
    fn bind_local_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_local_stream(&mut self, _info: &StreamInfo) {}
    fn bind_remote_stream(&mut self, _info: &StreamInfo) {}
    fn unbind_remote_stream(&mut self, _info: &StreamInfo) {}
}

/// A track being forwarded by the SFU, kept with a handle to its publisher so we can request
/// keyframes on demand (the SFU forwards opaque E2E-encrypted RTP and cannot detect when a
/// keyframe is needed).
pub struct PublishedTrack {
    /// The publisher's packets, fanned out to every subscriber's forwarder.
    packets: broadcast::Sender<rtp::Packet>,
    /// The publisher's remote track: the only way to send it RTCP. Writing fails once its
    /// connection is gone, which is what ends the keyframe loops.
    publisher: Arc<dyn TrackRemote>,
    /// Id every subscriber sees for this track.
    track_id: String,
    codec: RTCRtpCodec,
    kind: RtpCodecKind,
    /// SSRC of the publisher's remote track, used as the PLI media ssrc.
    pub media_ssrc: u32,
    pub is_video: bool,
    /// Last time a keyframe (PLI) was requested for this track. Shared by the on-demand
    /// forwarders and the periodic recovery net so they coalesce instead of both nudging.
    pub last_pli: Arc<std::sync::Mutex<Instant>>,
}

impl PublishedTrack {
    /// Describes a freshly received remote track. `None` when the track exposes no SSRC or codec,
    /// which leaves nothing to forward (the caller logs it).
    pub async fn from_remote(
        publisher: Arc<dyn TrackRemote>,
        track_id: String,
    ) -> Option<PublishedTrack> {
        let media_ssrc = publisher.ssrcs().await.first().copied()?;
        let codec = publisher.codec(media_ssrc).await?;
        let kind = publisher.kind().await;
        let (packets, _) = broadcast::channel(FANOUT_CAPACITY);
        Some(PublishedTrack {
            packets,
            publisher,
            track_id,
            codec,
            kind,
            media_ssrc,
            is_video: kind == RtpCodecKind::Video,
            last_pli: Arc::new(std::sync::Mutex::new(Instant::now())),
        })
    }

    /// Pumps the publisher's RTP into the fan-out until its track ends. Never interrupted by a
    /// slow subscriber: the broadcast drops that subscriber's oldest packets instead.
    pub fn spawn_publisher_pump(&self, label: String) {
        let publisher = Arc::clone(&self.publisher);
        let packets = self.packets.clone();
        tokio::spawn(async move {
            while let Some(event) = publisher.poll().await {
                if let webrtc::media_stream::track_remote::TrackRemoteEvent::OnRtpPacket(p) = event
                {
                    // No receiver yet (nobody subscribed) is normal, not a failure.
                    let _ = packets.send(p);
                }
            }
            info!("[forward] publisher track ended {}", label);
        });
    }

    /// Asks the publisher for a keyframe once. `false` when the publisher is gone.
    async fn request_keyframe(&self) -> bool {
        let sent = self
            .publisher
            .write_rtcp(vec![Box::new(PictureLossIndication {
                sender_ssrc: 0,
                media_ssrc: self.media_ssrc,
            })])
            .await
            .is_ok();
        if sent {
            mark_pli_sent(&self.last_pli);
        }
        sent
    }

    /// Asks a publisher for a video keyframe a few times over ~1.5 s. Needed when a new
    /// subscriber attaches to an already-running video track (it joined after the last keyframe
    /// and would otherwise only get undecodable delta frames). Stops once the publisher is gone.
    pub fn request_keyframe_burst(self: &Arc<Self>) {
        let track = Arc::clone(self);
        tokio::spawn(async move {
            for delay_ms in [0u64, 300, 800, 1500] {
                if delay_ms > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                }
                if !track.request_keyframe().await {
                    break;
                }
            }
        });
    }

    /// Slow recovery net: nudges one video keyframe from the publisher every few seconds.
    /// On-demand PLI forwarding is the primary mechanism, but a relayed PLI can itself be dropped
    /// on the lossy TURN path - leaving a subscriber frozen on its last decodable frame
    /// indefinitely (the classic "video freezes after ~2 s" on a constrained mobile uplink). A
    /// low-frequency timer bounds any freeze to a few seconds without the bandwidth cost or
    /// starvation of a fast periodic PLI. Spawned once per published video track; stops when the
    /// publisher is gone.
    pub fn spawn_periodic_keyframe_recovery(self: &Arc<Self>) {
        let track = Arc::clone(self);
        tokio::spawn(async move {
            let period = std::time::Duration::from_secs(3);
            let mut interval = tokio::time::interval(period);
            // First tick fires immediately; skip it (the initial keyframe burst covers t=0).
            interval.tick().await;
            loop {
                interval.tick().await;
                // Skip when an on-demand PLI was relayed within the last period: it already
                // refreshed the keyframe, so nudging again would waste relay bandwidth.
                let recent = track
                    .last_pli
                    .lock()
                    .map(|ts| ts.elapsed() < period)
                    .unwrap_or(false);
                if recent {
                    continue;
                }
                if !track.request_keyframe().await {
                    break;
                }
            }
        });
    }

    /// Attaches this track to one subscriber's connection: a local track of its own, and the task
    /// that feeds it. Returns once the track is added (the caller renegotiates). The leg forwards
    /// nothing until `gate` says its connection has negotiated AND connected.
    pub async fn subscribe(
        self: &Arc<Self>,
        pc: &Arc<dyn PeerConnection>,
        subscriber: &str,
        gate: watch::Receiver<LegGate>,
    ) -> webrtc::error::Result<()> {
        // Never zero: zero is "no SSRC" to several peers.
        let ssrc = (Uuid::new_v4().as_u128() as u32) | 1;
        let local = Arc::new(TrackLocalStaticRTP::new(MediaStreamTrack::new(
            "canari-sfu".to_owned(),
            self.track_id.clone(),
            self.track_id.clone(),
            self.kind,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                active: true,
                codec: self.codec.clone(),
                ..Default::default()
            }],
        )));
        let sender = pc
            .add_track(Arc::clone(&local) as Arc<dyn TrackLocal>)
            .await?;
        let leg = Leg {
            local,
            sender,
            ssrc,
            subscriber: subscriber.to_owned(),
        };
        let rx = self.packets.subscribe();
        let track = Arc::clone(self);
        tokio::spawn(async move { track.run_leg(leg, rx, gate).await });
        Ok(())
    }

    /// One subscriber's forwarding loop: publisher packets out, its keyframe requests back.
    /// Ends when its connection closes (the local track's event stream ends) or the publisher's
    /// fan-out is dropped.
    ///
    /// WHY THE GATE. In 0.21 `add_track` binds the track at once and `write_rtp` only queues the
    /// packet for the connection's driver, which refuses it later where no caller sees the error
    /// (an unnegotiated payload type: one error per packet; no SRTP context before DTLS: one
    /// warning per packet). So the loop does not read the leg's parameters, and does not write,
    /// until the connection has applied an offer/answer AND reached `Connected`, and it re-reads
    /// the parameters after EVERY applied offer/answer: a viewer that offers VP8 as payload type
    /// 120 gets 120, not the default 96 read before its offer arrived.
    async fn run_leg(
        &self,
        leg: Leg,
        mut rx: broadcast::Receiver<rtp::Packet>,
        mut gate: watch::Receiver<LegGate>,
    ) {
        let mut negotiated: Option<LegParams> = None;
        // Reported once per outage, with the count when it ends, never once per packet.
        let mut waiting = false;
        let mut dropped: u64 = 0;
        let mut lagging = false;
        loop {
            tokio::select! {
                received = rx.recv() => match received {
                    Ok(mut packet) => {
                        lagging = false;
                        let state = *gate.borrow();
                        if !state.ready() {
                            dropped += 1;
                            continue;
                        }
                        if negotiated.is_none() {
                            negotiated = LegParams::read(&leg.sender, &self.codec).await;
                        }
                        let Some(params) = &negotiated else {
                            dropped += 1;
                            if !waiting {
                                waiting = true;
                                warn!(
                                    "[forward] leg has no codec matching {} subscriber={} ssrc={} - dropping",
                                    self.codec.mime_type, leg.subscriber, leg.ssrc
                                );
                            }
                            continue;
                        };
                        if waiting {
                            info!(
                                "[forward] leg ready subscriber={} ssrc={} pt={} after {} dropped packet(s)",
                                leg.subscriber, leg.ssrc, params.payload_type, dropped
                            );
                            waiting = false;
                            dropped = 0;
                        }
                        params.rewrite(&mut packet, leg.ssrc);
                        if let Err(e) = leg.local.write_rtp(packet).await {
                            // The connection's driver is gone: nothing more will ever be written.
                            warn!(
                                "[forward] leg write failed subscriber={} ssrc={}: {}",
                                leg.subscriber, leg.ssrc, e
                            );
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // One report and one keyframe request per outage: lost packets leave the
                        // picture undecodable until the next keyframe.
                        if !lagging {
                            lagging = true;
                            warn!(
                                "[forward] subscriber={} fell {} packet(s) behind and lost them; asking for a keyframe",
                                leg.subscriber, n
                            );
                            if self.is_video {
                                self.request_keyframe().await;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                changed = gate.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    // A new offer/answer may have renumbered the payload types.
                    negotiated = None;
                }
                event = leg.local.poll() => match event {
                    Some(TrackLocalEvent::OnRtcpPacket(packets)) => {
                        if self.is_video && packets.iter().any(|p| is_keyframe_request(p.as_ref())) {
                            // A subscriber repeats its PLI until a keyframe lands: one request per
                            // window is enough, and the rest would only spend relay bandwidth.
                            if self.pli_recent(PLI_COALESCE) {
                                debug!("[keyframe] subscriber PLI coalesced ssrc={}", self.media_ssrc);
                            } else if !self.request_keyframe().await {
                                debug!("[keyframe] publisher gone ssrc={}", self.media_ssrc);
                            }
                        }
                    }
                    Some(_) => {}
                    None => break,
                },
            }
        }
        info!(
            "[forward] leg ended subscriber={} ssrc={} dropped_at_end={}",
            leg.subscriber, leg.ssrc, dropped
        );
    }

    /// Whether a keyframe was requested within `window`.
    fn pli_recent(&self, window: std::time::Duration) -> bool {
        self.last_pli
            .lock()
            .map(|ts| ts.elapsed() < window)
            .unwrap_or(false)
    }
}

/// How long a keyframe request already in flight covers further ones for the same track.
const PLI_COALESCE: std::time::Duration = std::time::Duration::from_millis(400);

/// What decides that a leg may carry media: its connection has applied an offer/answer (the
/// generation moves on EVERY one, so parameters are re-read) and has reached `Connected` (DTLS
/// done, so SRTP can protect). Owned by the peer, written by the signalling handlers and the
/// connection's event handler, watched by every leg of that peer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LegGate {
    /// Offers/answers applied so far; zero means none yet.
    pub generation: u64,
    /// The peer connection is `Connected`.
    pub connected: bool,
}

impl LegGate {
    fn ready(&self) -> bool {
        self.generation > 0 && self.connected
    }
}

/// What one subscriber leg is made of.
struct Leg {
    local: Arc<TrackLocalStaticRTP>,
    sender: Arc<dyn RtpSender>,
    ssrc: u32,
    subscriber: String,
}

/// What a leg negotiated, which a forwarded packet must carry.
struct LegParams {
    payload_type: u8,
    extension_ids: Vec<u8>,
}

impl LegParams {
    /// Reads the leg's negotiated payload type for the published codec and its header-extension
    /// ids. `None` when the leg has no matching codec.
    ///
    /// H264 is matched on its `fmtp` line only: two H264 codecs differing in packetization-mode or
    /// profile are not interchangeable, so a same-mime fallback would forward a stream the viewer
    /// cannot depacketize. Other codecs fall back to the first same-mime codec.
    async fn read(sender: &Arc<dyn RtpSender>, codec: &RTCRtpCodec) -> Option<LegParams> {
        let params = sender.get_parameters().await.ok()?;
        let same_mime = |c: &&rtc::rtp_transceiver::rtp_sender::RTCRtpCodecParameters| {
            c.rtp_codec.mime_type.eq_ignore_ascii_case(&codec.mime_type)
        };
        let codecs = &params.rtp_parameters.codecs;
        let exact = codecs
            .iter()
            .filter(same_mime)
            .find(|c| c.rtp_codec.sdp_fmtp_line == codec.sdp_fmtp_line);
        let chosen = if codec.mime_type.eq_ignore_ascii_case("video/H264") {
            exact?
        } else {
            exact.or_else(|| codecs.iter().find(same_mime))?
        };
        Some(LegParams {
            payload_type: chosen.payload_type,
            extension_ids: params
                .rtp_parameters
                .header_extensions
                .iter()
                .map(|e| e.id as u8)
                .collect(),
        })
    }

    /// Rewrites a publisher packet for this leg: its own SSRC and payload type, and only the
    /// header extensions whose ID the leg negotiated (the sender refuses any other).
    ///
    /// By id, not by URI: today the engine registers no header extension of its own, so this keeps
    /// nothing a browser's offer did not name, and the caveat that one id may mean different
    /// extensions on two legs is moot. The day an extension is registered, map by URI.
    fn rewrite(&self, packet: &mut rtp::Packet, ssrc: u32) {
        packet.header.ssrc = ssrc;
        packet.header.payload_type = self.payload_type;
        packet
            .header
            .extensions
            .retain(|e| self.extension_ids.contains(&e.id));
        if packet.header.extensions.is_empty() {
            packet.header.extension = false;
            packet.header.extensions_padding = 0;
        }
    }
}

/// Records that a keyframe was just requested, so the periodic recovery net can stay quiet while
/// on-demand PLIs are already flowing.
fn mark_pli_sent(last_pli: &Arc<std::sync::Mutex<Instant>>) {
    if let Ok(mut ts) = last_pli.lock() {
        *ts = Instant::now();
    }
}
