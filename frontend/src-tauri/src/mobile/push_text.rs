//! Every sentence the push scanner writes, in the app's two languages (WP-PUSH-I18N, 2026-10-18).
//!
//! `proto_fields::extract_full_message_info` decides WHAT a decrypted message is; this module is
//! the only place that decides how it is WORDED. Both platforms reach it through the same Rust
//! call, so a banner reads the same on Android and iOS without a third copy of the table in
//! `strings.xml` and two `.lproj` files.
//!
//! The language is the one chosen INSIDE Canari, mirrored into `push_context.json` by the WebView
//! (`set_push_context_locale`) and handed down by each native caller - never the phone's, which is
//! a different setting ([mobile](../../../../docs/wiki/frontend/mobile.md#the-language-a-notification-speaks)).

/// The language a push sentence is written in: the two Paraglide locales the app ships.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushLanguage {
    French,
    English,
}

impl PushLanguage {
    /// Reads a BCP 47 tag as the native caller found it in `push_context.json`.
    ///
    /// French is the app's base locale (Paraglide `baseLocale`, `DEFAULT_PUSH_LOCALE` in
    /// `commands/push.rs`) and the default table on both platforms (`res/values`, the French-first
    /// main bundle), so a tag that names no other shipped language - including the empty one of a
    /// device that never mirrored its choice - is French, exactly as the native tables read it.
    pub fn from_tag(tag: &str) -> Self {
        let primary = tag.trim().split(['-', '_']).next().unwrap_or("");
        let language = if primary.eq_ignore_ascii_case("en") {
            Self::English
        } else {
            Self::French
        };
        log::debug!("[PushText] locale tag {tag:?} -> {language:?}");
        language
    }
}

/// One user-visible sentence of a push, with the fragments it carries.
///
/// A closed set: adding a sentence means adding a variant, and the exhaustive `match` in
/// [`PushText::render`] refuses to compile until BOTH languages are written for it.
#[derive(Clone, Copy, Debug)]
pub enum PushText<'a> {
    /// `groupRenamed`; `None` when the frame names no new name.
    GroupRenamed(Option<&'a str>),
    GroupImageChanged,
    /// `memberAdded`, with how many members it names (1 when it names none).
    MembersAdded(usize),
    MemberRemoved,
    MemberLeft,
    GroupDeleted,
    /// `channel_invitation`, naming the community (or the salon) when the frame does.
    Invited(Option<&'a str>),
    /// A system event this scanner was never taught - shown rather than dropped, see the caller.
    UnknownEvent(&'a str),
    Reacted(&'a str),
    Photo,
    Video,
    /// An audio message the SENDER declared a recording (`MediaMsg.voice_note`).
    VoiceNote,
    /// An audio file that is not declared a voice note: imported, or recorded before 2026-09-17.
    Audio,
    /// A CanaReel sent in a conversation (`MediaMsg.intent = REEL_MESSAGE`, WP-RC-7).
    Reel,
    /// An animated GIF sent as a file (`MediaMsg.mime_type` is `image/gif`, any case).
    Gif,
    /// A file that is not a picture, a video or audio, carrying its (already cleaned) name.
    File(&'a str),
    Attachment,
    /// ANY media line followed by the caption the sender typed (`Photo : coucou`): the kind is
    /// never replaced by its caption (owner, 2026-11-20), so a banner says what the message is.
    Captioned(&'a str, &'a str),
    Poll(&'a str),
    VideoCallIncoming,
    CallIncoming,
}

impl PushText<'_> {
    /// The sentence in `language`.
    pub fn render(&self, language: PushLanguage) -> String {
        let pick = |fr: String, en: String| match language {
            PushLanguage::French => fr,
            PushLanguage::English => en,
        };
        let s = |fr: &str, en: &str| pick(fr.to_string(), en.to_string());
        match *self {
            Self::GroupRenamed(None) => s("a renommé le groupe", "renamed the group"),
            Self::GroupRenamed(Some(name)) => pick(
                format!("a renommé le groupe en « {name} »"),
                format!("renamed the group to \"{name}\""),
            ),
            Self::GroupImageChanged => s("a changé la photo du groupe", "changed the group photo"),
            Self::MembersAdded(n) if n <= 1 => s(
                "a ajouté un membre au groupe",
                "added a member to the group",
            ),
            Self::MembersAdded(n) => pick(
                format!("a ajouté {n} membres au groupe"),
                format!("added {n} members to the group"),
            ),
            Self::MemberRemoved => s(
                "a retiré un membre du groupe",
                "removed a member from the group",
            ),
            Self::MemberLeft => s("a quitté le groupe", "left the group"),
            Self::GroupDeleted => s("a supprimé la conversation", "deleted the conversation"),
            Self::Invited(Some(name)) => pick(
                format!("vous a invité à rejoindre « {name} »"),
                format!("invited you to join \"{name}\""),
            ),
            Self::Invited(None) => s(
                "vous a invité à rejoindre une communauté",
                "invited you to join a community",
            ),
            Self::UnknownEvent(event) => pick(
                format!("événement de groupe ({event})"),
                format!("group event ({event})"),
            ),
            Self::Reacted(emoji) => pick(format!("a réagi {emoji}"), format!("reacted {emoji}")),
            Self::Photo => s("\u{1f4f7} Photo", "\u{1f4f7} Photo"),
            Self::Video => s("\u{1f3a5} Vidéo", "\u{1f3a5} Video"),
            Self::VoiceNote => s("\u{1f3a4} Message vocal", "\u{1f3a4} Voice message"),
            Self::Audio => s("\u{1f3b5} Fichier audio", "\u{1f3b5} Audio file"),
            Self::Reel => s("\u{1f3ac} CanaReel", "\u{1f3ac} CanaReel"),
            Self::Gif => s("\u{1f300} GIF", "\u{1f300} GIF"),
            Self::File(name) => pick(
                format!("\u{1f4ce} Fichier : {name}"),
                format!("\u{1f4ce} File: {name}"),
            ),
            Self::Captioned(label, caption) => pick(
                format!("{label} : {caption}"),
                format!("{label}: {caption}"),
            ),
            Self::Attachment => s("\u{1f4ce} Pièce jointe", "\u{1f4ce} Attachment"),
            Self::Poll(question) => pick(
                format!("\u{1f4ca} Sondage : {question}"),
                format!("\u{1f4ca} Poll: {question}"),
            ),
            Self::VideoCallIncoming => s(
                "\u{1f4f9} Appel vidéo entrant",
                "\u{1f4f9} Incoming video call",
            ),
            Self::CallIncoming => s("\u{1f4de} Appel entrant", "\u{1f4de} Incoming call"),
        }
    }
}

/// Longest file name a banner shows, in code points - `PREVIEW_FILE_NAME_MAX` in `envelope.ts`.
const FILE_NAME_MAX: usize = 60;

/// A sender-chosen file name as a banner may draw it, the app's rule (`previewFileName`): control,
/// bidi and invisible-format characters (Unicode `Cc`, `Cf`, `Zl`, `Zp`) are dropped, whitespace is
/// collapsed and the name is capped with an ellipsis. Empty once cleaned means "no name".
/// It is not `stripInvisible` byte for byte, see [`is_invisible`].
pub fn clean_file_name(raw: &str) -> String {
    // Whitespace first: a newline is a control character, and stripping it would glue two words.
    let spaced = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let kept: String = spaced.chars().filter(|c| !is_invisible(*c)).collect();
    let collapsed = kept.trim().to_string();
    if collapsed.chars().count() <= FILE_NAME_MAX {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(FILE_NAME_MAX - 1).collect();
    format!("{}\u{2026}", cut.trim_end())
}

/// The Unicode `Cc`, `Cf`, `Zl` and `Zp` characters: std covers `Cc`, the rest is listed.
///
/// It differs from the app's `stripInvisible` in three cosmetic ways, because that one judges per
/// grapheme and this one per character: it strips (1) the zero-width joiner INSIDE an emoji sequence
/// (a joined family reads as separate emoji), (2) the zero-width (non-)joiner that Arabic, Syriac and
/// the Indic scripts spell with, and (3) the tag characters U+E0020-U+E007F of a subdivision flag
/// (the England flag reads as the black flag). Only a file name's look differs, never its safety.
fn is_invisible(c: char) -> bool {
    c.is_control()
        || matches!(c as u32,
            0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2
            | 0x180E | 0x200B..=0x200F | 0x2028..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F
            | 0xFEFF | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_name_is_cleaned_and_capped_like_the_app() {
        assert_eq!(
            clean_file_name("a\u{202E}cod.exe\u{0}\u{200B}b\nc.pdf"),
            "acod.exeb c.pdf"
        );
        assert_eq!(clean_file_name("\u{200B}\u{202E} "), "");
        let long = clean_file_name(&"x".repeat(500));
        assert_eq!(long, format!("{}\u{2026}", "x".repeat(59)));
    }

    /// THE APP AND THE BANNER SAY THE SAME WORDS (owner, 2026-11-20): the app's table is Paraglide's
    /// `chat_preview_*` in `messages/{fr,en}.json`, this table is `PushText::render`. They are two
    /// copies of ONE table, so each media sentence is rendered here and compared with the message
    /// the app would draw, parameters filled in; a word changed on one side fails here.
    #[test]
    fn media_lines_match_the_apps_paraglide_messages() {
        let fr: serde_json::Value =
            serde_json::from_str(include_str!("../../../messages/fr.json")).unwrap();
        let en: serde_json::Value =
            serde_json::from_str(include_str!("../../../messages/en.json")).unwrap();
        let message = |json: &serde_json::Value, key: &str, params: &[(&str, &str)]| {
            let mut text = json[key]
                .as_str()
                .unwrap_or_else(|| panic!("messages lack {key}"))
                .to_string();
            for (name, value) in params {
                text = text.replace(&format!("{{{name}}}"), value);
            }
            text
        };
        /// A text, the message key it renders, and that key's parameters.
        type Case<'a> = (PushText<'a>, &'a str, &'a [(&'a str, &'a str)]);
        let cases: [Case<'_>; 8] = [
            (PushText::Photo, "chat_preview_photo", &[]),
            (PushText::Video, "chat_preview_video", &[]),
            (PushText::VoiceNote, "chat_preview_voice_note", &[]),
            (PushText::Audio, "chat_preview_audio", &[]),
            (PushText::Reel, "chat_preview_reel", &[]),
            (PushText::Gif, "chat_preview_gif_media", &[]),
            (
                PushText::File("cours.pdf"),
                "chat_preview_file",
                &[("name", "cours.pdf")],
            ),
            (PushText::Attachment, "chat_preview_attachment", &[]),
        ];
        for (text, key, params) in cases {
            assert_eq!(
                text.render(PushLanguage::French),
                message(&fr, key, params),
                "{key} fr"
            );
            assert_eq!(
                text.render(PushLanguage::English),
                message(&en, key, params),
                "{key} en"
            );
        }
        let captioned = PushText::Captioned("L", "c");
        let params = [("label", "L"), ("caption", "c")];
        assert_eq!(
            captioned.render(PushLanguage::French),
            message(&fr, "chat_preview_captioned", &params)
        );
        assert_eq!(
            captioned.render(PushLanguage::English),
            message(&en, "chat_preview_captioned", &params)
        );
    }

    /// EVERY sentence, both languages, written out. The `match` guarantees each variant HAS two
    /// renderings; this guarantees the English one is English - a copy-pasted French arm compiles.
    #[test]
    fn every_sentence_is_written_in_both_languages() {
        let cases: [(PushText<'_>, &str, &str); 23] = [
            (
                PushText::GroupRenamed(None),
                "a renommé le groupe",
                "renamed the group",
            ),
            (
                PushText::GroupRenamed(Some("Gala")),
                "a renommé le groupe en « Gala »",
                "renamed the group to \"Gala\"",
            ),
            (
                PushText::GroupImageChanged,
                "a changé la photo du groupe",
                "changed the group photo",
            ),
            (
                PushText::MembersAdded(1),
                "a ajouté un membre au groupe",
                "added a member to the group",
            ),
            (
                PushText::MembersAdded(3),
                "a ajouté 3 membres au groupe",
                "added 3 members to the group",
            ),
            (
                PushText::MemberRemoved,
                "a retiré un membre du groupe",
                "removed a member from the group",
            ),
            (PushText::MemberLeft, "a quitté le groupe", "left the group"),
            (
                PushText::GroupDeleted,
                "a supprimé la conversation",
                "deleted the conversation",
            ),
            (
                PushText::Invited(Some("Gala")),
                "vous a invité à rejoindre « Gala »",
                "invited you to join \"Gala\"",
            ),
            (
                PushText::Invited(None),
                "vous a invité à rejoindre une communauté",
                "invited you to join a community",
            ),
            (
                PushText::UnknownEvent("x"),
                "événement de groupe (x)",
                "group event (x)",
            ),
            (
                PushText::Reacted("\u{1f44d}"),
                "a réagi \u{1f44d}",
                "reacted \u{1f44d}",
            ),
            (PushText::Photo, "\u{1f4f7} Photo", "\u{1f4f7} Photo"),
            (PushText::Video, "\u{1f3a5} Vidéo", "\u{1f3a5} Video"),
            (
                PushText::VoiceNote,
                "\u{1f3a4} Message vocal",
                "\u{1f3a4} Voice message",
            ),
            (
                PushText::Audio,
                "\u{1f3b5} Fichier audio",
                "\u{1f3b5} Audio file",
            ),
            (PushText::Reel, "\u{1f3ac} CanaReel", "\u{1f3ac} CanaReel"),
            (PushText::Gif, "\u{1f300} GIF", "\u{1f300} GIF"),
            (
                PushText::File("cours.pdf"),
                "\u{1f4ce} Fichier : cours.pdf",
                "\u{1f4ce} File: cours.pdf",
            ),
            (
                PushText::Captioned("\u{1f3ac} CanaReel", "Au gala"),
                "\u{1f3ac} CanaReel : Au gala",
                "\u{1f3ac} CanaReel: Au gala",
            ),
            (
                PushText::Attachment,
                "\u{1f4ce} Pièce jointe",
                "\u{1f4ce} Attachment",
            ),
            (
                PushText::Poll("Où ?"),
                "\u{1f4ca} Sondage : Où ?",
                "\u{1f4ca} Poll: Où ?",
            ),
            (
                PushText::CallIncoming,
                "\u{1f4de} Appel entrant",
                "\u{1f4de} Incoming call",
            ),
        ];
        for (text, fr, en) in cases {
            assert_eq!(text.render(PushLanguage::French), fr, "{text:?} in French");
            assert_eq!(
                text.render(PushLanguage::English),
                en,
                "{text:?} in English"
            );
        }
        assert_eq!(
            PushText::VideoCallIncoming.render(PushLanguage::English),
            "\u{1f4f9} Incoming video call"
        );
    }

    /// The tags `push_context.json` can hold: Paraglide writes `fr` or `en`, older builds and other
    /// writers may add a region, and a device that never mirrored passes the empty string.
    #[test]
    fn a_locale_tag_reads_as_the_language_the_native_tables_would_use() {
        for (tag, want) in [
            ("en", PushLanguage::English),
            ("en-GB", PushLanguage::English),
            ("EN_us", PushLanguage::English),
            (" en ", PushLanguage::English),
            ("fr", PushLanguage::French),
            ("fr-FR", PushLanguage::French),
            ("", PushLanguage::French),
            ("de", PushLanguage::French),
        ] {
            assert_eq!(PushLanguage::from_tag(tag), want, "tag {tag:?}");
        }
    }
}
