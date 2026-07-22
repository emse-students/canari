//! Helpers protobuf minimaux pour extraire le texte affichable d'un `AppMessage` déchiffré.
//! Pas de dépendance externe : suffisant pour les notifications push background.

/// Lit un varint protobuf depuis `bytes` à la position `pos`.
/// Retourne (valeur, position_suivante) ou None si invalide.
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

/// Cherche le premier champ `field_num` de wire type 2 (LEN) dans `bytes`.
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

/// Cherche le premier champ `field_num` de wire type 0 (varint) dans `bytes`.
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
        "read_receipt"
        | "delete_message"
        | "edit_message"
        | "remove_reaction"
        | "pin"
        | "unpin"
        | "history_bundle"
        | "channel_key_distribution" => None,
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

/// Extrait les métadonnées complètes d'un `AppMessage` protobuf déchiffré pour l'affichage push.
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
        if !emoji.is_empty() {
            return ok_message_json(format!("a réagi {emoji}"), message_id, sent_at, "reaction");
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

/// Builds a plaintext `AppMessage{ system: SystemMsg{ event: "read_receipt", data } }` proto for
/// the "mark as read" notification quick action. `data` is `{"messageIds":[...]}` (same shape
/// `sendReadReceipt` in messaging.ts sends). `message_id`/`sent_at` are left unset: control events
/// never carry them (`enqueueControlEvent` encodes the system message verbatim, with no envelope
/// fields). Silent-sent by the caller (existing `silent` outbox flag) so it triggers the same
/// cross-device notification-cancel path as a foreground read receipt, never a peer push.
pub fn build_read_receipt_app_message(message_ids: &[String]) -> Vec<u8> {
    let data = serde_json::json!({ "messageIds": message_ids }).to_string();
    let mut system_msg = Vec::with_capacity(data.len() + 24);
    write_string_field(&mut system_msg, 1, "read_receipt");
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
    fn build_read_receipt_app_message_is_silent_control() {
        let bytes = build_read_receipt_app_message(&["m1".to_string(), "m2".to_string()]);
        // Mirrors proto_fields' own classification: read_receipt is a control event with no
        // user-visible preview - extract_full_message_info must reject it, not fabricate text.
        let info = extract_full_message_info(&bytes);
        assert_eq!(info["ok"], false);
        // But the raw system fields must still be present and decodable.
        let system_msg = find_length_delimited_field(&bytes, 5).expect("system field present");
        let event = find_length_delimited_field(&system_msg, 1).unwrap();
        assert_eq!(String::from_utf8(event).unwrap(), "read_receipt");
        let data = find_length_delimited_field(&system_msg, 2).unwrap();
        let data_json: serde_json::Value = serde_json::from_slice(&data).unwrap();
        assert_eq!(data_json["messageIds"], serde_json::json!(["m1", "m2"]));
    }
}
