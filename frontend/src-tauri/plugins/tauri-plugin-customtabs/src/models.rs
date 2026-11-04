use serde::{Deserialize, Serialize};

/// How the in-app browser surface `open_custom_tab` presented came to an end, as the NATIVE side
/// knows it - the page decides what to do with its busy sign-in button from this, never from a
/// clock.
///
/// - `Completed` (iOS): the session intercepted the `fr.emse.canari://` redirect and re-opened it
///   through the app's own scheme, so the shared deep-link pipeline (`/auth/callback`) takes over.
/// - `Cancelled` (iOS): the user closed the sheet (its close button, "Annuler" on the consent
///   alert) - nothing comes back, and the page must hand its button back.
/// - `HandedOff` (Android): the Chrome Custom Tab is a separate activity the OS owns; the plugin
///   cannot see it end, and its end IS the app's foreground edge, which the page already observes.
///
/// A session that failed for any other reason is not an outcome: the command REJECTS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CustomTabOutcome {
    Completed,
    Cancelled,
    HandedOff,
}

/// What `open_custom_tab` answers: `{ "outcome": "completed" | "cancelled" | "handedOff" }`.
/// Deserialising it here is the type boundary - an outcome the native side invents and this enum
/// does not name fails the command instead of reaching the page as a string nobody handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenCustomTabResponse {
    pub outcome: CustomTabOutcome,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_outcome_round_trips_under_its_wire_name() {
        for (outcome, wire) in [
            (CustomTabOutcome::Completed, "completed"),
            (CustomTabOutcome::Cancelled, "cancelled"),
            (CustomTabOutcome::HandedOff, "handedOff"),
        ] {
            let json = format!(r#"{{"outcome":"{wire}"}}"#);
            let parsed: OpenCustomTabResponse = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed.outcome, outcome);
            assert_eq!(serde_json::to_string(&parsed).unwrap(), json);
        }
    }

    #[test]
    fn an_unknown_outcome_is_refused() {
        assert!(
            serde_json::from_str::<OpenCustomTabResponse>(r#"{"outcome":"presented"}"#).is_err()
        );
    }
}
