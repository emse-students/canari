//! Minimal protobuf helpers extracting what a decrypted `AppMessage` carries - the text a
//! notification shows, and the key material a background push must absorb before it can show one.
//!
//! Hand-rolled rather than generated: this runs in the push service, where the WebView and the
//! generated protobufjs codec do not exist. It reads the few fields a notification turns on and
//! walks past everything else, so a proto change it does not know about costs it nothing.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use crate::mobile::graine::GRAINE_SEED_BYTES;
use crate::mobile::push_text::{PushLanguage, PushText};

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

/// Builds a short notification body for a decoded `SystemMsg`, in `language`.
/// Returns None for silent/control events that should not produce a visible preview.
fn format_system_event_text(event: &str, data: &str, language: PushLanguage) -> Option<String> {
    let data_json: serde_json::Value =
        serde_json::from_str(data).unwrap_or(serde_json::Value::Null);

    let text = match event {
        "groupRenamed" => PushText::GroupRenamed(
            data_json
                .get("newName")
                .and_then(|v| v.as_str())
                .filter(|name| !name.is_empty()),
        ),
        "groupImageChanged" => PushText::GroupImageChanged,
        "memberAdded" => {
            let count = data_json
                .get("newUsers")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                .filter(|&n| n > 0)
                .or_else(|| data_json.get("newUser").and_then(|v| v.as_str()).map(|_| 1));
            // A frame that names nobody still added someone: it reads as one.
            PushText::MembersAdded(count.unwrap_or(1))
        }
        "memberRemoved" => PushText::MemberRemoved,
        "memberLeft" => PushText::MemberLeft,
        "groupDeleted" => PushText::GroupDeleted,
        // AN INVITATION IS A MESSAGE, NOT MACHINERY, and it was listed below as machinery until
        // 2026-09-28. The web draws it as a card with a Join button; the push that carries it is
        // VISIBLE, so a phone that answered `None` here rang the invitee with the generic "Nouveau
        // message de ..." (NOTIF-21, measured on the A1 that day). The inviter's own other devices
        // never reach this: a frame from self is pushed `silent`, and a silent push returns before
        // any preview is built. Worded as `mkChannelInviteEnvelope` words the card - the community
        // first, the salon when the frame names no community.
        "channel_invitation" => {
            PushText::Invited(["workspaceName", "channelName"].iter().find_map(|k| {
                data_json
                    .get(*k)
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
            }))
        }
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
        | "history_bundle"
        | "history_coverage"
        | "history_digest"
        | "history_digest_request"
        | "history_pull"
        | "history_range"
        | "history_state" => return None,
        _ => PushText::UnknownEvent(event),
    };
    Some(text.render(language))
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

/// Every Graine seed an `AppMessage` carries, as `[{channelId, sessionId, seedB64, createdAt,
/// firstIndex}]`, plus the five v2 fields (section 21) on a v2 seed.
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
    let mut absorb = |graine: &[u8], relayed: bool| {
        let channel_id = find_length_delimited_field(graine, 1)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        let session_id = find_length_delimited_field(graine, 2)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        let seed = find_length_delimited_field(graine, 3).unwrap_or_default();
        let created_at = find_varint_field(graine, 5).unwrap_or(0) as i64;
        // The floor, read at last: a seed handed over mid-session opens only from here on, and a
        // push is held to that exactly like the app is.
        let first_index = find_varint_field(graine, 4).unwrap_or(0);
        let version = find_varint_field(graine, 6).unwrap_or(0);
        if channel_id.is_empty() || session_id.is_empty() || seed.len() != GRAINE_SEED_BYTES {
            log::debug!(
                "[GRAINE_PUSH] unusable seed: channel={} session={} seed_len={}",
                !channel_id.is_empty(),
                !session_id.is_empty(),
                seed.len()
            );
            return;
        }
        let mut entry = serde_json::json!({
            "channelId": channel_id,
            "sessionId": session_id,
            "seedB64": BASE64.encode(&seed),
            "createdAt": created_at,
            "firstIndex": first_index,
        });
        // Graine v2 (channel-encryption section 21): the endorsement travels with the seed, so the
        // native side can check it exactly as the app does before mirroring anything. Carried as
        // the frame states it - an absent field stays empty, never defaulted, and is refused there.
        if version == 2 {
            let text = |n| {
                find_length_delimited_field(graine, n)
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_default()
            };
            let bytes =
                |n| BASE64.encode(find_length_delimited_field(graine, n).unwrap_or_default());
            entry["version"] = 2.into();
            entry["minterUserId"] = text(7).into();
            entry["minterDeviceId"] = text(8).into();
            entry["signingPublicKeyB64"] = bytes(9).into();
            entry["endorsementB64"] = bytes(10).into();
        }
        if relayed {
            entry["relayed"] = true.into();
        }
        out.push(entry);
    };

    if let Some(graine) = &single {
        absorb(graine, false);
    }
    if let Some(bundle) = &bundle {
        // A BUNDLE'S SEEDS ARE RELAYED, and the writer treats them apart: an answerer gathers them
        // from a store keyed by community, so only the app - which knows which salons ride which key
        // group - may admit one for a salon this device has never read (`store_graine_seeds_json`).
        for graine in find_repeated_length_delimited_field(bundle, 3) {
            absorb(&graine, true);
        }
    }
    Some(out)
}

/// Extracts the full metadata of a decrypted `AppMessage` protobuf for push display.
///
/// `language` words every sentence this function composes itself (a system event, a reaction, a
/// media placeholder, a poll, a call); the text somebody TYPED is passed through as written.
pub fn extract_full_message_info(bytes: &[u8], language: PushLanguage) -> serde_json::Value {
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
            return ok_message_json(
                PushText::Reacted(&emoji).render(language),
                message_id,
                sent_at,
                "reaction",
            );
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
        // `voice_note` (field 11) is DECLARED BY THE SENDER: a recording and an imported `.m4a` are
        // the same bytes and the same mime, so nothing else here could tell them apart. Absent reads
        // as false, which is every message from before 2026-09-17 - announced as an audio file, as
        // it always was (docs/wiki/frontend/modules/chat.md, "A voice note declares itself").
        let voice_note = find_varint_field(&media_msg, 11).unwrap_or(0) != 0;
        // `intent` (field 14) is DECLARED BY THE SENDER too, for the same reason: a CanaReel filmed
        // in a conversation and a clip picked from the gallery are both an MP4 video. The rule is
        // `isReelMessage` (frontend `reels/chatReel.ts`): a VIDEO declaring `REEL_MESSAGE` (1). Any
        // other value - an intent this reader was never taught - stays an ordinary video, as it
        // does in the app (WP-RC-7, docs/wiki/frontend/modules/reels-in-chat.md section 6).
        let reel = kind_str == "video" && find_varint_field(&media_msg, 14) == Some(1);
        let media_kind = if reel { "reel" } else { kind_str };
        let display_text = if reel {
            PushText::Reel(caption.as_deref()).render(language)
        } else {
            caption.unwrap_or_else(|| {
                match kind_str {
                    "image" => PushText::Photo,
                    "video" => PushText::Video,
                    "audio" if voice_note => PushText::VoiceNote,
                    "audio" => PushText::Audio,
                    _ => PushText::Attachment,
                }
                .render(language)
            })
        };
        // Media reference + CEK (WP-XP-3): the native notification builder downloads the opaque
        // ciphertext by `mediaId` and AES-256-GCM-decrypts it with `mediaKey`/`mediaIv` to attach a
        // thumbnail. key/iv are stored as raw proto `bytes`; base64-encode them for the JSON bridge
        // (the values never leave the device process). Only images/GIF are rendered downstream.
        let media_id = find_length_delimited_field(&media_msg, 2)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        // `MediaMsg.encoding` (field 12, CanaReels R2): 0 is the single AES-GCM block, the only
        // format `decrypt_media_blob` reads. Any other value is a segmented (or newer) blob, and its
        // key is WITHHELD rather than handed to a decrypt certain to refuse it: every native caller
        // already reads an empty `mediaKey` as "no thumbnail", so the banner stays text-only and no
        // download is wasted. The writer segments video only, which no native path renders anyway -
        // this is the refusal by FACT for the day a segmented picture ever reaches one.
        let encoding = find_varint_field(&media_msg, 12).unwrap_or(0);
        // A REEL NEVER HANDS OVER ITS KEY, whatever its encoding: no thumbnail, ever (reels-in-chat
        // section 6). Decrypting a reel in a background service to draw a preview would be the
        // wrong cost and an exposure the tile itself avoids (it fetches nothing before the tap).
        // Stated as a fact here rather than left to `mediaKind != "image"` in three native callers.
        let thumbnail_readable = encoding == 0 && !reel;
        if !thumbnail_readable {
            log::debug!(
                "[MediaBG] media encoding {encoding} reel={reel} - no thumbnail, key withheld"
            );
        }
        let media_key = find_length_delimited_field(&media_msg, 3)
            .filter(|_| thumbnail_readable)
            .map(|b| STANDARD.encode(b))
            .unwrap_or_default();
        let media_iv = find_length_delimited_field(&media_msg, 4)
            .filter(|_| thumbnail_readable)
            .map(|b| STANDARD.encode(b))
            .unwrap_or_default();
        let mime_type = find_length_delimited_field(&media_msg, 5)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        return serde_json::json!({
            "ok": true, "text": display_text, "messageId": message_id,
            "sentAt": sent_at, "type": "media", "replyTo": null, "mediaKind": media_kind,
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
            if let Some(text) = format_system_event_text(&event, &data, language) {
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
                PushText::Poll(&question).render(language),
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
    // other payload (answer/ICE/hangup/answered/busy) is pure signaling -> "call_control" with
    // `callEnded` set on hangup/answered so natives can cancel a ring instead of showing
    // the old generic "new message" fallback. A `busy` payload (field 11: a device answering an
    // invite with "I am in another call") is signaling too, and ends NOTHING here: the caller's
    // own client reacts to it, and a busy frame must never cancel a ring this device shows.
    if let Some(call_msg) = find_length_delimited_field(bytes, 7) {
        let call_id = find_length_delimited_field(&call_msg, 1)
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        let has_video = find_varint_field(&call_msg, 6).unwrap_or(0) == 1;
        if find_length_delimited_field(&call_msg, 2).is_some() {
            let text = if has_video {
                PushText::VideoCallIncoming
            } else {
                PushText::CallIncoming
            }
            .render(language);
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

/// Builds a plaintext `AppMessage{ call: CallMsg{ call_id, device_id, hangup, end_reason } }`
/// proto: the hangup a callee sends when it refuses a ring, built for the Decline button of the
/// NATIVE ring (Android's CallStyle notification and call screen), which runs with no webview.
///
/// It is byte-for-byte what the in-app Decline sends (`mkCallHangup(callId, deviceId, 'declined')`
/// through `sendMlsNotification`, which sets `message_id` and `sent_at` on the envelope): the
/// caller's client reads one frame for both, ends its ring at once and files the call as declined,
/// where before the native Decline sent nothing and the caller rang out its whole window.
///
/// `end_reason` is the wire value of `CallEndReason` (DECLINED = 2); 0 is left off, as proto3 does.
pub fn build_call_hangup_app_message(
    message_id: &str,
    sent_at: i64,
    call_id: &str,
    device_id: &str,
    end_reason: u32,
) -> Vec<u8> {
    let mut call = Vec::with_capacity(call_id.len() + device_id.len() + 12);
    write_string_field(&mut call, 1, call_id);
    write_tag(&mut call, 5, 0);
    write_varint(&mut call, 1);
    write_string_field(&mut call, 8, device_id);
    if end_reason != 0 {
        write_tag(&mut call, 10, 0);
        write_varint(&mut call, end_reason as u64);
    }
    wrap_app_message(7, &call, message_id, sent_at)
}

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

/// The v2 half of a seed, as `seedDistribution.ts` sends it: version 6, minter 7, its device 8,
/// the session's signing key 9, the endorsement 10.
#[cfg(test)]
pub(crate) struct GraineV2Fields<'a> {
    pub minter_user_id: &'a str,
    pub minter_device_id: &'a str,
    pub signing_public_key: &'a [u8],
    pub endorsement: &'a [u8],
}

/// [`build_graine_app_message`] for a v2 session.
#[cfg(test)]
pub(crate) fn build_graine_v2_app_message(
    channel: &str,
    session: &str,
    seed: &[u8],
    created_at: i64,
    v2: &GraineV2Fields<'_>,
) -> Vec<u8> {
    let mut g = build_graine_msg(channel, session, seed, created_at);
    write_tag(&mut g, 6, 0);
    write_varint(&mut g, 2);
    write_string_field(&mut g, 7, v2.minter_user_id);
    write_string_field(&mut g, 8, v2.minter_device_id);
    write_bytes_field(&mut g, 9, v2.signing_public_key);
    write_bytes_field(&mut g, 10, v2.endorsement);
    let mut msg = Vec::new();
    write_bytes_field(&mut msg, 10, &g);
    msg
}

/// Builds a plaintext `AppMessage{ system: SystemMsg{ event: "read_watermark", data: {"at", "serverAt"?} } }`
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
/// `server_at` is the SERVER's `createdAt` of that same message, when the notification carries it
/// (Android since 2026-10-31; 0 otherwise). The conversation is ordered and read on the server's
/// clock (readState.ts), and a frame carrying it is the shape `readWatermarkFrameData` sends from
/// the app: `serverAt` AND `at`, the same value, `at` kept for a client that reads it alone. With
/// no server time the frame is the older shape, `{at}` on the sender's clock, which every client
/// reads into its stamped map (`readWatermarkFrameMark`).
///
/// `message_id`/`sent_at` on the envelope are left unset like every other control event
/// (`enqueueControlEvent` encodes the system message with no envelope fields). Sent `silent` by the
/// caller, so it reaches peers and our own other devices without ringing any of them.
pub fn build_read_watermark_app_message(at: i64, server_at: i64) -> Vec<u8> {
    let data = if server_at > 0 {
        serde_json::json!({ "at": server_at, "serverAt": server_at })
    } else {
        serde_json::json!({ "at": at })
    }
    .to_string();
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
        let text = format_system_event_text(
            "groupRenamed",
            r#"{"newName":"Les Canaris"}"#,
            PushLanguage::French,
        )
        .expect("preview");
        assert!(text.contains("Les Canaris"));
    }

    #[test]
    fn system_member_added_preview() {
        let text = format_system_event_text(
            "memberAdded",
            r#"{"newUsers":["u1","u2"]}"#,
            PushLanguage::French,
        )
        .expect("preview");
        assert!(text.contains("2 membres"));
    }

    #[test]
    fn a_channel_invitation_names_the_community_it_invites_to() {
        let text = format_system_event_text(
            "channel_invitation",
            r#"{"channelId":"c1","channelName":"general","workspaceName":"Gala"}"#,
            PushLanguage::French,
        )
        .expect("an invitation is a visible message");
        assert_eq!(text, "vous a invité à rejoindre « Gala »");
        let bare = format_system_event_text(
            "channel_invitation",
            r#"{"channelId":"c1"}"#,
            PushLanguage::French,
        )
        .expect("an invitation naming nothing still says what it is");
        assert_eq!(bare, "vous a invité à rejoindre une communauté");
    }

    #[test]
    fn silent_system_events_return_none() {
        assert!(format_system_event_text("read_receipt", "{}", PushLanguage::French).is_none());
        assert!(format_system_event_text(
            "delete_message",
            r#"{"messageId":"x"}"#,
            PushLanguage::French
        )
        .is_none());
    }

    /// A `MediaMsg` as the TS encoder writes it: kind, id, key, iv, mime, and `encoding` when set.
    fn media_app_message(kind: u64, encoding: u64) -> Vec<u8> {
        let mut media = Vec::new();
        write_tag(&mut media, 1, 0);
        write_varint(&mut media, kind);
        write_string_field(&mut media, 2, "m-1");
        write_bytes_field(&mut media, 3, &[7u8; 32]);
        write_bytes_field(&mut media, 4, &[9u8; 12]);
        write_string_field(&mut media, 5, "image/webp");
        if encoding != 0 {
            write_tag(&mut media, 12, 0);
            write_varint(&mut media, encoding);
        }
        wrap_app_message(4, &media, "msg-1", 1)
    }

    #[test]
    fn a_single_block_media_hands_its_key_to_the_thumbnail() {
        let info = extract_full_message_info(&media_app_message(1, 0), PushLanguage::French);
        assert_eq!(info["type"], "media");
        assert_eq!(info["mediaKind"], "image");
        assert_eq!(info["mediaKey"], BASE64.encode([7u8; 32]));
        assert_eq!(info["mediaIv"], BASE64.encode([9u8; 12]));
    }

    #[test]
    fn a_segmented_media_withholds_its_key_so_no_thumbnail_is_attempted() {
        for encoding in [1u64, 7] {
            let info =
                extract_full_message_info(&media_app_message(1, encoding), PushLanguage::French);
            assert_eq!(info["type"], "media", "the banner still says it is a photo");
            assert_eq!(info["mediaId"], "m-1");
            assert_eq!(
                info["mediaKey"], "",
                "encoding {encoding} must not reach the decrypt"
            );
            assert_eq!(info["mediaIv"], "");
        }
    }

    /// A `MediaMsg` declaring an `intent` (14), as the reel writer sends it: `kind`, an id, a key,
    /// `encoding` (12, 1 = SEGMENTED_V1, 0 = absent), the intent, `duration_ms` (15) and
    /// `expires_at_ms` (16), plus a caption (8) when given.
    fn intent_media_app_message(
        kind: u64,
        encoding: u64,
        intent: u64,
        caption: Option<&str>,
    ) -> Vec<u8> {
        let mut media = Vec::new();
        write_tag(&mut media, 1, 0);
        write_varint(&mut media, kind);
        write_string_field(&mut media, 2, "reel-1");
        write_bytes_field(&mut media, 3, &[7u8; 32]);
        write_bytes_field(&mut media, 4, &[9u8; 12]);
        write_string_field(&mut media, 5, "video/mp4");
        if let Some(caption) = caption {
            write_string_field(&mut media, 8, caption);
        }
        if encoding != 0 {
            write_tag(&mut media, 12, 0);
            write_varint(&mut media, encoding);
        }
        write_tag(&mut media, 14, 0);
        write_varint(&mut media, intent);
        write_tag(&mut media, 15, 0);
        write_varint(&mut media, 42_000);
        write_tag(&mut media, 16, 0);
        write_varint(&mut media, 1_790_000_000_000);
        wrap_app_message(4, &media, "msg-reel", 1)
    }

    /// A reel message as the writer sends it: a segmented VIDEO declaring `REEL_MESSAGE`.
    fn reel_message_app_message(caption: Option<&str>) -> Vec<u8> {
        intent_media_app_message(2, 1, 1, caption)
    }

    /// WP-RC-7: a reel message is announced as a CanaReel, in the app language, with the kind the
    /// native side files it under - and its key never leaves Rust, so no caller can try a thumbnail.
    #[test]
    fn a_reel_message_is_announced_as_a_canareel_and_never_hands_over_its_key() {
        let info = extract_full_message_info(&reel_message_app_message(None), PushLanguage::French);
        assert_eq!(info["ok"], true);
        assert_eq!(info["type"], "media");
        assert_eq!(info["mediaKind"], "reel");
        assert_eq!(info["text"], "\u{1f3ac} CanaReel");
        assert_eq!(info["mediaId"], "reel-1");
        assert_eq!(info["mediaKey"], "");
        assert_eq!(info["mediaIv"], "");
        assert_eq!(info["mimeType"], "video/mp4");

        let english =
            extract_full_message_info(&reel_message_app_message(None), PushLanguage::English);
        assert_eq!(english["text"], "\u{1f3ac} CanaReel");
    }

    /// A caption FOLLOWS the announcement instead of replacing it, as it does for a photo: the
    /// banner must still say a reel is waiting.
    #[test]
    fn a_reel_caption_follows_the_announcement() {
        let fr = extract_full_message_info(
            &reel_message_app_message(Some("Au gala")),
            PushLanguage::French,
        );
        assert_eq!(fr["text"], "\u{1f3ac} CanaReel : Au gala");
        let en = extract_full_message_info(
            &reel_message_app_message(Some("Au gala")),
            PushLanguage::English,
        );
        assert_eq!(en["text"], "\u{1f3ac} CanaReel: Au gala");
        // An EMPTY caption is no caption.
        let empty =
            extract_full_message_info(&reel_message_app_message(Some("")), PushLanguage::French);
        assert_eq!(empty["text"], "\u{1f3ac} CanaReel");
    }

    /// NO THUMBNAIL, EVER, is a property of the reel and not of its encoding: a single-block reel
    /// (a writer that never segmented it) still withholds its key.
    #[test]
    fn a_single_block_reel_still_withholds_its_key() {
        let info = extract_full_message_info(
            &intent_media_app_message(2, 0, 1, None),
            PushLanguage::French,
        );
        assert_eq!(info["mediaKind"], "reel");
        assert_eq!(info["mediaKey"], "");
        assert_eq!(info["mediaIv"], "");
    }

    /// The rule is the app's `isReelMessage`: a VIDEO declaring value 1. A value this reader was
    /// never taught (2 is reserved for view-once) and the declaration on a non-video both read as
    /// what the kind says - an ordinary video, an ordinary photo.
    #[test]
    fn only_a_video_declaring_reel_message_is_a_reel() {
        let unknown = extract_full_message_info(
            &intent_media_app_message(2, 1, 2, None),
            PushLanguage::French,
        );
        assert_eq!(unknown["mediaKind"], "video");
        assert_eq!(unknown["text"], "\u{1f3a5} Vidéo");

        let none = extract_full_message_info(
            &intent_media_app_message(2, 1, 0, None),
            PushLanguage::French,
        );
        assert_eq!(none["mediaKind"], "video");

        let photo = extract_full_message_info(
            &intent_media_app_message(1, 0, 1, None),
            PushLanguage::French,
        );
        assert_eq!(photo["mediaKind"], "image");
        assert_eq!(photo["text"], "\u{1f4f7} Photo");
        assert_eq!(
            photo["mediaKey"],
            BASE64.encode([7u8; 32]),
            "a photo keeps its thumbnail"
        );
    }

    /// An audio `MediaMsg`, declared a voice note (field 11) or not.
    fn audio_app_message(voice_note: bool) -> Vec<u8> {
        let mut media = Vec::new();
        write_tag(&mut media, 1, 0);
        write_varint(&mut media, 3); // MEDIA_KIND_AUDIO
        write_string_field(&mut media, 2, "a-1");
        write_string_field(&mut media, 5, "audio/mp4");
        if voice_note {
            write_tag(&mut media, 11, 0);
            write_varint(&mut media, 1);
        }
        wrap_app_message(4, &media, "msg-a", 1)
    }

    /// WP-PUSH-I18N: a voice note is announced as one, and an undeclared audio - an import, or a
    /// recording from before the field existed - stays an audio file. The sender's declaration is
    /// the only thing that separates them; the bytes and the mime are the same.
    #[test]
    fn a_declared_voice_note_is_announced_as_a_voice_message() {
        let voice = extract_full_message_info(&audio_app_message(true), PushLanguage::French);
        assert_eq!(voice["mediaKind"], "audio");
        assert_eq!(voice["text"], "\u{1f3a4} Message vocal");
        let file = extract_full_message_info(&audio_app_message(false), PushLanguage::French);
        assert_eq!(file["text"], "\u{1f3b5} Fichier audio");
        let english = extract_full_message_info(&audio_app_message(true), PushLanguage::English);
        assert_eq!(english["text"], "\u{1f3a4} Voice message");
    }

    /// The language reaches every sentence the scanner composes, and NEVER the text somebody typed.
    #[test]
    fn the_app_language_words_the_composed_sentences_and_leaves_typed_text_alone() {
        let typed = build_text_app_message("m-1", 1, "bonjour");
        assert_eq!(
            extract_full_message_info(&typed, PushLanguage::English)["text"],
            "bonjour"
        );

        let mut reaction = Vec::new();
        write_string_field(&mut reaction, 1, "target-1");
        write_string_field(&mut reaction, 2, "\u{1f44d}");
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 3, &reaction);
        assert_eq!(
            extract_full_message_info(&msg, PushLanguage::English)["text"],
            "reacted \u{1f44d}"
        );

        assert_eq!(
            format_system_event_text("memberLeft", "{}", PushLanguage::English).as_deref(),
            Some("left the group")
        );
        assert_eq!(
            format_system_event_text(
                "groupRenamed",
                r#"{"newName":"Gala"}"#,
                PushLanguage::English
            )
            .as_deref(),
            Some("renamed the group to \"Gala\"")
        );

        let mut call = Vec::new();
        write_string_field(&mut call, 1, "room-1");
        write_string_field(&mut call, 2, "START");
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 7, &call);
        assert_eq!(
            extract_full_message_info(&msg, PushLanguage::English)["text"],
            "\u{1f4de} Incoming call"
        );
    }

    #[test]
    fn build_text_app_message_roundtrips_through_extract() {
        let bytes = build_text_app_message("msg-123", 1_700_000_000_000, "hello quick reply");
        let info = extract_full_message_info(&bytes, PushLanguage::French);
        assert_eq!(info["ok"], true);
        assert_eq!(info["type"], "text");
        assert_eq!(info["text"], "hello quick reply");
        assert_eq!(info["messageId"], "msg-123");
        assert_eq!(info["sentAt"], 1_700_000_000_000i64);
    }

    #[test]
    fn build_read_watermark_app_message_carries_the_instant_and_stays_silent() {
        let bytes = build_read_watermark_app_message(1_700_000_000_000, 0);
        // Silent like every control frame: no preview may be fabricated for it.
        assert_eq!(
            extract_full_message_info(&bytes, PushLanguage::French)["ok"],
            false
        );
        let system_msg = find_length_delimited_field(&bytes, 5).expect("system field present");
        let event = find_length_delimited_field(&system_msg, 1).unwrap();
        assert_eq!(String::from_utf8(event).unwrap(), "read_watermark");
        let data = find_length_delimited_field(&system_msg, 2).unwrap();
        let data_json: serde_json::Value = serde_json::from_slice(&data).unwrap();
        // The number, not a string: `systemMessageHandler` reads it as `Number(data.at)` and a
        // quoted instant would parse the same, which is exactly how such a drift stays invisible.
        assert_eq!(data_json["at"], serde_json::json!(1_700_000_000_000i64));
        // No server time known: the older shape, read into the stamped map.
        assert!(data_json.get("serverAt").is_none());
    }

    /// With the server's `createdAt` the frame is the one the app sends (`readWatermarkFrameData`):
    /// the server instant under both names, so the shade's mark lands on the clock the
    /// conversation is ordered by, and an older client still reads `at`.
    #[test]
    fn build_read_watermark_app_message_states_the_server_clock_when_known() {
        let bytes = build_read_watermark_app_message(1_700_000_000_000, 1_700_000_060_000);
        let system_msg = find_length_delimited_field(&bytes, 5).expect("system field present");
        let data = find_length_delimited_field(&system_msg, 2).unwrap();
        let data_json: serde_json::Value = serde_json::from_slice(&data).unwrap();
        assert_eq!(
            data_json["serverAt"],
            serde_json::json!(1_700_000_060_000i64)
        );
        assert_eq!(data_json["at"], serde_json::json!(1_700_000_060_000i64));
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
            "history_bundle",
            "history_coverage",
            "history_digest",
            "history_digest_request",
            "history_pull",
            "history_range",
            "history_state",
        ] {
            assert!(
                format_system_event_text(event, "{}", PushLanguage::French).is_none(),
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

        let info = extract_full_message_info(&msg, PushLanguage::French);
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

        assert_eq!(
            extract_full_message_info(&msg, PushLanguage::French)["ok"],
            false
        );
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

        assert_eq!(
            extract_full_message_info(&msg, PushLanguage::French)["ok"],
            false
        );
    }

    /// Graine v2 (channel-encryption section 21): the floor and the five endorsement fields reach
    /// the native side exactly as the frame states them - a relay that dropped one would leave the
    /// phone a session it cannot verify.
    #[test]
    fn a_v2_seed_hands_over_its_floor_and_its_endorsement() {
        let mut graine = build_graine_msg("ch-1", "sess-1", &[7u8; 32], 1_700_000_000_000);
        write_tag(&mut graine, 4, 0);
        write_varint(&mut graine, 12);
        write_tag(&mut graine, 6, 0);
        write_varint(&mut graine, 2);
        write_string_field(&mut graine, 7, "alice");
        write_string_field(&mut graine, 8, "dev-a");
        write_bytes_field(&mut graine, 9, &[1u8; 32]);
        write_bytes_field(&mut graine, 10, &[2u8; 64]);
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 10, &graine);

        let info = extract_full_message_info(&msg, PushLanguage::French);
        let seed = &info["seeds"][0];
        assert_eq!(seed["firstIndex"], 12);
        assert_eq!(seed["version"], 2);
        assert_eq!(seed["minterUserId"], "alice");
        assert_eq!(seed["minterDeviceId"], "dev-a");
        assert_eq!(seed["signingPublicKeyB64"], BASE64.encode([1u8; 32]));
        assert_eq!(seed["endorsementB64"], BASE64.encode([2u8; 64]));

        // A v1 seed carries none of the five, and a floor of 0.
        let v1 = extract_full_message_info(
            &build_graine_app_message("ch-1", "s", &[7u8; 32], 1),
            PushLanguage::French,
        );
        assert_eq!(v1["seeds"][0]["firstIndex"], 0);
        assert!(v1["seeds"][0].get("version").is_none());
    }

    #[test]
    fn graine_requests_and_bundles_are_silent_too() {
        for field in [11u32, 12u32] {
            let mut body = Vec::new();
            write_string_field(&mut body, 1, "ws-1");
            let mut msg = Vec::new();
            write_bytes_field(&mut msg, field, &body);
            assert_eq!(
                extract_full_message_info(&msg, PushLanguage::French)["ok"],
                false,
                "AppMessage field {field} must be silent"
            );
        }
    }

    /// `GraineBundleMsg.holds_nothing` (field 6, channel-encryption section 24) is unknown to this
    /// reader and must stay harmless: the "I hold nothing" answer to a history ask is an empty
    /// bundle with that varint set, and it reaches a phone's push path as silent key material
    /// carrying no seed - exactly what a decline-only bundle already does.
    #[test]
    fn a_bundle_saying_it_holds_nothing_is_silent_key_material_with_no_seed() {
        let mut bundle = Vec::new();
        write_string_field(&mut bundle, 1, "ws-1");
        write_string_field(&mut bundle, 2, "r-h");
        write_tag(&mut bundle, 6, 0);
        write_varint(&mut bundle, 1);
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 12, &bundle);

        let info = extract_full_message_info(&msg, PushLanguage::French);
        assert_eq!(info["ok"], false);
        assert_eq!(info["kind"], "graine_key_material");
        assert_eq!(info["seeds"].as_array().expect("seeds").len(), 0);
    }

    /// THE DEFECT THIS WHOLE PATH EXISTS FOR: the seed reaches the phone inside a frame nothing
    /// read, so every notification of that session fell back to "new message in #salon". Silent is
    /// not the same as worthless - the frame must still ring nobody AND state what it carries.
    #[test]
    fn a_rotation_frame_hands_over_its_seed_while_still_ringing_nobody() {
        let seed = [7u8; 32];
        let msg = build_graine_app_message("ch-1", "sess-1", &seed, 1_700_000_000_000);

        let info = extract_full_message_info(&msg, PushLanguage::French);
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

        let info = extract_full_message_info(&msg, PushLanguage::French);
        assert_eq!(info["ok"], false);
        let seeds = info["seeds"].as_array().expect("seeds array");
        let ids: Vec<&str> = seeds
            .iter()
            .map(|s| s["sessionId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["s-1", "s-2", "s-3"]);
        // Each marked RELAYED, which the mirror writer treats apart (`store_graine_seeds_json`).
        assert!(seeds.iter().all(|s| s["relayed"] == true));
        // A sender's own distribution is not relayed.
        let single = extract_full_message_info(
            &build_graine_app_message("ch-1", "sess-1", &[7u8; 32], 1),
            PushLanguage::French,
        );
        assert!(single["seeds"][0].get("relayed").is_none());
    }

    /// `GraineBundleMsg.page_index` / `page_count` (fields 7 and 8, 2026-10-22) are unknown to this
    /// reader: a page of a paged answer is an ordinary bundle here, every seed it carries handed
    /// over. In practice a page is far over the inline push budget and is fetched by reference, so
    /// this guards the shape, not a path a page is expected to take.
    #[test]
    fn a_page_of_a_paged_answer_hands_over_its_seeds_like_any_bundle() {
        let mut bundle = Vec::new();
        write_string_field(&mut bundle, 1, "ws-1");
        write_string_field(&mut bundle, 2, "r-p");
        for (i, session) in ["s-4", "s-5"].iter().enumerate() {
            write_bytes_field(
                &mut bundle,
                3,
                &build_graine_msg("ch-1", session, &[i as u8; 32], 2_000 + i as i64),
            );
        }
        write_tag(&mut bundle, 7, 0);
        write_varint(&mut bundle, 1);
        write_tag(&mut bundle, 8, 0);
        write_varint(&mut bundle, 3);
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 12, &bundle);

        let info = extract_full_message_info(&msg, PushLanguage::French);
        assert_eq!(info["ok"], false);
        assert_eq!(info["kind"], "graine_key_material");
        let ids: Vec<&str> = info["seeds"]
            .as_array()
            .expect("seeds array")
            .iter()
            .map(|s| s["sessionId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["s-4", "s-5"]);
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
            let info = extract_full_message_info(&msg, PushLanguage::French);
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

        let info = extract_full_message_info(&msg, PushLanguage::French);
        assert_eq!(info["ok"], false);
        assert_eq!(info["kind"], "graine_request");
        assert!(info["seeds"].is_null(), "a request has no seeds to absorb");
    }

    /// An ordinary message must not acquire a `kind` - the absorber would then be handed every
    /// text frame in the app to look through.
    #[test]
    fn an_ordinary_message_carries_no_absorbable_kind() {
        let msg = build_text_app_message("m-1", 1_700_000_000_000, "bonjour");
        let info = extract_full_message_info(&msg, PushLanguage::French);
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

        let info = extract_full_message_info(&msg, PushLanguage::French);
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

        let info = extract_full_message_info(&msg, PushLanguage::French);
        assert_eq!(info["ok"], true);
        assert_eq!(info["type"], "call_control");
        assert_eq!(info["callEnded"], true);
        assert_eq!(info["text"], "");
    }

    #[test]
    fn call_busy_is_control_that_ends_nothing() {
        // CallMsg { call_id=1, busy=11 }: a callee device answering an invite "I am busy".
        let mut call = Vec::new();
        write_string_field(&mut call, 1, "room-1");
        write_tag(&mut call, 11, 0);
        write_varint(&mut call, 1);
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 7, &call);

        let info = extract_full_message_info(&msg, PushLanguage::French);
        assert_eq!(info["type"], "call_control");
        assert_eq!(info["callEnded"], false);
        assert_eq!(info["text"], "");
    }

    #[test]
    fn call_hangup_with_an_end_reason_still_ends_the_call() {
        // CallMsg { call_id=1, hangup=5, end_reason=10 (BUSY=4) }.
        let mut call = Vec::new();
        write_string_field(&mut call, 1, "room-1");
        write_tag(&mut call, 5, 0);
        write_varint(&mut call, 1);
        write_tag(&mut call, 10, 0);
        write_varint(&mut call, 4);
        let mut msg = Vec::new();
        write_bytes_field(&mut msg, 7, &call);

        let info = extract_full_message_info(&msg, PushLanguage::French);
        assert_eq!(info["type"], "call_control");
        assert_eq!(info["callEnded"], true);
    }

    #[test]
    fn native_decline_builds_the_hangup_the_in_app_decline_sends() {
        // The native ring's Decline: CallMsg { call_id, hangup, device_id, end_reason=DECLINED },
        // in an envelope with message_id and sent_at, as `sendMlsNotification` sends it.
        let msg = build_call_hangup_app_message("mid-1", 1_700_000_000_000, "room-1", "dev-9", 2);

        let call = find_length_delimited_field(&msg, 7).expect("a CallMsg in field 7");
        assert_eq!(find_length_delimited_field(&call, 1).unwrap(), b"room-1");
        assert_eq!(find_varint_field(&call, 5), Some(1));
        assert_eq!(find_length_delimited_field(&call, 8).unwrap(), b"dev-9");
        assert_eq!(find_varint_field(&call, 10), Some(2));
        assert_eq!(find_length_delimited_field(&msg, 6).unwrap(), b"mid-1");
        assert_eq!(find_varint_field(&msg, 8), Some(1_700_000_000_000));

        // And every native reader of it sees the call end, never a preview.
        let info = extract_full_message_info(&msg, PushLanguage::French);
        assert_eq!(info["type"], "call_control");
        assert_eq!(info["callId"], "room-1");
        assert_eq!(info["callEnded"], true);
        assert_eq!(info["text"], "");
    }
}
