use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialComment {
    pub id: String,
    pub track_id: String,
    pub wallet_pubkey: String,
    pub body: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialPost {
    pub id: String,
    pub author_pubkey: String,
    pub body: String,
    pub reply_to_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TrackStats {
    pub plays: u64,
    pub likes: u64,
    pub comment_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ArtistStats {
    pub followers: u64,
    pub following: u64,
}

#[derive(Clone)]
pub struct SocialStore {
    db: Arc<sled::Db>,
}

impl SocialStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Result<Self, String> {
        let db_path = data_dir.as_ref().join("social-db");
        let db = sled::open(&db_path)
            .map_err(|e| format!("Failed to open social DB: {}", e))?;
        Ok(Self { db: Arc::new(db) })
    }

    // ── Tree accessors ──────────────────────────────────────

    fn play_counts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_play_counts").map_err(|e| e.to_string())
    }

    fn likes_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_likes").map_err(|e| e.to_string())
    }

    fn like_counts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_like_counts").map_err(|e| e.to_string())
    }

    fn user_likes_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_user_likes").map_err(|e| e.to_string())
    }

    fn comments_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_comments").map_err(|e| e.to_string())
    }

    fn track_comments_idx_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_track_comments_idx").map_err(|e| e.to_string())
    }

    fn comment_counts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_comment_counts").map_err(|e| e.to_string())
    }

    fn followers_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_followers").map_err(|e| e.to_string())
    }

    fn follower_counts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_follower_counts").map_err(|e| e.to_string())
    }

    fn following_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_following").map_err(|e| e.to_string())
    }

    fn following_counts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_following_counts").map_err(|e| e.to_string())
    }

    // ── Helpers ──────────────────────────────────────────────

    fn read_counter(tree: &sled::Tree, key: &[u8]) -> u64 {
        tree.get(key)
            .ok()
            .flatten()
            .map(|v| {
                let bytes: [u8; 8] = v.as_ref().try_into().unwrap_or([0; 8]);
                u64::from_be_bytes(bytes)
            })
            .unwrap_or(0)
    }

    fn increment_counter(tree: &sled::Tree, key: &[u8]) -> Result<u64, String> {
        let old = Self::read_counter(tree, key);
        let new_val = old.saturating_add(1);
        tree.insert(key, &new_val.to_be_bytes()).map_err(|e| e.to_string())?;
        Ok(new_val)
    }

    fn decrement_counter(tree: &sled::Tree, key: &[u8]) -> Result<u64, String> {
        let old = Self::read_counter(tree, key);
        let new_val = old.saturating_sub(1);
        tree.insert(key, &new_val.to_be_bytes()).map_err(|e| e.to_string())?;
        Ok(new_val)
    }

    // ── Plays ───────────────────────────────────────────────

    pub fn record_play(&self, track_id: &str) -> Result<u64, String> {
        let tree = self.play_counts_tree()?;
        Self::increment_counter(&tree, track_id.as_bytes())
    }

    pub fn get_play_count(&self, track_id: &str) -> Result<u64, String> {
        let tree = self.play_counts_tree()?;
        Ok(Self::read_counter(&tree, track_id.as_bytes()))
    }

    // ── Likes ───────────────────────────────────────────────

    /// Toggle like: returns (liked_now, new_total)
    pub fn toggle_like(&self, track_id: &str, wallet_pubkey: &str) -> Result<(bool, u64), String> {
        let likes = self.likes_tree()?;
        let counts = self.like_counts_tree()?;
        let user_likes = self.user_likes_tree()?;

        let like_key = format!("{}:{}", track_id, wallet_pubkey);
        let user_key = format!("{}:{}", wallet_pubkey, track_id);

        let already_liked = likes.contains_key(like_key.as_bytes()).map_err(|e| e.to_string())?;

        if already_liked {
            likes.remove(like_key.as_bytes()).map_err(|e| e.to_string())?;
            user_likes.remove(user_key.as_bytes()).map_err(|e| e.to_string())?;
            let total = Self::decrement_counter(&counts, track_id.as_bytes())?;
            Ok((false, total))
        } else {
            likes.insert(like_key.as_bytes(), b"1").map_err(|e| e.to_string())?;
            user_likes.insert(user_key.as_bytes(), b"1").map_err(|e| e.to_string())?;
            let total = Self::increment_counter(&counts, track_id.as_bytes())?;
            Ok((true, total))
        }
    }

    pub fn get_like_count(&self, track_id: &str) -> Result<u64, String> {
        let counts = self.like_counts_tree()?;
        Ok(Self::read_counter(&counts, track_id.as_bytes()))
    }

    pub fn is_liked(&self, track_id: &str, wallet_pubkey: &str) -> Result<bool, String> {
        let likes = self.likes_tree()?;
        let key = format!("{}:{}", track_id, wallet_pubkey);
        likes.contains_key(key.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn get_user_likes(&self, wallet_pubkey: &str) -> Result<Vec<String>, String> {
        let user_likes = self.user_likes_tree()?;
        let prefix = format!("{}:", wallet_pubkey);
        let mut track_ids = Vec::new();
        for entry in user_likes.scan_prefix(prefix.as_bytes()) {
            let (k, _) = entry.map_err(|e| e.to_string())?;
            let key_str = String::from_utf8_lossy(&k);
            if let Some(tid) = key_str.strip_prefix(&prefix) {
                track_ids.push(tid.to_string());
            }
        }
        Ok(track_ids)
    }

    // ── Comments ────────────────────────────────────────────

    pub fn add_comment(
        &self,
        track_id: &str,
        wallet_pubkey: &str,
        body: &str,
    ) -> Result<SocialComment, String> {
        let comment = SocialComment {
            id: Uuid::new_v4().to_string(),
            track_id: track_id.to_string(),
            wallet_pubkey: wallet_pubkey.to_string(),
            body: body.to_string(),
            timestamp: chrono::Utc::now().to_rfc3339(),
        };

        let comments = self.comments_tree()?;
        let idx = self.track_comments_idx_tree()?;
        let counts = self.comment_counts_tree()?;

        let bytes = serde_json::to_vec(&comment).map_err(|e| e.to_string())?;
        comments.insert(comment.id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;

        let idx_key = format!("{}:{}", track_id, comment.timestamp);
        idx.insert(idx_key.as_bytes(), comment.id.as_bytes()).map_err(|e| e.to_string())?;

        Self::increment_counter(&counts, track_id.as_bytes())?;

        Ok(comment)
    }

    pub fn delete_comment(&self, comment_id: &str, wallet_pubkey: &str) -> Result<(), String> {
        let comments = self.comments_tree()?;
        let idx = self.track_comments_idx_tree()?;
        let counts = self.comment_counts_tree()?;

        let v = comments.get(comment_id.as_bytes()).map_err(|e| e.to_string())?
            .ok_or_else(|| "Comment not found".to_string())?;
        let comment: SocialComment = serde_json::from_slice(&v).map_err(|e| e.to_string())?;

        if comment.wallet_pubkey != wallet_pubkey {
            return Err("Cannot delete another user's comment".to_string());
        }

        let idx_key = format!("{}:{}", comment.track_id, comment.timestamp);
        let _ = idx.remove(idx_key.as_bytes());
        comments.remove(comment_id.as_bytes()).map_err(|e| e.to_string())?;
        Self::decrement_counter(&counts, comment.track_id.as_bytes())?;

        Ok(())
    }

    pub fn get_comments(
        &self,
        track_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<SocialComment>, String> {
        let idx = self.track_comments_idx_tree()?;
        let comments = self.comments_tree()?;
        let prefix = format!("{}:", track_id);

        let mut result = Vec::new();
        let mut skipped = 0;

        for entry in idx.scan_prefix(prefix.as_bytes()) {
            let (_, v) = entry.map_err(|e| e.to_string())?;
            let cid = String::from_utf8_lossy(&v);
            if let Some(bytes) = comments.get(cid.as_bytes()).map_err(|e| e.to_string())? {
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                let c: SocialComment = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                result.push(c);
                if result.len() >= limit {
                    break;
                }
            }
        }
        Ok(result)
    }

    pub fn get_comment_count(&self, track_id: &str) -> Result<u64, String> {
        let counts = self.comment_counts_tree()?;
        Ok(Self::read_counter(&counts, track_id.as_bytes()))
    }

    // ── Follows ─────────────────────────────────────────────

    /// Toggle follow: returns (following_now, new_follower_count)
    pub fn toggle_follow(
        &self,
        follower_pubkey: &str,
        artist_pubkey: &str,
    ) -> Result<(bool, u64), String> {
        let followers = self.followers_tree()?;
        let follower_counts = self.follower_counts_tree()?;
        let following = self.following_tree()?;
        let following_counts = self.following_counts_tree()?;

        let fol_key = format!("{}:{}", artist_pubkey, follower_pubkey);
        let ing_key = format!("{}:{}", follower_pubkey, artist_pubkey);

        let already = followers.contains_key(fol_key.as_bytes()).map_err(|e| e.to_string())?;

        if already {
            followers.remove(fol_key.as_bytes()).map_err(|e| e.to_string())?;
            following.remove(ing_key.as_bytes()).map_err(|e| e.to_string())?;
            let count = Self::decrement_counter(&follower_counts, artist_pubkey.as_bytes())?;
            Self::decrement_counter(&following_counts, follower_pubkey.as_bytes())?;
            Ok((false, count))
        } else {
            followers.insert(fol_key.as_bytes(), b"1").map_err(|e| e.to_string())?;
            following.insert(ing_key.as_bytes(), b"1").map_err(|e| e.to_string())?;
            let count = Self::increment_counter(&follower_counts, artist_pubkey.as_bytes())?;
            Self::increment_counter(&following_counts, follower_pubkey.as_bytes())?;
            Ok((true, count))
        }
    }

    pub fn get_follower_count(&self, artist_pubkey: &str) -> Result<u64, String> {
        let counts = self.follower_counts_tree()?;
        Ok(Self::read_counter(&counts, artist_pubkey.as_bytes()))
    }

    pub fn get_following_count(&self, user_pubkey: &str) -> Result<u64, String> {
        let counts = self.following_counts_tree()?;
        Ok(Self::read_counter(&counts, user_pubkey.as_bytes()))
    }

    pub fn is_following(&self, follower_pubkey: &str, artist_pubkey: &str) -> Result<bool, String> {
        let followers = self.followers_tree()?;
        let key = format!("{}:{}", artist_pubkey, follower_pubkey);
        followers.contains_key(key.as_bytes()).map_err(|e| e.to_string())
    }

    pub fn get_user_following(&self, user_pubkey: &str) -> Result<Vec<String>, String> {
        let following = self.following_tree()?;
        let prefix = format!("{}:", user_pubkey);
        let mut artists = Vec::new();
        for entry in following.scan_prefix(prefix.as_bytes()) {
            let (k, _) = entry.map_err(|e| e.to_string())?;
            let key_str = String::from_utf8_lossy(&k);
            if let Some(apk) = key_str.strip_prefix(&prefix) {
                artists.push(apk.to_string());
            }
        }
        Ok(artists)
    }

    // ── Posts ────────────────────────────────────────────────

    fn posts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_posts").map_err(|e| e.to_string())
    }

    /// Author → post index: "pubkey:reverse_timestamp" → post_id
    /// Reverse timestamp (u64::MAX - millis) so lexicographic scan = newest first
    fn user_posts_idx_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_user_posts_idx").map_err(|e| e.to_string())
    }

    fn post_counts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_post_counts").map_err(|e| e.to_string())
    }

    /// Global timeline index: "reverse_timestamp:post_id" → post_id
    fn global_timeline_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_global_timeline").map_err(|e| e.to_string())
    }

    /// Reposts: "post_id:reposter_pubkey" → "1"
    fn reposts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_reposts").map_err(|e| e.to_string())
    }

    fn repost_counts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_repost_counts").map_err(|e| e.to_string())
    }

    /// Reply count per post
    fn reply_counts_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_reply_counts").map_err(|e| e.to_string())
    }

    /// Reply index: "parent_id:timestamp" → child_post_id
    fn reply_idx_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_reply_idx").map_err(|e| e.to_string())
    }

    fn reverse_ts() -> u64 {
        let now = chrono::Utc::now().timestamp_millis() as u64;
        u64::MAX - now
    }

    pub fn create_post(
        &self,
        author_pubkey: &str,
        body: &str,
        reply_to_id: Option<&str>,
    ) -> Result<SocialPost, String> {
        if body.len() > 4000 {
            return Err("Post body too long (max 4000 characters)".to_string());
        }

        let post = SocialPost {
            id: Uuid::new_v4().to_string(),
            author_pubkey: author_pubkey.to_string(),
            body: body.to_string(),
            reply_to_id: reply_to_id.map(|s| s.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
        };

        let posts = self.posts_tree()?;
        let user_idx = self.user_posts_idx_tree()?;
        let global_tl = self.global_timeline_tree()?;

        let bytes = serde_json::to_vec(&post).map_err(|e| e.to_string())?;
        posts.insert(post.id.as_bytes(), bytes.as_slice()).map_err(|e| e.to_string())?;

        let rev = Self::reverse_ts();
        let user_key = format!("{}:{:020}", author_pubkey, rev);
        user_idx.insert(user_key.as_bytes(), post.id.as_bytes()).map_err(|e| e.to_string())?;

        let global_key = format!("{:020}:{}", rev, post.id);
        global_tl.insert(global_key.as_bytes(), post.id.as_bytes()).map_err(|e| e.to_string())?;

        // Increment user post count
        let counts = self.post_counts_tree()?;
        Self::increment_counter(&counts, author_pubkey.as_bytes())?;

        // If this is a reply, increment parent reply count
        if let Some(parent_id) = reply_to_id {
            let reply_counts = self.reply_counts_tree()?;
            Self::increment_counter(&reply_counts, parent_id.as_bytes())?;
            let reply_idx = self.reply_idx_tree()?;
            let reply_key = format!("{}:{}", parent_id, post.created_at);
            reply_idx.insert(reply_key.as_bytes(), post.id.as_bytes()).map_err(|e| e.to_string())?;
        }

        Ok(post)
    }

    pub fn get_post(&self, post_id: &str) -> Result<Option<SocialPost>, String> {
        let posts = self.posts_tree()?;
        match posts.get(post_id.as_bytes()).map_err(|e| e.to_string())? {
            Some(v) => {
                let p: SocialPost = serde_json::from_slice(&v).map_err(|e| e.to_string())?;
                Ok(Some(p))
            }
            None => Ok(None),
        }
    }

    pub fn delete_post(&self, post_id: &str, author_pubkey: &str) -> Result<(), String> {
        let posts = self.posts_tree()?;
        let v = posts.get(post_id.as_bytes()).map_err(|e| e.to_string())?
            .ok_or_else(|| "Post not found".to_string())?;
        let post: SocialPost = serde_json::from_slice(&v).map_err(|e| e.to_string())?;

        if post.author_pubkey != author_pubkey {
            return Err("Cannot delete another user's post".to_string());
        }

        posts.remove(post_id.as_bytes()).map_err(|e| e.to_string())?;

        // Decrement user post count
        let counts = self.post_counts_tree()?;
        Self::decrement_counter(&counts, author_pubkey.as_bytes())?;

        // If reply, decrement parent reply count
        if let Some(ref parent_id) = post.reply_to_id {
            let reply_counts = self.reply_counts_tree()?;
            Self::decrement_counter(&reply_counts, parent_id.as_bytes())?;
        }

        Ok(())
    }

    /// Get posts by a specific user, newest first
    pub fn get_user_posts(
        &self,
        pubkey: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<SocialPost>, String> {
        let user_idx = self.user_posts_idx_tree()?;
        let posts = self.posts_tree()?;
        let prefix = format!("{}:", pubkey);

        let mut result = Vec::new();
        let mut skipped = 0;

        for entry in user_idx.scan_prefix(prefix.as_bytes()) {
            let (_, v) = entry.map_err(|e| e.to_string())?;
            let pid = String::from_utf8_lossy(&v);
            if let Some(bytes) = posts.get(pid.as_bytes()).map_err(|e| e.to_string())? {
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                let p: SocialPost = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                result.push(p);
                if result.len() >= limit {
                    break;
                }
            }
        }
        Ok(result)
    }

    pub fn get_user_post_count(&self, pubkey: &str) -> Result<u64, String> {
        let counts = self.post_counts_tree()?;
        Ok(Self::read_counter(&counts, pubkey.as_bytes()))
    }

    /// Global timeline (all posts, newest first)
    pub fn get_global_timeline(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<SocialPost>, String> {
        let global_tl = self.global_timeline_tree()?;
        let posts = self.posts_tree()?;

        let mut result = Vec::new();
        let mut skipped = 0;

        for entry in global_tl.iter() {
            let (_, v) = entry.map_err(|e| e.to_string())?;
            let pid = String::from_utf8_lossy(&v);
            if let Some(bytes) = posts.get(pid.as_bytes()).map_err(|e| e.to_string())? {
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                let p: SocialPost = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                result.push(p);
                if result.len() >= limit {
                    break;
                }
            }
        }
        Ok(result)
    }

    /// Following feed: posts from users this person follows, newest first.
    /// Merges each followed user's post stream.
    pub fn get_following_feed(
        &self,
        viewer_pubkey: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<SocialPost>, String> {
        let followed = self.get_user_following(viewer_pubkey)?;
        if followed.is_empty() {
            return Ok(Vec::new());
        }

        // Collect recent posts from each followed user (cap per user to avoid unbounded scan)
        let cap_per_user = limit + offset + 20;
        let mut all_posts: Vec<SocialPost> = Vec::new();
        for fpk in &followed {
            let user_posts = self.get_user_posts(fpk, cap_per_user, 0)?;
            all_posts.extend(user_posts);
        }

        // Sort newest first by created_at
        all_posts.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        Ok(all_posts.into_iter().skip(offset).take(limit).collect())
    }

    /// Get replies to a post
    pub fn get_replies(
        &self,
        post_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<SocialPost>, String> {
        let reply_idx = self.reply_idx_tree()?;
        let posts = self.posts_tree()?;
        let prefix = format!("{}:", post_id);

        let mut result = Vec::new();
        let mut skipped = 0;

        for entry in reply_idx.scan_prefix(prefix.as_bytes()) {
            let (_, v) = entry.map_err(|e| e.to_string())?;
            let cid = String::from_utf8_lossy(&v);
            if let Some(bytes) = posts.get(cid.as_bytes()).map_err(|e| e.to_string())? {
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                let p: SocialPost = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                result.push(p);
                if result.len() >= limit {
                    break;
                }
            }
        }
        Ok(result)
    }

    pub fn get_reply_count(&self, post_id: &str) -> Result<u64, String> {
        let reply_counts = self.reply_counts_tree()?;
        Ok(Self::read_counter(&reply_counts, post_id.as_bytes()))
    }

    // ── Reposts ─────────────────────────────────────────────

    /// Toggle repost: returns (reposted_now, new_total)
    pub fn toggle_repost(&self, post_id: &str, reposter_pubkey: &str) -> Result<(bool, u64), String> {
        let reposts = self.reposts_tree()?;
        let counts = self.repost_counts_tree()?;

        let key = format!("{}:{}", post_id, reposter_pubkey);

        let already = reposts.contains_key(key.as_bytes()).map_err(|e| e.to_string())?;

        if already {
            reposts.remove(key.as_bytes()).map_err(|e| e.to_string())?;
            let total = Self::decrement_counter(&counts, post_id.as_bytes())?;
            Ok((false, total))
        } else {
            reposts.insert(key.as_bytes(), b"1").map_err(|e| e.to_string())?;
            let total = Self::increment_counter(&counts, post_id.as_bytes())?;
            Ok((true, total))
        }
    }

    pub fn get_repost_count(&self, post_id: &str) -> Result<u64, String> {
        let counts = self.repost_counts_tree()?;
        Ok(Self::read_counter(&counts, post_id.as_bytes()))
    }

    pub fn has_reposted(&self, post_id: &str, pubkey: &str) -> Result<bool, String> {
        let reposts = self.reposts_tree()?;
        let key = format!("{}:{}", post_id, pubkey);
        reposts.contains_key(key.as_bytes()).map_err(|e| e.to_string())
    }

    /// Aggregate stats for a post (likes, reposts, replies, viewer state)
    pub fn get_post_stats(&self, post_id: &str, viewer_pubkey: Option<&str>) -> Result<serde_json::Value, String> {
        let likes = self.get_like_count(post_id)?;
        let reposts = self.get_repost_count(post_id)?;
        let replies = self.get_reply_count(post_id)?;
        let liked = match viewer_pubkey {
            Some(pk) => self.is_liked(post_id, pk)?,
            None => false,
        };
        let reposted = match viewer_pubkey {
            Some(pk) => self.has_reposted(post_id, pk)?,
            None => false,
        };
        Ok(serde_json::json!({
            "likes": likes,
            "reposts": reposts,
            "replies": replies,
            "liked": liked,
            "reposted": reposted,
        }))
    }

    // ── Hidden Tracks ────────────────────────────────────────

    fn hidden_tracks_tree(&self) -> Result<sled::Tree, String> {
        self.db.open_tree("social_hidden_tracks").map_err(|e| e.to_string())
    }

    /// Set or unset the hidden flag for a track. Key: "creator:track_id" → "1"
    pub fn set_track_hidden(&self, creator_pubkey: &str, track_id: &str, hidden: bool) -> Result<(), String> {
        let tree = self.hidden_tracks_tree()?;
        let key = format!("{}:{}", creator_pubkey, track_id);
        if hidden {
            tree.insert(key.as_bytes(), b"1").map_err(|e| e.to_string())?;
        } else {
            tree.remove(key.as_bytes()).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Get all hidden track IDs for a creator
    pub fn get_hidden_tracks(&self, creator_pubkey: &str) -> Result<Vec<String>, String> {
        let tree = self.hidden_tracks_tree()?;
        let prefix = format!("{}:", creator_pubkey);
        let mut ids = Vec::new();
        for entry in tree.scan_prefix(prefix.as_bytes()) {
            let (k, _) = entry.map_err(|e| e.to_string())?;
            let key_str = String::from_utf8_lossy(&k);
            if let Some(tid) = key_str.strip_prefix(&prefix) {
                ids.push(tid.to_string());
            }
        }
        Ok(ids)
    }

    /// Check if a specific track is hidden by its creator
    pub fn is_track_hidden(&self, creator_pubkey: &str, track_id: &str) -> Result<bool, String> {
        let tree = self.hidden_tracks_tree()?;
        let key = format!("{}:{}", creator_pubkey, track_id);
        tree.contains_key(key.as_bytes()).map_err(|e| e.to_string())
    }

    // ── Aggregate stats ─────────────────────────────────────

    pub fn get_track_stats(&self, track_id: &str, viewer_pubkey: Option<&str>) -> Result<serde_json::Value, String> {
        let plays = self.get_play_count(track_id)?;
        let likes = self.get_like_count(track_id)?;
        let comment_count = self.get_comment_count(track_id)?;
        let liked = match viewer_pubkey {
            Some(pk) => self.is_liked(track_id, pk)?,
            None => false,
        };
        Ok(serde_json::json!({
            "plays": plays,
            "likes": likes,
            "commentCount": comment_count,
            "liked": liked,
        }))
    }

    pub fn get_artist_stats(&self, pubkey: &str, viewer_pubkey: Option<&str>) -> Result<serde_json::Value, String> {
        let followers = self.get_follower_count(pubkey)?;
        let following = self.get_following_count(pubkey)?;
        let is_following = match viewer_pubkey {
            Some(vp) => self.is_following(vp, pubkey)?,
            None => false,
        };
        Ok(serde_json::json!({
            "followers": followers,
            "following": following,
            "isFollowing": is_following,
        }))
    }
}
