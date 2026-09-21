//! Minimal protobuf helpers extracting what a decrypted `AppMessage` carries - the text a
//! notification shows, and the key material a background push must absorb before it can show one.
//!
//! Hand-rolled rather than generated: this runs in the push service, where the WebView and the
//! generated protobufjs codec do not exist. It reads the few fields a notification turns on and
//! walks past everything else, so a proto change it does not know about costs it nothing.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use crate::mobile::graine::GRAINE_SEED_BYTES;

/// Reads a protobuf varint from `bytes` at position `pos`.
/// Returns (value, next_position), or None if invalid.
pub fn read_varint(bytes: &[u8], pos: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    let mut cur = pos;
    loop {
        if cur >= bytes.len() || shift >= 64 {
            return None;
        }
        let byte = bytes[cur] as u64;
        result |= (byte & 0x7f) << shift;
        cur += 1;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    Some((result, cur))
}

/// Finds the first `field_num` field of wire type 2 (LEN) in `bytes`.
pub fn find_length_delimited_field(bytes: &[u8], field_num: u32) -> Option<Vec<u8>> {
    let mut pos = 0usize;
    while pos < bytes.len() {
        let (tag, after_tag) = read_varint(bytes, pos)?;
        let wire_type = tag & 0x7;
        let field = (tag >> 3) as u32;
        pos = after_tag;
        match wire_type {
            0 => {
                let (_, next) = read_varint(bytes, pos)?;
                pos = next;
            }
            1 => {
                if pos + 8 > bytes.len() {
                    return None;
                }
                pos += 8;
            }
            2 => {
                let (len, after_len) = read_varint(bytes, pos)?;
                pos = after_len;
                let end = pos + len as usize;
                if end > bytes.len() {
                    return None;
                }
                if field == field_num {
                    return Some(bytes[pos..end].to_vec());
                }
                pos = end;
            }
            5 => {
                if pos + 4 > bytes.len() {
                    return None;
                }
                pos += 4;
            }
            _ => return None,
        }
    }
    None
}

/// EVERY `field_num` field of wire type 2, in wire order - the repeated sibling of
/// [`find_length_delimited_field`].
///
/// Protobuf spells a repeated message as the same tag written N times, so the "first" reader above
/// silently answers a one-element view of an N-element list. That is the wrong answer for
/// `GraineBundleMsg.seeds`, where dropping every seed but the first would lose exactly the history
/// the bundle exists to carry, and it would lose it QUIETLY.
///
/// A malformed tail ends the scan and keeps what was already read: a bundle that was truncated in
/// transit still holds usable seeds up to the break, and refusing all of them would turn a partial
/// loss into a total one.
pub fn find_repeated_length_delimited_field(bytes: &[u8], field_num: u32) -> Vec<Vec<u8>> {
    let mut found = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        let Some((tag, after_tag)) = read_varint(bytes, pos) else {
            break;
        };
        let wire_type = tag & 0x7;
        let field = (tag >> 3) as u32;
        pos = after_tag;
        match wire_type {
            0 => match read_varint(bytes, pos) {
                Some((_, next)) => pos = next,
                None => break,
            },
            1 => {
                if pos + 8 > bytes.len() {
                    break;
                }
                pos += 8;
            }
            2 => {
                let Some((len, after_len)) = read_varint(bytes, pos) else {
                    break;
                };
                pos = after_len;
                let end = pos + len as usize;
                if end > bytes.len() {
                    break;
                }
                if field == field_num {
                    found.push(bytes[pos..end].to_vec());
                }
                pos = end;
            }
            5 => {
                if pos + 4 > bytes.len() {
                    break;
                }
                pos += 4;
            }
            _ => break,
        }
    }
    found
}

/// Finds the first `field_num` field of wire type 0 (varint) in `bytes`.
pub fn find_varint_field(bytes: &[u8], field_num: u32) -> Option<u64> {
    let mut pos = 0usize;
    while pos < bytes.len() {
        let (tag, after_tag) = read_varint(bytes, pos)?;
        let wire_type = tag & 0x7;
        let field = (tag >> 3) as u32;
        pos = after_tag;
        match wire_type {
            0 => {
                let (value, next) = read_varint(bytes, pos)?;
                if field == field_num {
                    return Some(value);
                }
                pos = next;
            }
            1 => {
                if pos + 8 > bytes.len() {
                    return None;
                }
                pos += 8;
            }
            2 => {
                let (len, after_len) = read_varint(bytes, pos)?;
                pos = after_len;
                let end = pos + len as usize;
                if end > bytes.len() {
                    return None;
                }
                pos = end;
            }
            5 => {
                if pos + 4 > bytes.len() {
                    return None;
                }
                pos += 4;
            }
            _ => return None,
        }
    }
    None
}

/// Builds a short French notification body for a decoded `SystemMsg`.
/// Returns None for silent/control events that should not produce a visible preview.
fn format_system_event_text(event: &str, data: &str) -> Option<String> {
    let data_json: serde_json::Value =
        serde_json::from_str(data).unwrap_or(serde_json::Value::Null);

    match event {
        "groupRenamed" => {
            let name = data_json
                .get("newName")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if name.is_empty() {
                Some("a renommé le groupe".to_string())
            } else {
                Some(format!("a renommé le groupe en « {name} »"))
            }
        }
        "groupImageChanged" => Some("a changé la photo du groupe".to_string()),
        "memberAdded" => {
            let count = data_json
                .get("newUsers")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .filter(|&n| n > 0)
                .or_else(|| data_json.get("newUser").and_then(|v| v.as_str()).map(|_| 1));
            match count {
                Some(1) => Some("a ajouté un membre au groupe".to_string()),
                Some(n) => Some(format!("a ajouté {n} membres au groupe")),
                None => Some("a ajouté un membre au groupe".to_string()),
            }
        }
        "memberRemoved" => Some("a retiré un membre du groupe".to_string()),
        "memberLeft" => Some("a quitté le groupe".to_string()),
        "groupDeleted" => Some("a supprimé la conversation".to_string()),
        // Control / sync frames: no user-visible notification preview.
        //
        // EVERY name the app can put in a `SystemMsg` and mean "machinery", because the fallback
        // arm below does not fail safe - it prints the raw event name to the user as "evenement de
        // groupe (history_digest)". Control frames are sent `silent` and a silent push returns
        // before this is reached, so the arm is a trap rather than live noise; the trap is that
        // ONE frame sent non-silent, or one server-side default flipped, turns the whole history
        // protocol into notifications. The list drifted once already: `read_watermark` replaced
        // `read_receipt` on 2026-08-12 and was never added here.
        "read_receipt"
        | "read_watermark"
        | "delete_message"
        | "edit_message"
        | "remove_reaction"
        | "pin"
        | "unpin"
        | "channel_invitation"
        | "history_bundle"
        | "history_coverage"
        | "history_digest"
        | "history_digest_request"
        | "history_pull"
        | "history_range"
        | "history_state" => None,
        _ => Some(format!("événement de groupe ({event})")),
    }
}

fn ok_message_json(
    text: String,
    message_id: String,
    sent_at: i64,
    msg_type: &str,
) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "text": text,
        "messageId": message_id,
        "sentAt": sent_at,
        "type": msg_type,
        "replyTo": null,
        "mediaKind": null
    })
}

/// Extracts the full metadata of a decrypted `AppMessage` protobuf for push display.
/// Every Graine seed an `AppMessage` carries, as `[{channelId, sessionId, seedB64, createdAt}]`.
///
/// TWO FIELDS, ONE SHAPE. A rotation arrives as a single `GraineMsg` (field 10); a catch-up arrives
/// as a `GraineBundleMsg` (field 12) whose `seeds` is a repeated `GraineMsg`. They differ only in
/// how many, so the caller is handed a list either way and never has to know which field it came
/// from - the alternative is two absorb paths, and the second one is the one that rots.
///
/// `None` when the message carries neither field. An EMPTY list is a different answer: the field
/// was there and held nothing usable, which is a malformed frame rather than an ordinary message.
///
/// A seed is skipped when it has no channel, no session, or no 32-byte seed - the three things
/// without which `derive_message_key` could not be called at all. `created_at` is passed through as
/// the proto states it, including absent-as-0: the mirror's bound sorts a session with no instant
/// oldest, which is where a frame that could not date itself belongs.
fn graine_seeds(bytes: &[u8]) -> Option<Vec<serde_json::Value>> {
    let single = find_length_delimited_field(bytes, 10);
    let bundle = find_length_delimited_field(bytes, 12);
    if single.is_none() && bundle.is_none() {
        return None;
    }

    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut absorb = |graine: &[u8]| {
        let channel_id = find_length_delimited_field(graine, 1)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        let session_id = find_length_delimited_field(graine, 2)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        let seed = find_length_delimited_field(graine, 3).unwrap_or_default();
        let created_at = find_varint_field(graine, 5).unwrap_or(0) as i64;
        if channel_id.is_empty() || session_id.is_empty() || seed.len() != GRAINE_SEED_BYTES {
            log::debug!(
                "[GRAINE_PUSH] unusable seed: channel={} session={} seed_len={}",
                !channel_id.is_empty(),
                !session_id.is_empty(),
                seed.len()
            );
            return;
        }
        out.push(serde_json::json!({
            "channelId": channel_id,
            "sessionId": session_id,
            "seedB64": BASE64.encode(&seed),
            "createdAt": created_at,
        }));
    };

    if let Some(graine) = &single {
        absorb(graine);
    }
    if let Some(bundle) = &bundle {
        for graine in find_repeated_length_delimited_field(bundle, 3) {
            absorb(&graine);
        }
    }
    Some(out)
}

pub fn extract_full_message_info(bytes: &[u8]) -> serde_json::Value {
    let message_id = find_length_delimited_field(bytes, 6)
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default();
    let sent_at = find_varint_field(bytes, 8).map(|v| v as i64).unwrap_or(0);

    if let Some(text_msg) = find_length_delimited_field(bytes, 1) {
        if let Some(content_bytes) = find_length_delimited_field(&text_msg, 1) {
            if let Ok(text) = String::from_utf8(content_bytes) {
                if !text.is_empty() {
                    return ok_message_json(text, message_id, sent_at, "text");
                }
            }
        }
    }

    if let Some(reply_msg) = find_length_delimited_field(bytes, 2) {
        let content = find_length_delimited_field(&reply_msg, 1)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        if !content.is_empty() {
            let reply_to = find_length_delimited_field(&reply_msg, 2).map(|ref_bytes| {
                let id = find_length_delimited_field(&ref_bytes, 1)
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_default();
                let sender_id = find_length_delimited_field(&ref_bytes, 2)
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_default();
                let preview = find_length_delimited_field(&ref_bytes, 3)
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_default();
                serde_json::json!({ "id": id, "senderId": sender_id, "preview": preview })
            });
            return serde_json::json!({
                "ok": true, "text": content, "messageId": message_id,
                "sentAt": sent_at, "type": "reply", "replyTo": reply_to, "mediaKind": null
            });
        }
    }

    if let Some(reaction_msg) = find_length_delimited_field(bytes, 3) {
        let emoji = find_length_delimited_field(&reaction_msg, 2)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        // Field 4 is `removed`: this frame TAKES a reaction back. It travels as the same message
        // that placed one - previously it was a `remove_reaction` system event, which this scanner
        // silences by name. Notifying here would ring the user for a reaction being withdrawn.
        let removed = find_varint_field(&reaction_msg, 4).unwrap_or(0) != 0;
        if !emoji.is_empty() && !removed {
            return ok_message_json(format!("a réagi {emoji}"), message_id, sent_at, "reaction");
        }
        if removed {
            return serde_json::json!({ "ok": false });
        }
    }

    if let Some(media_msg) = find_length_delimited_field(bytes, 4) {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let kind_str = match find_varint_field(&media_msg, 1) {
            Some(1) => "image",
            Some(2) => "video",
            Some(3) => "audio",
            _ => "file",
        };
        let caption = find_length_delimited_field(&media_msg, 8)
            .and_then(|b| String::from_utf8(b).ok())
            .filter(|s| !s.is_empty());
        let display_text = caption.unwrap_or_else(|| match kind_str {
            "image" => "\u{1f4f7} Photo".to_string(),
            "video" => "\u{1f3a5} Vid\u{00e9}o".to_string(),
            "audio" => "\u{1f3a4} Audio".to_string(),
            _ => "\u{1f4ce} Pi\u{00e8}ce jointe".to_string(),
        });
        // Media reference + CEK (WP-XP-3): the native notification builder downloads the opaque
        // ciphertext by `mediaId` and AES-256-GCM-decrypts it with `mediaKey`/`mediaIv` to attach a
        // thumbnail. key/iv are stored as raw proto `bytes`; base64-encode them for the JSON bridge
        // (the values never leave the device process). Only images/GIF are rendered downstream.
        let media_id = find_length_delimited_field(&media_msg, 2)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        let media_key = find_length_delimited_field(&media_msg, 3)
            .map(|b| STANDARD.encode(b))
            .unwrap_or_default();
        let media_iv = find_length_delimited_field(&media_msg, 4)
            .map(|b| STANDARD.encode(b))
            .unwrap_or_default();
        let mime_type = find_length_delimited_field(&media_msg, 5)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        return serde_json::json!({
            "ok": true, "text": display_text, "messageId": message_id,
            "sentAt": sent_at, "type": "media", "replyTo": null, "mediaKind": kind_str,
            "mediaId": media_id, "mediaKey": media_key, "mediaIv": media_iv, "mimeType": mime_type
        });
    }

    if let Some(system_msg) = find_length_delimited_field(bytes, 5) {
        let event = find_length_delimited_field(&system_msg, 1)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        let data = find_length_delimited_field(&system_msg, 2)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        if !event.is_empty() {
            if let Some(text) = format_system_event_text(&event, &data) {
                return ok_message_json(text, message_id, sent_at, "system");
            }
            return serde_json::json!({ "ok": false });
        }
    }

    if let Some(poll_msg) = find_length_delimited_field(bytes, 9) {
        let question = find_length_delimited_field(&poll_msg, 1)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        if !question.is_empty() {
            return ok_message_json(
                format!("\u{1f4ca} Sondage : {question}"),
                message_id,
                sent_at,
                "poll",
            );
        }
    }

    // Graine key material (fields 10-12): the community distribution group's traffic. It is never a
    // message and must never ring anybody. Stated here rather than left to the fall-through at the
    // end, because "unrecognised" and "deliberately silent" would otherwise be the same outcome to
    // read - and the next `kind` added to the proto would inherit silence by accident instead of by
    // decision.
    //
    // SILENT IS NOT THE SAME AS WORTHLESS, and reading it as such is what made a salon notification
    // blind for every message of a session minted while the app was shut. The seed reaches the
    // phone inside one of these frames; nothing extracted it, so `lookupGraineSeed` missed and the
    // banner fell back to "new message in #salon" until the app was next opened. So the frame still
    // rings nobody - `ok` stays FALSE, which is the whole of what the notification path reads - and
    // it now also states what it CARRIES, for the one caller whose job is to absorb it.
    if let Some(seeds) = graine_seeds(bytes) {
        return serde_json::json!({ "ok": false, "kind": "graine_key_material", "seeds": seeds });
    }
    if find_length_delimited_field(bytes, 11).is_some() {
        // A REQUEST carries no key material - it asks for some. Named rather than lumped in with
        // the unrecognised fall-through, so that "there was nothing to absorb" and "nobody looked"
        // stay different readings.
        return serde_json::json!({ "ok": false, "kind": "graine_request" });
    }
    if find_length_delimited_field(bytes, 12).is_some() {
        // A BUNDLE whose `seeds` list was empty or unreadable. `graine_seeds` above already took
        // every bundle that held anything.
        return serde_json::json!({ "ok": false, "kind": "graine_key_material", "seeds": [] });
    }

    // CallMsg (field 7, WP-XP-5): WebRTC signaling rides the same AppMessage channel.
    // An invite (offer_sdp present) becomes a typed "call_invite" so natives can show a
    // ringing notification (or dedupe against an already-ringing call_ring push); every
    // other payload (answer/ICE/hangup/answered) is pure signaling -> "call_control" with
    // `callEnded` set on hangup/answered so natives can cancel a ring instead of showing
    // the old generic "new message" fallback.
    if let Some(call_msg) = find_length_delimited_field(bytes, 7) {
        let call_id = find_length_delimited_field(&call_msg, 1)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        let has_video = find_varint_field(&call_msg, 6).unwrap_or(0) == 1;
        if find_length_delimited_field(&call_msg, 2).is_some() {
            let text = if has_video {
                "\u{1f4f9} Appel vid\u{00e9}o entrant".to_string()
            } else {
                "\u{1f4de} Appel entrant".to_string()
            };
            let mut info = ok_message_json(text, message_id, sent_at, "call_invite");
            info["callId"] = serde_json::json!(call_id);
            info["hasVideo"] = serde_json::json!(has_video);
            return info;
        }
        let ended = find_varint_field(&call_msg, 5).is_some() // hangup
            || find_varint_field(&call_msg, 7).is_some(); // answered (sibling pickup)
        let mut info = ok_message_json(String::new(), message_id, sent_at, "call_control");
        info["callId"] = serde_json::json!(call_id);
        info["callEnded"] = serde_json::json!(ended);
        return info;
    }

    serde_json::json!({ "ok": false })
}

// --- Minimal protobuf ENCODING (notification quick actions) ----------------
//
// The inverse of the read helpers above: builds a plaintext `AppMessage` proto (see
// libs/proto/canari.proto) from a notification action fired while the app may be fully killed
// (Android RemoteInput reply / mark-as-read, iOS UNNotificationAction). Proto3 field order does
// not matter for decoding, so this only has to be valid protobuf, not byte-identical to
// protobufjs's output - but the field numbers below MUST match canari.proto exactly.

/// Writes a protobuf varint (LEB128, 7 bits per byte, MSB = continuation).
fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

/// Writes a field tag: `(field_num << 3) | wire_type`, as a varint.
fn write_tag(out: &mut Vec<u8>, field_num: u32, wire_type: u8) {
    write_varint(out, ((field_num as u64) << 3) | wire_type as u64);
}

/// Writes a length-delimited field (wire type 2: bytes, string, or nested message).
fn write_bytes_field(out: &mut Vec<u8>, field_num: u32, bytes: &[u8]) {
    write_tag(out, field_num, 2);
    write_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn write_string_field(out: &mut Vec<u8>, field_num: u32, s: &str) {
    if !s.is_empty() {
        write_bytes_field(out, field_num, s.as_bytes());
    }
}

/// Wraps an already-encoded `oneof kind` member (e.g. `TextMsg`, `SystemMsg`) into a full
/// `AppMessage` envelope: `kind_field_num` (1=text, 5=system, ...) + `message_id` (field 6) +
/// `sent_at` (field 8). Proto3 omits zero-value fields, so an empty `message_id`/`sent_at=0`
/// (control events never set them - see `enqueueControlEvent` in messaging.ts) simply encodes
/// as absent, matching the TS encoder's output.
fn wrap_app_message(
    kind_field_num: u32,
    kind_bytes: &[u8],
    message_id: &str,
    sent_at: i64,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(kind_bytes.len() + message_id.len() + 24);
    write_bytes_field(&mut out, kind_field_num, kind_bytes);
    write_string_field(&mut out, 6, message_id);
    if sent_at != 0 {
        write_tag(&mut out, 8, 0);
        write_varint(&mut out, sent_at as u64);
    }
    out
}

/// Builds a plaintext `AppMessage{ text: TextMsg{ content } }` proto for a quick-reply sent from
/// a notification action (RemoteInput on Android, `UNTextInputNotificationAction` on iOS). Mirrors
/// `encodeAppMessage(mkText(content))` with `messageId`/`sentAt` set, exactly like a normal
/// composer send (`buildOutboxProto` in outbox.ts). The caller writes the returned bytes
/// (base64-encoded) straight into `outbox_pending.ndjson` so the existing background drain
/// (`drainOutboxBackground`/`CanariDrainOutboxBackground`) delivers it - no new send path.
pub fn build_text_app_message(message_id: &str, sent_at: i64, content: &str) -> Vec<u8> {
    let mut text_msg = Vec::with_capacity(content.len() + 8);
    write_string_field(&mut text_msg, 1, content);
    wrap_app_message(1, &text_msg, message_id, sent_at)
}

/// Builds a plaintext `AppMessage{ system: SystemMsg{ event: "read_watermark", data: {"at"} } }`
/// proto for the "mark as read" notification quick action, and for a quick reply - which means the
/// same thing, since a user who answered a conversation has read it.
///
/// AN INSTANT, NOT A LIST OF IDS, and that is the whole point of this function. The id-based
/// `read_receipt` this replaces was read out of `fcm_message_cache.ndjson`, which the app CLEARS at
/// every boot (`consumeFcmCache`), so "mark as read" from the shade sent nothing at all whenever
/// the app had been opened since the notification arrived - silently, because an empty id list is
/// indistinguishable from a conversation with nothing to acknowledge.
///
/// `at` MUST be the sender's `sent_at` for the message the notification is about, carried down from
/// the push, and never this device's clock: watermarks merge by `max` across devices, so a phone
/// whose clock runs fast would mark future messages read permanently and unfixably. That is the
/// same rule `watermarkAfterReading` (readState.ts) states for the foreground path.
///
/// `message_id`/`sent_at` on the envelope are left unset like every other control event
/// (`enqueueControlEvent` encodes the system message with no envelope fields). Sent `silent` by the
/// caller, so it reaches peers and our own other devices without ringing any of them.
/// Builds a `GraineMsg` body: channel 1, session 2, seed 3, created_at 5.
///
/// TEST-ONLY, AND SHARED, because `background.rs` proves the same seed over a REAL MLS frame and a
/// second encoder there could drift from this one - which is the whole failure mode a wire test is
/// meant to catch.
#[cfg(test)]
pub(crate) fn build_graine_msg(
    channel: &str,
    session: &str,
    seed: &[u8],
    created_at: i64,
) -> Vec<u8> {
    let mut g = Vec::new();
    write_string_field(&mut g, 1, channel);
    write_string_field(&mut g, 2, session);
    write_bytes_field(&mut g, 3, seed);
    write_tag(&mut g, 5, 0);
    write_varint(&mut g, created_at as u64);
    g
}

/// Wraps [`build_graine_msg`] as `AppMessage.graine` (field 10) - one rotation seed on the
/// wire, exactly as `seedDistribution.ts` sends it.
#[cfg(test)]
pub(crate) fn build_graine_app_message(
    channel: &str,
    session: &str,
    seed: &[u8],
    created_at: i64,
) -> Vec<u8> {
    let mut msg = Vec::new();
    write_bytes_field(
        &mut msg,
        10,
        &build_graine_msg(channel, session, seed, created_at),
    );
    msg
}

pub fn build_read_watermark_app_message(at: i64) -> Vec<u8> {
    let data = serde_json::json!({ "at": at }).to_string();
    let mut system_msg = Vec::with_capacity(data.len() + 24);
    write_string_field(&mut system_msg, 1, "read_watermark");
    write_string_field(&mut system_msg, 2, &data);
    wrap_app_message(5, &system_msg, "", 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_group_renamed_preview() {
        let text = format_system_event_text("groupRenamed", r#"{"newName":"Les Canaris"}"#)
            .expect("preview");
        assert!(text.contains("Les Canaris"));
    }

    #[test]
    fn system_member_added_preview() {
        let text = format_system_event_text("memberAdded", r#"{"newUsers":["u1","u2"]}"#)
            .expect("preview");
        assert!(text.contains("2 membres"));
    }

    #[test]
    fn silent_system_events_return_none() {
        assert!(format_system_event_text("read_receipt", "{}").is_none());
        assert!(format_system_event_text("delete_message", r#"{"messageId":"x"}"#).is_none());
    }

    #[test]
    fn build_text_app_message_roundtrips_through_extract() {
        let bytes = build_text_app_message("msg-123", 1_700_000_000_000, "hello quick reply");
        let info = extract_full_message_info(&bytes);
        assert_eq!(info["ok"], true);
        assert_eq!(info["type"], "text");
        assert_eq!(info["text"], "hello quick reply");
        assert_eq!(info["messageId"], "msg-123");
        assert_eq!(info["sentAt"], 1_700_000_000_000i64);
    }

    #[test]
    fn build_read_watermark_app_message_carries_the_instant_and_stays_silent() {
        let bytes = build_read_watermark_app_message(1_700_000_000_000);
        // Silent like every control frame: no preview may be fabricated for it.
        assert_eq!(extract_full_message_info(&bytes)["ok"], false);
        let system_msg = find_length_delimited_field(&bytes, 5).expect("system field present");
        let event = find_length_delimited_field(&system_msg, 1).unwrap();
        assert_eq!(String::from_utf8(event).unwrap(), "read_watermark");
        let data = find_length_delimited_field(&system_msg, 2).unwrap();
        let data_json: serde_json::Value = serde_json::from_slice(&data).unwrap();
        // The number, not a string: `systemMessageHandler` reads it as `Number(data.at)` and a
        // quoted instant would parse the same, which is exactly how such a drift stays invisible.
        assert_eq!(data_json["at"], serde_json::json!(1_700_000_000_000i64));
    }

    /// EVERY name the app can send as a system event must be classified, because the fallback arm
    /// prints the raw name at the user. This pins the list against `mkSystem` call sites in
    /// `messaging.ts` and `historySystemEvents.ts` - the drift it catches is a NEW event name
    /// shipped on the TypeScript side with nothing here taught about it.
    #[test]
    fn no_control_frame_previews_its_own_name() {
        for event in [
            "read_receipt",
            "read_watermark",
            "delete_message",
            "edit_message",
            "remove_reaction",
            "pin",
            "unpin",
            "channel_invitation",
            "history_bundle",
            "history_coverage",
            "history_digest",
            "history_digest_request",
            "history_pull",
            "history_range",
            "history_state",
        ] {
            assert!(
                format_system_event_text(event, "{}").is_none(),
                "{event} would be shown to the user as a notification"
            );
        }
    }

    #[test]
    fn placing_a_reaction_previews_it() {
        // ReactionMsg { message_id=1, emoji=2 } as AppMessage field 3.
        let mut reaction = Vec::new();
        write_string_field(&mut reaction, 1, "target-1");
        write_string_field(&mut reaction, 2, "\u{1f44d}");
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 3, &reaction);

        let info = extract_full_message_info(&msg);
        assert_eq!(info["ok"], true);
        assert_eq!(info["type"], "reaction");
        assert!(info["text"].as_str().unwrap().contains("\u{1f44d}"));
    }

    #[test]
    fn taking_a_reaction_back_previews_nothing() {
        // Both legs are now the same frame - `removed` (field 4) is the only difference. Before
        // that, taking one back was a `remove_reaction` system event, which this scanner silences
        // by name; without reading field 4 the same withdrawal would ring the user.
        let mut reaction = Vec::new();
        write_string_field(&mut reaction, 1, "target-1");
        write_string_field(&mut reaction, 2, "\u{1f44d}");
        write_tag(&mut reaction, 4, 0);
        write_varint(&mut reaction, 1);
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 3, &reaction);

        assert_eq!(extract_full_message_info(&msg)["ok"], false);
    }

    #[test]
    fn graine_key_material_never_rings_anybody() {
        // GraineMsg { channel_id=1, session_id=2, seed=3 } as AppMessage field 10. A seed
        // distribution reaching a phone must be as silent as a read receipt - it is key material,
        // not something anybody said.
        let mut graine = Vec::new();
        write_string_field(&mut graine, 1, "ch-1");
        write_string_field(&mut graine, 2, "sess-1");
        write_bytes_field(&mut graine, 3, &[0u8; 32]);
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 10, &graine);

        assert_eq!(extract_full_message_info(&msg)["ok"], false);
    }

    #[test]
    fn graine_requests_and_bundles_are_silent_too() {
        for field in [11u32, 12u32] {
            let mut body = Vec::new();
            write_string_field(&mut body, 1, "ws-1");
            let mut msg = Vec::new();
            write_bytes_field(&mut msg, field, &body);
            assert_eq!(
                extract_full_message_info(&msg)["ok"],
                false,
                "AppMessage field {field} must be silent"
            );
        }
    }

    /// THE DEFECT THIS WHOLE PATH EXISTS FOR: the seed reaches the phone inside a frame nothing
    /// read, so every notification of that session fell back to "new message in #salon". Silent is
    /// not the same as worthless - the frame must still ring nobody AND state what it carries.
    #[test]
    fn a_rotation_frame_hands_over_its_seed_while_still_ringing_nobody() {
        let seed = [7u8; 32];
        let msg = build_graine_app_message("ch-1", "sess-1", &seed, 1_700_000_000_000);

        let info = extract_full_message_info(&msg);
        assert_eq!(info["ok"], false, "key material must never ring");
        assert_eq!(info["kind"], "graine_key_material");
        let seeds = info["seeds"].as_array().expect("seeds array");
        assert_eq!(seeds.len(), 1);
        assert_eq!(seeds[0]["channelId"], "ch-1");
        assert_eq!(seeds[0]["sessionId"], "sess-1");
        assert_eq!(seeds[0]["createdAt"], 1_700_000_000_000i64);
        // Base64 of the raw bytes, because that is the form `lookupGraineSeed` reads back out of
        // graine_seeds.json and hands to `derive_message_key`.
        assert_eq!(seeds[0]["seedB64"], BASE64.encode(seed));
    }

    /// A BUNDLE IS A LIST, AND READING ONLY ITS HEAD WOULD LOSE THE REST IN SILENCE. Three seeds
    /// in, three seeds out, in wire order - this is what `find_repeated_length_delimited_field`
    /// buys, and with the first-match reader in its place this test reports one.
    #[test]
    fn a_catch_up_bundle_hands_over_every_seed_it_carries() {
        let mut bundle = Vec::new();
        for (i, session) in ["s-1", "s-2", "s-3"].iter().enumerate() {
            write_bytes_field(
                &mut bundle,
                3,
                &build_graine_msg("ch-1", session, &[i as u8; 32], 1_000 + i as i64),
            );
        }
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 12, &bundle);

        let info = extract_full_message_info(&msg);
        assert_eq!(info["ok"], false);
        let seeds = info["seeds"].as_array().expect("seeds array");
        let ids: Vec<&str> = seeds
            .iter()
            .map(|s| s["sessionId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["s-1", "s-2", "s-3"]);
    }

    /// A seed that could not be used is dropped HERE rather than written and failing later: the
    /// three fields checked are exactly the ones `derive_message_key` cannot be called without.
    #[test]
    fn a_seed_missing_what_derivation_needs_is_not_handed_over() {
        let cases: [(&str, Vec<u8>); 3] = [
            ("no channel", build_graine_msg("", "sess-1", &[1u8; 32], 1)),
            ("no session", build_graine_msg("ch-1", "", &[1u8; 32], 1)),
            // 16 bytes is a plausible-looking key and a useless one: HKDF would answer, and the
            // message would not open. Length is the only thing that separates them here.
            (
                "short seed",
                build_graine_msg("ch-1", "sess-1", &[1u8; 16], 1),
            ),
        ];
        for (what, body) in cases {
            let mut msg = Vec::new();
            write_bytes_field(&mut msg, 10, &body);
            let info = extract_full_message_info(&msg);
            assert_eq!(info["kind"], "graine_key_material", "{what}");
            assert_eq!(
                info["seeds"].as_array().map(|a| a.len()),
                Some(0),
                "{what} should have been refused"
            );
        }
    }

    /// A REQUEST carries no key material, and that is a different fact from "nobody looked". The
    /// absorber reads `kind`, so an unnamed frame and an empty one must not arrive as one answer.
    #[test]
    fn a_seed_request_is_named_rather_than_left_unrecognised() {
        let mut body = Vec::new();
        write_string_field(&mut body, 1, "ws-1");
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 11, &body);

        let info = extract_full_message_info(&msg);
        assert_eq!(info["ok"], false);
        assert_eq!(info["kind"], "graine_request");
        assert!(info["seeds"].is_null(), "a request has no seeds to absorb");
    }

    /// An ordinary message must not acquire a `kind` - the absorber would then be handed every
    /// text frame in the app to look through.
    #[test]
    fn an_ordinary_message_carries_no_absorbable_kind() {
        let msg = build_text_app_message("m-1", 1_700_000_000_000, "bonjour");
        let info = extract_full_message_info(&msg);
        assert_eq!(info["ok"], true);
        assert!(info["kind"].is_null());
    }

    #[test]
    fn call_invite_is_typed_with_call_metadata() {
        // CallMsg { call_id=1, offer_sdp=2 ("START" sentinel), has_video=6 } as AppMessage field 7.
        let mut call = Vec::new();
        write_string_field(&mut call, 1, "room-1");
        write_string_field(&mut call, 2, "START");
        write_tag(&mut call, 6, 0);
        write_varint(&mut call, 1);
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 7, &call);
        write_string_field(&mut msg, 6, "mid-1");

        let info = extract_full_message_info(&msg);
        assert_eq!(info["ok"], true);
        assert_eq!(info["type"], "call_invite");
        assert_eq!(info["callId"], "room-1");
        assert_eq!(info["hasVideo"], true);
        assert!(info["text"].as_str().unwrap().contains("Appel"));
    }

    #[test]
    fn call_hangup_is_suppressed_control_with_call_ended() {
        // CallMsg { call_id=1, hangup=5 } - signaling only, must never fabricate a preview.
        let mut call = Vec::new();
        write_string_field(&mut call, 1, "room-1");
        write_tag(&mut call, 5, 0);
        write_varint(&mut call, 1);
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 7, &call);

        let info = extract_full_message_info(&msg);
        assert_eq!(info["ok"], true);
        assert_eq!(info["type"], "call_control");
        assert_eq!(info["callEnded"], true);
        assert_eq!(info["text"], "");
    }
}
