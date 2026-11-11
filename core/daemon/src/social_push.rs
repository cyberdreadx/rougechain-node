//! Push notifications for social activity (RouGee likes, comments, reposts, follows).
//!
//! Rides the existing Expo dispatcher (`push.rs`): recipients are signing pubkeys,
//! the same key Qwalla registers its push token under, so anyone using RouGee
//! through Qwalla gets these with no extra setup.
//!
//! - Never notifies you about your own actions.
//! - Like / repost / follow are de-duplicated per (kind, actor, target) for
//!   [`DEDUPE_WINDOW`], so like→unlike→like doesn't send three pushes.
//! - Fire-and-forget like the rest of push: never blocks or fails the request.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::push::PushDispatcher;

pub const DEDUPE_WINDOW: Duration = Duration::from_secs(6 * 60 * 60);
const DEDUPE_MAX_ENTRIES: usize = 20_000;
const APP_URL: &str = "https://rougee.app";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocialKind {
    Like,
    Repost,
    Follow,
    Comment,
}

impl SocialKind {
    fn as_str(self) -> &'static str {
        match self {
            SocialKind::Like => "like",
            SocialKind::Repost => "repost",
            SocialKind::Follow => "follow",
            SocialKind::Comment => "comment",
        }
    }
    fn deduped(self) -> bool {
        !matches!(self, SocialKind::Comment)
    }
}

fn dedupe_map() -> &'static Mutex<HashMap<String, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// True the first time (kind, actor, target) is seen within the window.
fn first_in_window(key: String, now: Instant, map: &Mutex<HashMap<String, Instant>>) -> bool {
    let mut m = match map.lock() {
        Ok(m) => m,
        Err(p) => p.into_inner(),
    };
    if m.len() > DEDUPE_MAX_ENTRIES {
        m.retain(|_, t| now.duration_since(*t) < DEDUPE_WINDOW);
    }
    match m.get(&key) {
        Some(t) if now.duration_since(*t) < DEDUPE_WINDOW => false,
        _ => {
            m.insert(key, now);
            true
        }
    }
}

/// A short, plain-text preview of a comment body. RouGee bodies can be JSON
/// envelopes (media comments etc.) — those get no preview rather than raw JSON.
pub fn comment_preview(body: &str) -> Option<String> {
    let t = body.trim();
    if t.is_empty() || t.starts_with('{') {
        return None;
    }
    let mut s: String = t.chars().take(80).collect();
    if t.chars().count() > 80 {
        s.push('…');
    }
    Some(s)
}

/// Build (title, body) for a notification.
pub fn message(kind: SocialKind, actor_name: Option<&str>, preview: Option<&str>) -> (String, String) {
    let who = actor_name
        .filter(|n| !n.is_empty())
        .map(|n| format!("@{}", n.trim_start_matches('@')))
        .unwrap_or_else(|| "Someone".to_string());
    let body = match kind {
        SocialKind::Like => "liked your post".to_string(),
        SocialKind::Repost => "reposted your post".to_string(),
        SocialKind::Follow => "started following you".to_string(),
        SocialKind::Comment => match preview {
            Some(p) => format!("commented: {}", p),
            None => "commented on your post".to_string(),
        },
    };
    (who, body)
}

/// Notify `recipient` that `actor` did `kind` (optionally on `post_id`).
pub fn notify(
    push: &PushDispatcher,
    kind: SocialKind,
    actor: &str,
    actor_name: Option<&str>,
    recipient: &str,
    post_id: Option<&str>,
    preview: Option<&str>,
) {
    if recipient.is_empty() || actor.is_empty() || recipient == actor {
        return;
    }
    if kind.deduped() {
        let key = format!("{}:{}:{}", kind.as_str(), actor, post_id.unwrap_or(recipient));
        if !first_in_window(key, Instant::now(), dedupe_map()) {
            return;
        }
    }
    let (title, body) = message(kind, actor_name, preview);
    let url = match post_id {
        Some(id) => format!("{}/p/{}", APP_URL, id),
        None => format!("{}/activity", APP_URL),
    };
    push.notify_to(
        vec![recipient.to_string()],
        &title,
        &body,
        json!({
            "type": "social",
            "app": "rougee",
            "kind": kind.as_str(),
            "postId": post_id,
            "actor": actor,
            "url": url,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_allows_first_then_blocks_within_window() {
        let map = Mutex::new(HashMap::new());
        let t0 = Instant::now();
        assert!(first_in_window("like:a:p1".into(), t0, &map));
        assert!(!first_in_window("like:a:p1".into(), t0 + Duration::from_secs(60), &map));
        assert!(first_in_window("like:b:p1".into(), t0, &map)); // different actor
        assert!(first_in_window("like:a:p2".into(), t0, &map)); // different post
        assert!(first_in_window("like:a:p1".into(), t0 + DEDUPE_WINDOW + Duration::from_secs(1), &map));
    }

    #[test]
    fn messages_and_previews() {
        assert_eq!(message(SocialKind::Like, Some("rougee"), None), ("@rougee".into(), "liked your post".into()));
        assert_eq!(message(SocialKind::Follow, None, None).0, "Someone");
        assert_eq!(message(SocialKind::Comment, Some("@bob"), Some("nice")), ("@bob".into(), "commented: nice".into()));
        assert_eq!(comment_preview("{\"v\":1,\"t\":\"c\"}"), None);
        assert_eq!(comment_preview("  hi  "), Some("hi".into()));
        assert!(comment_preview(&"x".repeat(100)).unwrap().ends_with('…'));
    }

    #[test]
    fn never_notifies_self_or_empty() {
        // disabled dispatcher: just exercising the early returns without panicking
        let push = PushDispatcher::disabled();
        notify(&push, SocialKind::Like, "a", None, "a", Some("p"), None);
        notify(&push, SocialKind::Like, "", None, "b", Some("p"), None);
    }
}
