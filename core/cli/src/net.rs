//! Which node the CLI talks to, and how request URLs are formed.
//!
//! Every request goes to `<base>/api/...` — including JSON-RPC, at `<base>/api/rpc`, because the
//! public hosts only proxy `/api/` to the node (the node itself serves both `/rpc` and
//! `/api/rpc`). `normalize_base` turns whatever the operator typed into that `<base>`.

pub const MAINNET_RPC: &str = "https://api.rougechain.io";
pub const TESTNET_RPC: &str = "https://testnet.rougechain.io";

/// Normalise an `--rpc` value to a base URL with no trailing slash and no `/api` suffix, so that
/// `https://host`, `https://host/`, `https://host/api`, `https://host/api/`, `https://host/rpc`
/// and `https://host/api/rpc` all mean the same node and never produce `/api/api/...`.
pub fn normalize_base(input: &str) -> Result<String, String> {
    let s = input.trim();
    let rest = if let Some(r) = s.strip_prefix("https://") {
        r
    } else if let Some(r) = s.strip_prefix("http://") {
        r
    } else {
        return Err(format!("--rpc must start with http:// or https:// (got '{}')", input));
    };
    if s.chars().any(|c| c.is_whitespace()) || s.contains('?') || s.contains('#') {
        return Err(format!("--rpc must be a plain base URL without spaces, '?' or '#' (got '{}')", input));
    }
    let scheme_len = s.len() - rest.len();
    let mut path_end = s.len();
    loop {
        let cur = &s[..path_end];
        if cur.len() > scheme_len && cur.ends_with('/') {
            path_end -= 1;
            continue;
        }
        // Only strip a suffix that is a whole path segment after the host.
        let after_scheme = &cur[scheme_len..];
        let stripped = ["/api/rpc", "/rpc", "/api"].iter().find_map(|suffix| {
            after_scheme.strip_suffix(suffix).filter(|host_part| !host_part.is_empty()).map(|_| suffix.len())
        });
        match stripped {
            Some(n) => path_end -= n,
            None => break,
        }
    }
    let base = &s[..path_end];
    let host = &base[scheme_len..];
    if host.is_empty() || host.starts_with('/') {
        return Err(format!("--rpc has no host (got '{}')", input));
    }
    Ok(base.to_string())
}

/// Pick the base URL: an explicit `--rpc` wins; otherwise `--network` (default mainnet).
pub fn resolve_base(rpc: Option<&str>, network: Option<&str>) -> Result<String, String> {
    if let Some(r) = rpc {
        return normalize_base(r);
    }
    match network.unwrap_or("mainnet") {
        "mainnet" => Ok(MAINNET_RPC.to_string()),
        "testnet" => Ok(TESTNET_RPC.to_string()),
        other => Err(format!("--network must be 'mainnet' or 'testnet' (got '{}')", other)),
    }
}

/// `<base>` + an absolute path such as `/api/health`.
pub fn url(base: &str, path: &str) -> String {
    format!("{}{}", base, path)
}

/// The JSON-RPC endpoint for `<base>`.
pub fn rpc_url(base: &str) -> String {
    url(base, "/api/rpc")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_spellings_of_a_host_normalise_to_one_base() {
        for input in [
            "https://api.rougechain.io",
            "https://api.rougechain.io/",
            "https://api.rougechain.io//",
            "https://api.rougechain.io/api",
            "https://api.rougechain.io/api/",
            "https://api.rougechain.io/rpc",
            "https://api.rougechain.io/api/rpc",
            "https://api.rougechain.io/api/rpc/",
            "  https://api.rougechain.io/api  ",
        ] {
            assert_eq!(normalize_base(input).unwrap(), "https://api.rougechain.io", "input: {input}");
        }
    }

    #[test]
    fn local_nodes_with_and_without_api() {
        for input in ["http://127.0.0.1:5100", "http://127.0.0.1:5100/", "http://127.0.0.1:5100/api", "http://127.0.0.1:5100/api/"] {
            assert_eq!(normalize_base(input).unwrap(), "http://127.0.0.1:5100", "input: {input}");
        }
        assert_eq!(normalize_base("http://localhost:5101/api").unwrap(), "http://localhost:5101");
        assert_eq!(normalize_base("http://[::1]:5100/api/").unwrap(), "http://[::1]:5100");
    }

    #[test]
    fn urls_never_contain_api_api() {
        for input in ["https://testnet.rougechain.io", "https://testnet.rougechain.io/api", "http://127.0.0.1:5101/api/", "https://node.example.com/api/rpc"] {
            let base = normalize_base(input).unwrap();
            for path in ["/api/health", "/api/v2/stake", "/api/tx/broadcast", "/api/validators"] {
                let u = url(&base, path);
                assert!(!u.contains("/api/api"), "{u}");
                assert!(!u[8..].contains("//"), "{u}");
                assert!(u.ends_with(path), "{u}");
            }
            let r = rpc_url(&base);
            assert!(r.ends_with("/api/rpc") && !r.contains("/api/api"), "{r}");
        }
    }

    #[test]
    fn a_path_prefix_is_kept_and_only_whole_segments_are_stripped() {
        assert_eq!(normalize_base("https://example.com/chain/api").unwrap(), "https://example.com/chain");
        assert_eq!(normalize_base("https://example.com/chain/").unwrap(), "https://example.com/chain");
        // "myapi" and "api.example.com" are not the /api suffix
        assert_eq!(normalize_base("https://example.com/myapi").unwrap(), "https://example.com/myapi");
        assert_eq!(normalize_base("https://api").unwrap(), "https://api");
        assert_eq!(normalize_base("https://rpc/rpc").unwrap(), "https://rpc");
    }

    #[test]
    fn bad_values_are_rejected() {
        for input in ["", "api.rougechain.io", "ftp://api.rougechain.io", "https://", "https:///api", "https://host/api?x=1", "https://host/#frag", "https://ho st"] {
            assert!(normalize_base(input).is_err(), "should reject: '{input}'");
        }
    }

    #[test]
    fn default_and_network_selection() {
        assert_eq!(resolve_base(None, None).unwrap(), "https://api.rougechain.io");
        assert_eq!(resolve_base(None, Some("mainnet")).unwrap(), "https://api.rougechain.io");
        assert_eq!(resolve_base(None, Some("testnet")).unwrap(), "https://testnet.rougechain.io");
        assert!(resolve_base(None, Some("devnet")).is_err());
        // an explicit --rpc wins over --network
        assert_eq!(resolve_base(Some("http://127.0.0.1:5101/api"), Some("testnet")).unwrap(), "http://127.0.0.1:5101");
        // the defaults are already normalised
        assert_eq!(normalize_base(MAINNET_RPC).unwrap(), MAINNET_RPC);
        assert_eq!(normalize_base(TESTNET_RPC).unwrap(), TESTNET_RPC);
        // the retired default host must not come back
        assert!(!MAINNET_RPC.contains("rougee.app"));
    }
}
