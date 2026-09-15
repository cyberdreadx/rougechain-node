//! Expo push-notification dispatch.
//!
//! The daemon already stores an Expo push token per wallet (signing pubkey → token, in
//! `PushTokenStore`). This module is the *send* side: event hooks (transfer / message / mail)
//! hand a [`PushEvent`] to a fire-and-forget [`PushDispatcher`], and a single background task
//! resolves tokens, POSTs to Expo, and prunes tokens Expo reports as dead.
//!
//! Design goals:
//!   - **Never block the caller.** `notify()` only pushes onto an unbounded channel; the
//!     consensus/apply path and HTTP handlers never wait on network I/O.
//!   - **Fail open, quietly.** A down Expo, a missing token, or a bad response degrades to
//!     "no notification", never an error surfaced to the user or the chain.
//!   - **Self-healing.** On Expo's `DeviceNotRegistered` receipt we drop that token so the
//!     store doesn't accumulate dead devices.
//!
//! Gated by `QV_PUSH_ENABLED` (default on; set `0`/`false` to disable). An optional
//! `EXPO_ACCESS_TOKEN` is sent as a bearer token when Expo's enhanced push security is on.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc;

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";
/// Expo accepts at most 100 messages per request.
const EXPO_CHUNK: usize = 100;

/// One notification addressed to one or more recipients (by signing pubkey).
#[derive(Debug, Clone)]
pub struct PushEvent {
    /// Recipient signing pubkeys — the same key the push token is registered under.
    pub to_pubkeys: Vec<String>,
    pub title: String,
    pub body: String,
    /// Arbitrary JSON delivered to the app (used for deep-linking / categorisation).
    pub data: Value,
}

/// Cheap-to-clone handle to the background dispatcher. A `disabled()` handle is a no-op.
#[derive(Clone)]
pub struct PushDispatcher {
    tx: Option<mpsc::UnboundedSender<PushEvent>>,
}

impl PushDispatcher {
    /// A handle that drops every event. Used when push is disabled.
    pub fn disabled() -> Self {
        Self { tx: None }
    }

    #[allow(dead_code)] // public accessor; not used internally yet
    pub fn is_enabled(&self) -> bool {
        self.tx.is_some()
    }

    /// Fire-and-forget. Never blocks; silently drops if push is disabled or the task is gone.
    pub fn notify(&self, event: PushEvent) {
        if event.to_pubkeys.is_empty() {
            return;
        }
        if let Some(tx) = &self.tx {
            let _ = tx.send(event);
        }
    }

    /// Convenience wrapper so call sites stay one-liners.
    pub fn notify_to(&self, to_pubkeys: Vec<String>, title: &str, body: &str, data: Value) {
        self.notify(PushEvent {
            to_pubkeys,
            title: title.to_string(),
            body: body.to_string(),
            data,
        });
    }
}

/// Spawn the background dispatcher and return a handle. The task lives for the process lifetime.
pub fn spawn(node: Arc<crate::L1Node>) -> PushDispatcher {
    let (tx, mut rx) = mpsc::unbounded_channel::<PushEvent>();
    let access_token = std::env::var("EXPO_ACCESS_TOKEN").ok().filter(|s| !s.is_empty());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            dispatch_one(&client, &node, access_token.as_deref(), ev).await;
        }
    });

    PushDispatcher { tx: Some(tx) }
}

/// Resolve tokens for one event and POST them to Expo in chunks, pruning dead tokens.
async fn dispatch_one(
    client: &reqwest::Client,
    node: &Arc<crate::L1Node>,
    access_token: Option<&str>,
    ev: PushEvent,
) {
    let keyrefs: Vec<&str> = ev.to_pubkeys.iter().map(|s| s.as_str()).collect();
    // (pubkey, token) pairs for recipients that actually have a registered token.
    let pairs = node.get_push_tokens_for_keys(&keyrefs);
    if pairs.is_empty() {
        return;
    }

    // Build one Expo message per valid Expo token, remembering which pubkey owns each token
    // so we can prune it if Expo says the device is gone.
    let mut messages: Vec<Value> = Vec::with_capacity(pairs.len());
    let mut owners: Vec<(String, String)> = Vec::with_capacity(pairs.len()); // (token, pubkey)
    for (pubkey, token) in &pairs {
        if !is_expo_token(token) {
            continue;
        }
        messages.push(json!({
            "to": token,
            "title": ev.title,
            "body": ev.body,
            "data": ev.data,
            "sound": "default",
            "priority": "high",
        }));
        owners.push((token.clone(), pubkey.clone()));
    }
    if messages.is_empty() {
        return;
    }

    for chunk in messages.chunks(EXPO_CHUNK) {
        let mut req = client
            .post(EXPO_PUSH_URL)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json");
        if let Some(t) = access_token {
            req = req.bearer_auth(t);
        }
        let resp = match req.json(&chunk).send().await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[push] send failed: {}", e);
                continue;
            }
        };
        let val: Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[push] bad response from Expo: {}", e);
                continue;
            }
        };
        // Expo returns { "data": [ { status, ... }, ... ] } in the same order as the request.
        if let Some(tickets) = val.get("data").and_then(|d| d.as_array()) {
            for (i, ticket) in tickets.iter().enumerate() {
                if ticket.get("status").and_then(|s| s.as_str()) != Some("error") {
                    continue;
                }
                let code = ticket
                    .get("details")
                    .and_then(|d| d.get("error"))
                    .and_then(|e| e.as_str());
                // Map the ticket back to its token via the message we sent at this index.
                let token = chunk
                    .get(i)
                    .and_then(|m| m.get("to"))
                    .and_then(|t| t.as_str());
                if code == Some("DeviceNotRegistered") {
                    if let Some(tok) = token {
                        if let Some((_, pubkey)) = owners.iter().find(|(t, _)| t == tok) {
                            let _ = node.unregister_push_token(pubkey);
                            let short = &pubkey[..pubkey.len().min(12)];
                            eprintln!("[push] pruned dead token for {}…", short);
                        }
                    }
                } else if let Some(c) = code {
                    eprintln!("[push] ticket error: {}", c);
                }
            }
        }
    }
}

/// Expo tokens look like `ExponentPushToken[...]` or `ExpoPushToken[...]`. Anything else
/// (a bare FCM/APNs token, or garbage) is skipped rather than POSTed.
fn is_expo_token(token: &str) -> bool {
    token.starts_with("ExponentPushToken[") || token.starts_with("ExpoPushToken[")
}
