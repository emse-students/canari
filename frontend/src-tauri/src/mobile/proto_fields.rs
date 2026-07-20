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
        return serde_json::json!({
            "ok": true, "text": display_text, "messageId": message_id,
            "sentAt": sent_at, "type": "media", "replyTo": null, "mediaKind": kind_str
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
}
