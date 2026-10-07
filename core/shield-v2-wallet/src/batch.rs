//! **Arrays of what nodes sent** (REVIEW_WALLET_6C RW6C-1).
//!
//! Two calls of a client take several node-supplied items at once: the pages of a round
//! (`scan_pages`) and the state reports of a round (`confirm_state`). On the JavaScript-facing
//! surface they arrive as ONE JSON text, an array the client wrote. That array must never be
//! read as one document: a parser that reads the whole text refuses the whole text for what a
//! single element holds — a string with a lone surrogate escape, a member nested deeper than
//! the parser's limit — and the refusal is then the CALLER's error (`request:`), for which the
//! client loop stops. One configured node could end every state check that way.
//!
//! So the array is only **split** here ([`json_array_elements`]), by a scanner that knows
//! brackets and strings and nothing else, and every element is then read **on its own**, with
//! exactly the classification its single-item path has: a page as `ListingPage::from_json` +
//! `scan` read it, a report as "a report, or no report from that node". Nothing an element
//! holds can make the split fail (see the function), so nothing a node sent can turn the call
//! into the caller's error.
//!
//! An element may also be a JSON **string** holding the body a node answered with, untouched
//! by the client ([`json_string_text`]) — the form in which the client never parses a node's
//! answer at all, and the recommended one (`UI_CONTRACT.md`, obligation 9).

use std::collections::BTreeSet;

use serde::Deserialize;

use crate::store::{canonical_node_id, hex32, StateReport};

/// The elements of a JSON array, each as its own text (trimmed), **without interpreting them**.
/// `None`: the text is not an array at the top level — it does not start with `[`, the bracket
/// is never closed, or something other than white space follows it.
///
/// The scanner tracks three things: whether it is inside a string (and whether the last
/// character was a backslash), how many `[` / `{` are open inside the outer array, and where the
/// commas at depth 0 are. It does not decode strings, does not read numbers and does not
/// recurse. Consequently, for an array whose elements are well-formed JSON — whatever
/// `JSON.stringify` writes — **no element can make it fail**: an escape (`\ud800` included) is
/// two skipped characters, nesting is a counter that returns to 0, and everything else is not
/// looked at. Whether an element is JSON at all is the business of whoever reads the element.
///
/// (An array the client itself wrote wrongly — an element with an unbalanced bracket or an
/// unterminated string — is not split element by element: brackets are counted, not matched.
/// It yields elements that their readers refuse, or `None`. `[]` has no element; `[a,]` has
/// two, the second empty.)
pub fn json_array_elements(text: &str) -> Option<Vec<&str>> {
    let bytes = text.as_bytes();
    let is_space = |c: u8| matches!(c, b' ' | b'\t' | b'\n' | b'\r');
    let open = bytes.iter().position(|c| !is_space(*c))?;
    if bytes[open] != b'[' {
        return None;
    }
    let mut out = Vec::new();
    let (mut start, mut depth, mut in_string, mut escaped, mut content) = (open + 1, 0usize, false, false, false);
    for i in open + 1..bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
            continue;
        }
        match c {
            b'"' => (in_string, content) = (true, true),
            b'[' | b'{' => {
                depth += 1;
                content = true;
            }
            b']' | b'}' if depth > 0 => depth -= 1,
            b']' => {
                // the outer array ends; `[]` (white space only, no comma) has no element
                if content || !out.is_empty() {
                    out.push(text[start..i].trim_matches([' ', '\t', '\n', '\r']));
                }
                return bytes[i + 1..].iter().all(|c| is_space(*c)).then_some(out);
            }
            b'}' => return None,
            b',' if depth == 0 => {
                out.push(text[start..i].trim_matches([' ', '\t', '\n', '\r']));
                (start, content) = (i + 1, false);
            }
            c if !is_space(c) => content = true,
            _ => {}
        }
    }
    None
}

/// The text a JSON string spells — `element` is one whole JSON string, quotes included. `None`:
/// not one string (no quotes, a quote inside that is not escaped, an escape JSON does not have).
///
/// Lenient where a node's bytes could otherwise decide the outcome: **a lone surrogate escape
/// is read as U+FFFD**, not refused (`JSON.stringify` writes one for a lone surrogate in a
/// JavaScript string), and unescaped control characters are taken as they are.
pub fn json_string_text(element: &str) -> Option<String> {
    let inner = element.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    let hex4 = |chars: &mut std::str::Chars<'_>| -> Option<u32> {
        let mut v = 0u32;
        for _ in 0..4 {
            v = v * 16 + chars.next()?.to_digit(16)?;
        }
        Some(v)
    };
    while let Some(c) = chars.next() {
        match c {
            '"' => return None,
            '\\' => match chars.next()? {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                '/' => out.push('/'),
                'b' => out.push('\u{8}'),
                'f' => out.push('\u{c}'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                'u' => {
                    let unit = hex4(&mut chars)?;
                    let scalar = match unit {
                        0xd800..=0xdbff => {
                            // a high surrogate: with the low one that follows, or alone
                            let mut ahead = chars.clone();
                            match (ahead.next(), ahead.next(), hex4(&mut ahead)) {
                                (Some('\\'), Some('u'), Some(low @ 0xdc00..=0xdfff)) => {
                                    chars = ahead;
                                    0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
                                }
                                _ => 0xfffd,
                            }
                        }
                        0xdc00..=0xdfff => 0xfffd,
                        other => other,
                    };
                    out.push(char::from_u32(scalar).unwrap_or('\u{fffd}'));
                }
                _ => return None,
            },
            c => out.push(c),
        }
    }
    Some(out)
}

/// The bodies of a batch of listing pages, one per element of the array `pages_json`, in order
/// — what `WalletState::scan_pages` is handed. `None`: `pages_json` is not an array.
///
/// * **An element that is a JSON string is the body a node answered with**, passed on
///   untouched by the client — the recommended form. The body is the text the string spells.
/// * Every other element is its own text, exactly as it stands in the array: an object the
///   client wrote back with `JSON.stringify`, or whatever else is there.
///
/// Either way the body is read by the reader of `scan`'s argument (`ListingPage::from_json`),
/// and nothing is re-written on the way: the two paths cannot disagree (a duplicate member is
/// refused by both, a body that is no page has one and the same text in both).
pub fn page_bodies(pages_json: &str) -> Option<Vec<String>> {
    Some(json_array_elements(pages_json)?.into_iter().map(|element| json_string_text(element).unwrap_or_else(|| element.to_string())).collect())
}

/// What [`read_state_reports`] made of an array of state reports.
#[derive(Debug, Default)]
pub struct ReadReports {
    /// The reports that are reports, in order: what `WalletState::confirm_state` is handed.
    pub reports: Vec<StateReport>,
    /// Elements that are not a report: unreadable as JSON, not an object, a member missing, of
    /// the wrong type or out of range. **No report from that node** — not an error, not a vote,
    /// not dissent.
    pub malformed: usize,
    /// Configured nodes whose report lacks only `ciphertext_acc` (an outdated build): no vote.
    pub outdated: BTreeSet<String>,
}

#[derive(Deserialize)]
struct ReportJson {
    node_id: String,
    height: u64,
    tree_root: String,
    nullifier_acc: String,
    note_count: u64,
    nullifier_count: u64,
    ciphertext_acc: String,
}

/// Reads the array of state reports a client hands to `confirm_state`, **element by element**.
/// `None`: `reports_json` is not an array (the caller's mistake). Whatever an ELEMENT is, the
/// call succeeds: an element that cannot be read is counted in `malformed` and the others are
/// read as if it were not there.
///
/// An element is one of:
///
/// * `{ "node_id": <the configured origin>, "stats": "<the body the node answered /api/shield-v2/stats with>" }`
///   — **recommended**: the client labels the answer and never parses it. The body's `report`
///   member is the report; `null` or absent is "this node has no report" (not counted as
///   malformed: an honest node before the pool's first block has none); a body that is not
///   JSON or not an object, or whose `report` is not an object, is malformed;
/// * `{ "node_id", "height", "tree_root", "nullifier_acc", "note_count", "nullifier_count",
///   "ciphertext_acc" }` — the report with the client's label, as an object;
/// * a JSON string holding the text of either of the two.
///
/// `nodes`: the configured set (canonical ids), to name an outdated node.
pub fn read_state_reports(reports_json: &str, nodes: &[String]) -> Option<ReadReports> {
    let mut out = ReadReports::default();
    for element in json_array_elements(reports_json)? {
        let text = match json_string_text(element) {
            Some(text) => text,
            None => element.to_string(),
        };
        let Ok(mut entry) = serde_json::from_str::<serde_json::Value>(&text) else {
            out.malformed += 1;
            continue;
        };
        // the labelled raw body: take its `report`
        if let (Some(node_id), Some(body)) = (entry.get("node_id").and_then(|v| v.as_str()).map(str::to_string), entry.get("stats").and_then(|v| v.as_str())) {
            // (a body that is not JSON, or not an object, is malformed; an OBJECT without a
            // report says "I have none")
            match serde_json::from_str::<serde_json::Value>(body).ok().filter(serde_json::Value::is_object).map(|mut stats| stats.get_mut("report").map(serde_json::Value::take)) {
                Some(None) | Some(Some(serde_json::Value::Null)) => continue, // no report: not an answer to count
                Some(Some(serde_json::Value::Object(mut report))) => {
                    report.insert("node_id".into(), serde_json::Value::String(node_id));
                    entry = serde_json::Value::Object(report);
                }
                _ => {
                    out.malformed += 1;
                    continue;
                }
            }
        }
        // everything a report needs but the ciphertext hash: an outdated node
        let lacks_only_the_ciphertext_hash = entry.get("ciphertext_acc").is_none_or(serde_json::Value::is_null) && {
            let mut filled = entry.clone();
            filled.as_object_mut().is_some_and(|o| {
                o.insert("ciphertext_acc".into(), serde_json::Value::String("00".repeat(32)));
                true
            }) && serde_json::from_value::<ReportJson>(filled).is_ok_and(|r| hex32(&r.tree_root).is_some() && hex32(&r.nullifier_acc).is_some())
        };
        if lacks_only_the_ciphertext_hash {
            match entry.get("node_id").and_then(|v| v.as_str()).and_then(|id| canonical_node_id(id).ok()).filter(|id| nodes.contains(id)) {
                Some(id) => {
                    out.outdated.insert(id);
                }
                None => out.malformed += 1,
            }
            continue;
        }
        let parsed = serde_json::from_value::<ReportJson>(entry).ok().and_then(|r| {
            Some(StateReport {
                tree_root: hex32(&r.tree_root)?,
                nullifier_acc: hex32(&r.nullifier_acc)?,
                ciphertext_acc: hex32(&r.ciphertext_acc)?,
                node_id: r.node_id,
                height: r.height,
                note_count: r.note_count,
                nullifier_count: r.nullifier_count,
            })
        });
        match parsed {
            Some(r) => out.reports.push(r),
            None => out.malformed += 1,
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_array_is_split_without_reading_its_elements() {
        let split = |t: &str| json_array_elements(t).map(|v| v.into_iter().map(str::to_string).collect::<Vec<_>>());
        let some = |v: &[&str]| Some(v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(split("[]"), some(&[]));
        assert_eq!(split(" \n[ \t ]\r\n"), some(&[]));
        assert_eq!(split("[1]"), some(&["1"]));
        assert_eq!(split("[ 1 , \"a,b]\" ,{\"k\":[1,2,{\"x\":\"]}\"}]} , [ [ ] , { } ] ,null]"), some(&["1", "\"a,b]\"", "{\"k\":[1,2,{\"x\":\"]}\"}]}", "[ [ ] , { } ]", "null"]));
        // escapes: a quote, a backslash before a quote, a lone surrogate
        assert_eq!(split(r#"["a\"b,]", "c\\", "\ud800", "\\\"]"]"#), some(&[r#""a\"b,]""#, r#""c\\""#, r#""\ud800""#, r#""\\\"]""#]));
        // depth is a counter: a thousand levels, and a member 200 deep
        let deep = format!("{}{}", "[".repeat(1_000), "]".repeat(1_000));
        assert_eq!(split(&format!("[{deep},{{\"x\":{}{}}},2]", "[".repeat(200), "]".repeat(200))).map(|v| (v.len(), v[0] == deep, v[2].clone())), Some((3, true, "2".into())));
        // elements that are not JSON are still elements: their readers refuse them
        assert_eq!(split("[,]"), some(&["", ""]));
        assert_eq!(split("[1,]"), some(&["1", ""]));
        assert_eq!(split("[nul, tru e, 1e, -]"), some(&["nul", "tru e", "1e", "-"]));
        assert_eq!(split("[\u{feff}1, é, \"ü\"]"), some(&["\u{feff}1", "é", "\"ü\""]));
        // not an array at the top level
        for not in ["", " ", "null", "{}", "7", "\"[]\"", "[", "[1", "[1,", "[\"a]", "[[1]", "[1]]", "[1] x", "[1}", "x[1]", "{\"a\":[1]}", "[\"\\\"]"] {
            assert_eq!(split(not), None, "{not:?}");
        }
    }

    #[test]
    fn a_json_string_is_decoded_leniently() {
        assert_eq!(json_string_text(r#""""#).as_deref(), Some(""));
        assert_eq!(json_string_text(r#""a\"b\\c\/d\n\t\r\b\f""#).as_deref(), Some("a\"b\\c/d\n\t\r\u{8}\u{c}"));
        assert_eq!(json_string_text(r#""\u00e9\u20ac\ud83d\ude00""#).as_deref(), Some("é€😀"));
        // lone surrogates, in every place: U+FFFD, never a refusal
        assert_eq!(json_string_text(r#""\ud800""#).as_deref(), Some("\u{fffd}"));
        assert_eq!(json_string_text(r#""a\udc00b\ud800\u0041\ud800""#).as_deref(), Some("a\u{fffd}b\u{fffd}A\u{fffd}"));
        assert_eq!(json_string_text("\"a\nb\"").as_deref(), Some("a\nb"));
        assert_eq!(json_string_text(r#""{\"x\":\"\\ud800\"}""#).as_deref(), Some(r#"{"x":"\ud800"}"#));
        for not in ["", "\"", "a", "\"a", "a\"", r#""a"b""#, r#""\q""#, r#""\u12""#, r#""\u12g4""#, r#""\""#, "{}", "7"] {
            assert_eq!(json_string_text(not), None, "{not:?}");
        }
    }
}
