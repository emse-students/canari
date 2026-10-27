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

/// `RunMsg.sport` (`libs/proto/canari.proto` `RunSport`), as the push words it. A number this
/// scanner was never taught is `Unspecified`, exactly as the app reads it (`canarun/activity.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunSport {
    Unspecified,
    Running,
    Cycling,
    Hiking,
    PoolSwim,
}

impl RunSport {
    /// Reads the proto enum value.
    pub fn from_proto(value: u64) -> Self {
        match value {
            1 => Self::Running,
            2 => Self::Cycling,
            3 => Self::Hiking,
            4 => Self::PoolSwim,
            _ => Self::Unspecified,
        }
    }
}

/// A distance as the push prints it: metres for a pool swim, kilometres with one decimal otherwise,
/// with the decimal separator of `language`.
fn run_distance(sport: RunSport, metres: u32, language: PushLanguage) -> String {
    if sport == RunSport::PoolSwim {
        return format!("{metres} m");
    }
    let km = format!("{:.1}", f64::from(metres) / 1000.0);
    match language {
        PushLanguage::French => format!("{} km", km.replace('.', ",")),
        PushLanguage::English => format!("{km} km"),
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
    /// A CanaReel sent in a conversation (`MediaMsg.intent = REEL_MESSAGE`, WP-RC-7), with the
    /// caption the sender typed when there is one. Unlike a photo, the caption FOLLOWS the
    /// announcement rather than replacing it: a reel expires, and a banner showing only its caption
    /// would not say there is a 30-day video to open.
    Reel(Option<&'a str>),
    Attachment,
    Poll(&'a str),
    /// A CanaRun activity card (`AppMessage.run`, field 15), with its distance in metres when the
    /// frame states a readable one (`None` for zero or past the reader's bound).
    Activity(RunSport, Option<u32>),
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
            Self::Reel(None) => s("\u{1f3ac} CanaReel", "\u{1f3ac} CanaReel"),
            Self::Reel(Some(caption)) => pick(
                format!("\u{1f3ac} CanaReel : {caption}"),
                format!("\u{1f3ac} CanaReel: {caption}"),
            ),
            Self::Attachment => s("\u{1f4ce} Pièce jointe", "\u{1f4ce} Attachment"),
            Self::Poll(question) => pick(
                format!("\u{1f4ca} Sondage : {question}"),
                format!("\u{1f4ca} Poll: {question}"),
            ),
            Self::Activity(sport, distance) => {
                let (emoji, fr, en) = match sport {
                    RunSport::Running => ("\u{1f3c3}", "Course", "Run"),
                    RunSport::Cycling => ("\u{1f6b4}", "Vélo", "Ride"),
                    RunSport::Hiking => ("\u{1f97e}", "Randonnée", "Hike"),
                    RunSport::PoolSwim => ("\u{1f3ca}", "Natation en piscine", "Pool swim"),
                    RunSport::Unspecified => ("\u{1f3c5}", "Activité", "Activity"),
                };
                match distance {
                    Some(m) => pick(
                        format!(
                            "{emoji} {fr} : {}",
                            run_distance(sport, m, PushLanguage::French)
                        ),
                        format!(
                            "{emoji} {en}: {}",
                            run_distance(sport, m, PushLanguage::English)
                        ),
                    ),
                    None => pick(format!("{emoji} {fr}"), format!("{emoji} {en}")),
                }
            }
            Self::VideoCallIncoming => s(
                "\u{1f4f9} Appel vidéo entrant",
                "\u{1f4f9} Incoming video call",
            ),
            Self::CallIncoming => s("\u{1f4de} Appel entrant", "\u{1f4de} Incoming call"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EVERY sentence, both languages, written out. The `match` guarantees each variant HAS two
    /// renderings; this guarantees the English one is English - a copy-pasted French arm compiles.
    #[test]
    fn every_sentence_is_written_in_both_languages() {
        let cases: [(PushText<'_>, &str, &str); 21] = [
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
            (
                PushText::Reel(None),
                "\u{1f3ac} CanaReel",
                "\u{1f3ac} CanaReel",
            ),
            (
                PushText::Reel(Some("Au gala")),
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

    /// A CanaRun card: the sport, then its distance in the unit the app prints it in, with the
    /// language's decimal separator - and the sport alone when the frame states no distance.
    #[test]
    fn an_activity_names_its_sport_and_distance_in_both_languages() {
        let cases: [(PushText<'_>, &str, &str); 6] = [
            (
                PushText::Activity(RunSport::Running, Some(5_230)),
                "\u{1f3c3} Course : 5,2 km",
                "\u{1f3c3} Run: 5.2 km",
            ),
            (
                PushText::Activity(RunSport::Cycling, Some(42_000)),
                "\u{1f6b4} Vélo : 42,0 km",
                "\u{1f6b4} Ride: 42.0 km",
            ),
            (
                PushText::Activity(RunSport::Hiking, Some(12_345)),
                "\u{1f97e} Randonnée : 12,3 km",
                "\u{1f97e} Hike: 12.3 km",
            ),
            (
                PushText::Activity(RunSport::PoolSwim, Some(1_500)),
                "\u{1f3ca} Natation en piscine : 1500 m",
                "\u{1f3ca} Pool swim: 1500 m",
            ),
            (
                PushText::Activity(RunSport::Unspecified, Some(800)),
                "\u{1f3c5} Activité : 0,8 km",
                "\u{1f3c5} Activity: 0.8 km",
            ),
            (
                PushText::Activity(RunSport::Running, None),
                "\u{1f3c3} Course",
                "\u{1f3c3} Run",
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
    }

    #[test]
    fn a_sport_this_scanner_was_never_taught_is_unspecified() {
        assert_eq!(RunSport::from_proto(0), RunSport::Unspecified);
        assert_eq!(RunSport::from_proto(4), RunSport::PoolSwim);
        assert_eq!(RunSport::from_proto(99), RunSport::Unspecified);
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
