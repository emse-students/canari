// Who may see whose presence (WP-PRESENCE, decided by the user 2026-10-18).
//
// Presence ("is X online") is visible only to a viewer who shares a conversation or a community
// with X. The gateway owns no table that says who shares what, so it ASKS the two services that
// do - each about its own tables - and takes the union:
//
//   chat-delivery  POST /api/internal/presence/shared-conversations   (dm_group_members)
//   social-service POST /api/internal/presence/shared-communities     (channel_members)
//
// Both calls carry `X-Internal-Secret` and answer the subset of the asked ids, lowercased.

use std::collections::HashSet;
use std::time::Duration;

/// How long one audience question may take before the presence read gives up and answers 503.
const AUDIENCE_TIMEOUT: Duration = Duration::from_secs(5);

/// Why the audience could not be established. Never a reason to answer anything but a 503: a
/// presence read the gateway could not authorise is not "nobody is visible".
#[derive(Debug)]
pub enum AudienceError {
    /// `INTERNAL_SECRET` is unset, so both services would refuse every question (they fail closed).
    NotConfigured,
    /// A service could not be reached, or answered something other than a 2xx with the expected body.
    Upstream {
        service: &'static str,
        detail: String,
    },
}

impl std::fmt::Display for AudienceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AudienceError::NotConfigured => write!(f, "INTERNAL_SECRET is not configured"),
            AudienceError::Upstream { service, detail } => write!(f, "{service}: {detail}"),
        }
    }
}

/// The client that asks chat-delivery and social-service who shares something with a viewer.
pub struct PresenceAudience {
    http: reqwest::Client,
    delivery_url: String,
    social_url: String,
    internal_secret: String,
}

#[derive(serde::Deserialize)]
struct SharedAnswer {
    #[serde(rename = "userIds")]
    user_ids: Vec<String>,
}

impl PresenceAudience {
    /// `delivery_url` and `social_url` are the internal bases WITHOUT the `/api` prefix (as the
    /// compose files name them, `http://chat-delivery-service:3010`); the prefix is added here so
    /// no call site has to remember it.
    pub fn new(delivery_url: String, social_url: String, internal_secret: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(AUDIENCE_TIMEOUT)
            .build()
            .expect("reqwest client with a timeout always builds");
        PresenceAudience {
            http,
            delivery_url: delivery_url.trim_end_matches('/').to_string(),
            social_url: social_url.trim_end_matches('/').to_string(),
            internal_secret,
        }
    }

    /// The subset of `targets` (lowercased ids) whose presence `viewer` (lowercased) may read.
    ///
    /// The viewer always sees themself, without asking anybody. Everyone else must share a live
    /// conversation (chat-delivery) or a community (social-service) with the viewer. Both services
    /// are asked concurrently, and EITHER failing fails the whole question: half an audience
    /// would silently hide the people the missing half would have shown.
    pub async fn visible_to(
        &self,
        viewer: &str,
        targets: &[String],
    ) -> Result<HashSet<String>, AudienceError> {
        let mut visible: HashSet<String> = HashSet::new();
        let mut others: Vec<String> = Vec::new();
        for target in targets {
            if target == viewer {
                visible.insert(target.clone());
            } else {
                others.push(target.clone());
            }
        }
        if others.is_empty() {
            return Ok(visible);
        }
        if self.internal_secret.is_empty() {
            return Err(AudienceError::NotConfigured);
        }
        let body = serde_json::json!({ "viewerId": viewer, "userIds": others });
        let (conversations, communities) = tokio::join!(
            self.ask(
                "chat-delivery",
                &self.delivery_url,
                "shared-conversations",
                &body
            ),
            self.ask(
                "social-service",
                &self.social_url,
                "shared-communities",
                &body
            ),
        );
        visible.extend(conversations?);
        visible.extend(communities?);
        Ok(visible)
    }

    async fn ask(
        &self,
        service: &'static str,
        base: &str,
        route: &str,
        body: &serde_json::Value,
    ) -> Result<Vec<String>, AudienceError> {
        let url = format!("{base}/api/internal/presence/{route}");
        let upstream = |detail: String| AudienceError::Upstream { service, detail };
        let res = self
            .http
            .post(&url)
            .header("x-internal-secret", &self.internal_secret)
            .json(body)
            .send()
            .await
            .map_err(|e| upstream(format!("unreachable: {e}")))?;
        let status = res.status();
        if !status.is_success() {
            return Err(upstream(format!("answered {status}")));
        }
        let answer: SharedAnswer = res
            .json()
            .await
            .map_err(|e| upstream(format!("unreadable answer: {e}")))?;
        Ok(answer.user_ids)
    }
}

/// A fake chat-delivery + social-service on loopback, answering the two audience routes the way
/// the real ones do (the subset of the asked ids, lowercased) - and refusing with a 403 when the
/// `X-Internal-Secret` is not the one it was built with, as the real ones fail closed.
#[cfg(test)]
pub mod tests_support {
    use axum::{
        Json, Router,
        extract::State,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
    };
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone)]
    pub struct FakeServices {
        secret: String,
        conversations: Vec<String>,
        communities: Vec<String>,
        hits: Arc<AtomicUsize>,
    }

    impl FakeServices {
        pub fn new(secret: &str, conversations: &[&str], communities: &[&str]) -> Self {
            FakeServices {
                secret: secret.to_string(),
                conversations: conversations.iter().map(|s| s.to_string()).collect(),
                communities: communities.iter().map(|s| s.to_string()).collect(),
                hits: Arc::new(AtomicUsize::new(0)),
            }
        }

        /// How many audience questions reached either fake service.
        pub fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
    }

    fn answer(
        fake: &FakeServices,
        shared: &[String],
        headers: &HeaderMap,
        body: &serde_json::Value,
    ) -> axum::response::Response {
        fake.hits.fetch_add(1, Ordering::SeqCst);
        let secret = headers
            .get("x-internal-secret")
            .and_then(|v| v.to_str().ok());
        if secret != Some(fake.secret.as_str()) {
            return StatusCode::FORBIDDEN.into_response();
        }
        let asked: Vec<String> = body["userIds"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_lowercase))
                    .collect()
            })
            .unwrap_or_default();
        let user_ids: Vec<&String> = asked.iter().filter(|id| shared.contains(id)).collect();
        Json(serde_json::json!({ "userIds": user_ids })).into_response()
    }

    /// Starts the fake and returns its base URL (no `/api`, like the compose variables).
    pub async fn spawn_fake_services(fake: FakeServices) -> String {
        let app = Router::new()
            .route(
                "/api/internal/presence/shared-conversations",
                post(
                    |State(f): State<FakeServices>,
                     headers: HeaderMap,
                     Json(body): Json<serde_json::Value>| async move {
                        answer(&f, &f.conversations, &headers, &body)
                    },
                ),
            )
            .route(
                "/api/internal/presence/shared-communities",
                post(
                    |State(f): State<FakeServices>,
                     headers: HeaderMap,
                     Json(body): Json<serde_json::Value>| async move {
                        answer(&f, &f.communities, &headers, &body)
                    },
                ),
            )
            .with_state(fake);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::{FakeServices, spawn_fake_services};
    use super::*;

    const SECRET: &str = "internal-secret-for-tests";

    async fn audience(fake: FakeServices) -> PresenceAudience {
        let base = spawn_fake_services(fake).await;
        PresenceAudience::new(format!("{base}/"), base, SECRET.to_string())
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn the_audience_is_the_union_of_conversations_and_communities_plus_the_viewer() {
        let a = audience(FakeServices::new(SECRET, &["bob"], &["carol"])).await;
        let visible = a
            .visible_to("alice", &ids(&["alice", "bob", "carol", "mallory"]))
            .await
            .unwrap();
        let mut got: Vec<&String> = visible.iter().collect();
        got.sort();
        assert_eq!(got, vec!["alice", "bob", "carol"]);
    }

    #[tokio::test]
    async fn asking_only_about_oneself_asks_nobody() {
        let fake = FakeServices::new(SECRET, &[], &[]);
        let a = audience(fake.clone()).await;
        let visible = a.visible_to("alice", &ids(&["alice"])).await.unwrap();
        assert!(visible.contains("alice"));
        assert_eq!(fake.hits(), 0);
    }

    #[tokio::test]
    async fn either_service_failing_fails_the_whole_question() {
        // Half an audience would hide exactly the people the missing half would have shown.
        let a = audience(FakeServices::new("not-our-secret", &["bob"], &["carol"])).await;
        let err = a.visible_to("alice", &ids(&["bob"])).await.unwrap_err();
        assert!(matches!(err, AudienceError::Upstream { .. }), "{err}");
    }

    #[tokio::test]
    async fn an_unreachable_service_is_an_error_not_an_empty_audience() {
        let a = PresenceAudience::new(
            "http://127.0.0.1:1".to_string(),
            "http://127.0.0.1:1".to_string(),
            SECRET.to_string(),
        );
        assert!(a.visible_to("alice", &ids(&["bob"])).await.is_err());
    }

    #[tokio::test]
    async fn an_unset_secret_is_named_rather_than_sent() {
        let a = PresenceAudience::new(String::new(), String::new(), String::new());
        let err = a.visible_to("alice", &ids(&["bob"])).await.unwrap_err();
        assert!(matches!(err, AudienceError::NotConfigured));
    }
}
