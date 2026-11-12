// Which pages may open a socket.
//
// A browser names the page that opens a WebSocket in the `Origin` header of the upgrade request,
// and nothing else in that request says where it comes from. The rule:
//
// - an `Origin` that is PRESENT must be one of the origins this estate serves its clients from
//   (`ALLOW_ORIGIN`), or the upgrade is refused;
// - an ABSENT `Origin` is accepted: only a client that opens its socket outside any page sends
//   none (a native socket library builds its request from the URL alone). Which clients of a given
//   socket those are, if any, is said where this rule is applied.
//
// `*` IS NEVER A LIST. A wildcard means nobody wrote down who the clients are, so there is nothing
// to match a page against: every present `Origin` is refused and the configuration is accused. It
// does not fall back to accepting everything - a fallback is a signal, never a path.

/// The origins a socket upgrade may come from, as configured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpgradeOrigins {
    /// The exact origins of `ALLOW_ORIGIN`, as written.
    Listed(Vec<String>),
    /// `ALLOW_ORIGIN` is `*` (or unset): no list exists.
    Wildcard,
}

/// Why an upgrade was refused for its `Origin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OriginRefusal {
    /// The origin is not one of the listed ones.
    NotListed,
    /// No list is configured (`*`), so no origin can be matched.
    NoList,
}

impl UpgradeOrigins {
    /// Reads a raw `ALLOW_ORIGIN` value: a comma-separated list (blank segments dropped), or `*`.
    pub fn parse(raw: &str) -> Self {
        if raw.trim() == "*" {
            return Self::Wildcard;
        }
        Self::Listed(
            raw.split(',')
                .map(str::trim)
                .filter(|segment| !segment.is_empty())
                .map(str::to_string)
                .collect(),
        )
    }

    /// Whether an upgrade whose `Origin` header is `origin` (`None` when the request has none) may
    /// proceed.
    ///
    /// The comparison is EXACT: an origin is a scheme, a host and a
    /// port as the browser serialises them, and a browser never sends a trailing slash or another
    /// casing.
    pub fn admits(&self, origin: Option<&str>) -> Result<(), OriginRefusal> {
        let Some(origin) = origin else {
            return Ok(());
        };
        match self {
            Self::Wildcard => Err(OriginRefusal::NoList),
            Self::Listed(listed) => {
                if listed.iter().any(|allowed| allowed == origin) {
                    Ok(())
                } else {
                    Err(OriginRefusal::NotListed)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{OriginRefusal, UpgradeOrigins};

    fn listed() -> UpgradeOrigins {
        UpgradeOrigins::parse("https://app.example, tauri://localhost,,http://tauri.localhost,")
    }

    #[test]
    fn a_list_is_read_as_written_without_its_blanks() {
        assert_eq!(
            listed(),
            UpgradeOrigins::Listed(vec![
                "https://app.example".to_string(),
                "tauri://localhost".to_string(),
                "http://tauri.localhost".to_string(),
            ])
        );
    }

    #[test]
    fn a_listed_origin_is_admitted() {
        assert_eq!(listed().admits(Some("https://app.example")), Ok(()));
        assert_eq!(listed().admits(Some("tauri://localhost")), Ok(()));
    }

    #[test]
    fn a_request_with_no_origin_is_admitted() {
        assert_eq!(listed().admits(None), Ok(()));
        assert_eq!(UpgradeOrigins::Wildcard.admits(None), Ok(()));
        assert_eq!(UpgradeOrigins::parse("").admits(None), Ok(()));
    }

    #[test]
    fn an_origin_that_is_not_listed_is_refused() {
        for origin in [
            "https://other.example",
            // Another host of the same parent domain is another origin.
            "https://sibling.app.example",
            "https://app.example.other",
            // Another scheme or port is another origin.
            "http://app.example",
            "https://app.example:8443",
            // What a sandboxed frame or a local file sends.
            "null",
            "",
            // Not what a browser sends, so not matched either.
            "https://app.example/",
            "HTTPS://APP.EXAMPLE",
        ] {
            assert_eq!(
                listed().admits(Some(origin)),
                Err(OriginRefusal::NotListed),
                "{origin:?}"
            );
        }
    }

    #[test]
    fn a_wildcard_is_never_a_list() {
        assert_eq!(UpgradeOrigins::parse("*"), UpgradeOrigins::Wildcard);
        assert_eq!(UpgradeOrigins::parse(" * "), UpgradeOrigins::Wildcard);
        assert_eq!(
            UpgradeOrigins::Wildcard.admits(Some("https://app.example")),
            Err(OriginRefusal::NoList)
        );
    }

    #[test]
    fn an_empty_list_admits_no_page() {
        assert_eq!(
            UpgradeOrigins::parse(" , ").admits(Some("https://app.example")),
            Err(OriginRefusal::NotListed)
        );
    }
}
