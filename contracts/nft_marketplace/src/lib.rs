//! NFT marketplace — an example RougeChain escrow marketplace that pays creator royalties.
//!
//! Needs CONTRACT_NFT_ROYALTY (`host_nft_royalty_bps` / `host_nft_royalty_recipient`), payable calls
//! and the GAME_READY 2 NFT functions. All amounts are integer XRGE **quanta** (1 XRGE = 10^9).
//!
//! Flow (the order matters — see "Why list first"):
//! 1. `list {"collection":"col:…","token_id":7,"price":2500000000}` — the caller must own the NFT
//!    right now. Records a listing and returns/emits `listed` {"listing":N,"seller":…,…}.
//! 2. The seller sends the NFT to this contract's address with an ordinary wallet `nft_transfer`
//!    (no sale price, so no wallet royalty is charged on the escrow move).
//! 3. `buy {"listing":N}` with `attach: {"symbol":"XRGE","amount":<price>}`. The contract:
//!      royalty = price × bps / 10000   (integer quanta, rounded down)
//!      pays `royalty` to the collection's royalty recipient (host_transfer),
//!      pays `price − royalty` to the seller,
//!      moves the NFT to the buyer (host_nft_transfer),
//!    and emits `sold`. A wrong symbol or amount, a stale listing, or an NFT the contract does not
//!    hold yet makes the call fail (trap), so the attached payment goes back to the buyer.
//! 4. `cancel {"listing":N}` (seller only) — returns the NFT to the seller if the contract holds
//!    for this listing and deletes the listing; emits `cancelled`.
//!
//! Read-only (free through the node's query endpoint, no event, no storage write):
//! * `listing {"listing":N}` → {"listing":N,"exists":true,"seller":…,"collection":…,"token_id":…,
//!   "price":…,"active":…,"escrowed":…} or {"listing":N,"exists":false}.
//! * `listing_count {}` → {"next":N}: the highest listing id issued so far (0 = none).
//!
//! The seller is always the caller string exactly as the contract received it and stored it — for a
//! wallet that is the raw ML-DSA-65 public key hex, not its rouge1 address. `cancel` compares the
//! caller with that same string, and `buy` pays it with host_transfer (the ledger maps a key to its
//! rouge1 entry).
//!
//! Why list first: the contract can't see who deposited an NFT. If listing came after the deposit,
//! anyone watching the chain could list a freshly deposited NFT in their own name and collect the
//! sale. Requiring the lister to OWN the NFT at listing time closes that. Do NOT send an NFT to the
//! contract without listing it first: there is no admin and nothing could return it.
//!
//! Why the contract pays the royalty: `host_nft_transfer` moves an NFT without any royalty, and the
//! wallet `nft_transfer` royalty only applies to a wallet sale. The royalty recipient comes back in
//! canonical ledger form (rouge1… or a contract address), so `host_transfer` to it credits the same
//! entry a wallet sale would — including a royalty-splitter contract.

#![no_std]

use core::panic::PanicInfo;

extern "C" {
    fn host_get_caller(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_get_self_addr(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_get_args_len() -> i32;
    fn host_read_args(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_get_attached_amount() -> i64;
    fn host_get_attached_symbol(out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_storage_read(key_ptr: *const u8, key_len: u32, val_ptr: *mut u8, val_len: u32) -> i32;
    fn host_storage_write(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32);
    fn host_storage_delete(key_ptr: *const u8, key_len: u32);
    fn host_transfer(to_ptr: *const u8, to_len: u32, amount: i64) -> i32;
    fn host_nft_owner(col_ptr: *const u8, col_len: u32, token_id: i64, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_nft_transfer(col_ptr: *const u8, col_len: u32, token_id: i64, to_ptr: *const u8, to_len: u32) -> i32;
    fn host_nft_royalty_bps(col_ptr: *const u8, col_len: u32) -> i32;
    fn host_nft_royalty_recipient(col_ptr: *const u8, col_len: u32, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_pqc_pubkey_to_address(pk_ptr: *const u8, pk_len: u32, out_ptr: *mut u8, out_len: u32) -> i32;
    fn host_emit_event(topic_ptr: *const u8, topic_len: u32, data_ptr: *const u8, data_len: u32);
    fn host_set_return(data_ptr: *const u8, data_len: u32);
}

/// Fail the call: everything it did is discarded and an attached payment returns to the caller.
fn revert() -> ! {
    core::arch::wasm32::unreachable()
}

const BIG: usize = 8192; // fits a hex ML-DSA-65 public key (3,904 chars)
const MAX_COL: usize = 256;

static mut ARGS: [u8; 1024] = [0; 1024];
static mut CALLER: [u8; BIG] = [0; BIG];
static mut OWNER: [u8; BIG] = [0; BIG];
static mut RECIPIENT: [u8; BIG] = [0; BIG];
static mut PK: [u8; BIG / 2] = [0; BIG / 2];
static mut SELF: [u8; 128] = [0; 128];
/// Listing record: price (8) ‖ token_id (8) ‖ collection length (2) ‖ collection ‖ seller.
static mut REC: [u8; 18 + MAX_COL + BIG] = [0; 18 + MAX_COL + BIG];

fn buf(b: *mut [u8; BIG]) -> &'static mut [u8; BIG] { unsafe { &mut *b } }

fn caller() -> &'static [u8] {
    let c = buf(core::ptr::addr_of_mut!(CALLER));
    let n = unsafe { host_get_caller(c.as_mut_ptr(), BIG as u32) };
    if n <= 0 { revert(); }
    &c[..n as usize]
}

// ── Arguments: a tiny reader for the flat JSON object the call carries ──────────────────────

fn args() -> &'static [u8] {
    let a = unsafe { &mut *core::ptr::addr_of_mut!(ARGS) };
    let len = unsafe { host_get_args_len() };
    if len <= 0 || len as usize > a.len() { revert(); }
    let n = unsafe { host_read_args(a.as_mut_ptr(), a.len() as u32) };
    if n != len { revert(); }
    &a[..n as usize]
}

/// Position right after `"key":` (skipping spaces), or None.
fn find_value(json: &[u8], key: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + key.len() + 2 <= json.len() {
        if json[i] == b'"' && json[i + 1..].starts_with(key) && json.get(i + 1 + key.len()) == Some(&b'"') {
            let mut j = i + key.len() + 2;
            while j < json.len() && json[j] == b' ' { j += 1; }
            if json.get(j) == Some(&b':') {
                j += 1;
                while j < json.len() && json[j] == b' ' { j += 1; }
                return Some(j);
            }
        }
        i += 1;
    }
    None
}

/// An unsigned integer argument. Amounts are integer quanta: a fraction, sign or exponent traps.
fn arg_u64(json: &[u8], key: &[u8]) -> u64 {
    let Some(mut i) = find_value(json, key) else { revert() };
    let start = i;
    let mut v: u64 = 0;
    while i < json.len() && json[i].is_ascii_digit() {
        v = match v.checked_mul(10).and_then(|v| v.checked_add((json[i] - b'0') as u64)) { Some(v) => v, None => revert() };
        i += 1;
    }
    if i == start || matches!(json.get(i), Some(b'.') | Some(b'e') | Some(b'E')) { revert(); }
    v
}

/// A string argument without escapes.
fn arg_str<'a>(json: &'a [u8], key: &[u8]) -> &'a [u8] {
    let Some(i) = find_value(json, key) else { revert() };
    if json.get(i) != Some(&b'"') { revert(); }
    let mut j = i + 1;
    while j < json.len() && json[j] != b'"' {
        if json[j] == b'\\' { revert(); }
        j += 1;
    }
    if j >= json.len() { revert(); }
    &json[i + 1..j]
}

// ── Storage ─────────────────────────────────────────────────────────────────────────────────

fn listing_key(id: u64) -> [u8; 9] {
    let mut k = [0u8; 9];
    k[0] = b'L';
    k[1..].copy_from_slice(&id.to_be_bytes());
    k
}

/// "T" ‖ token_id ‖ collection → the NFT's current listing id. A newer listing replaces an older
/// one, so a stale listing can never sell an NFT that came back to the contract later.
fn token_key(col: &[u8], token_id: u64, out: &mut [u8; 9 + MAX_COL]) -> usize {
    out[0] = b'T';
    out[1..9].copy_from_slice(&token_id.to_be_bytes());
    out[9..9 + col.len()].copy_from_slice(col);
    9 + col.len()
}

fn read_u64(key: &[u8]) -> Option<u64> {
    let mut v = [0u8; 8];
    if unsafe { host_storage_read(key.as_ptr(), key.len() as u32, v.as_mut_ptr(), 8) } == 8 {
        Some(u64::from_be_bytes(v))
    } else {
        None
    }
}

fn write_u64(key: &[u8], v: u64) {
    unsafe { host_storage_write(key.as_ptr(), key.len() as u32, v.to_be_bytes().as_ptr(), 8) };
}

struct Listing { price: u64, token_id: u64, col: &'static [u8], seller: &'static [u8] }

fn try_load(id: u64) -> Option<Listing> {
    let rec = unsafe { &mut *core::ptr::addr_of_mut!(REC) };
    let key = listing_key(id);
    let n = unsafe { host_storage_read(key.as_ptr(), 9, rec.as_mut_ptr(), rec.len() as u32) };
    if n < 18 { return None; }
    let n = n as usize;
    let price = u64::from_be_bytes(rec[0..8].try_into().unwrap());
    let token_id = u64::from_be_bytes(rec[8..16].try_into().unwrap());
    let cl = u16::from_be_bytes([rec[16], rec[17]]) as usize;
    Some(Listing { price, token_id, col: &rec[18..18 + cl], seller: &rec[18 + cl..n] })
}

fn load(id: u64) -> Listing {
    match try_load(id) { Some(l) => l, None => revert() } // no such listing
}

/// Whether `id` is still the NFT's current listing (a newer listing of the same NFT replaces it).
fn is_current(id: u64, l: &Listing) -> bool {
    let mut tk = [0u8; 9 + MAX_COL];
    let tl = token_key(l.col, l.token_id, &mut tk);
    read_u64(&tk[..tl]) == Some(id)
}

fn delete(id: u64, l: &Listing) {
    let key = listing_key(id);
    unsafe { host_storage_delete(key.as_ptr(), 9) };
    let mut tk = [0u8; 9 + MAX_COL];
    let tl = token_key(l.col, l.token_id, &mut tk);
    if read_u64(&tk[..tl]) == Some(id) {
        unsafe { host_storage_delete(tk.as_ptr(), tl as u32) };
    }
}

// ── Ownership ───────────────────────────────────────────────────────────────────────────────

fn hex_val(c: u8) -> Option<u8> {
    match c { b'0'..=b'9' => Some(c - b'0'), b'a'..=b'f' => Some(c - b'a' + 10), b'A'..=b'F' => Some(c - b'A' + 10), _ => None }
}

/// Whether `owner` (as the NFT store holds it) is the caller: the same string, or the caller's
/// public key's rouge1 address (an NFT sent to a rouge1 address).
fn is_owner(owner: &[u8], caller: &[u8]) -> bool {
    if owner == caller { return true; }
    if !owner.starts_with(b"rouge1") || caller.len() % 2 != 0 || caller.len() / 2 > BIG / 2 { return false; }
    let pk = unsafe { &mut *core::ptr::addr_of_mut!(PK) };
    for i in 0..caller.len() / 2 {
        match (hex_val(caller[2 * i]), hex_val(caller[2 * i + 1])) {
            (Some(h), Some(l)) => pk[i] = h << 4 | l,
            _ => return false,
        }
    }
    let mut addr = [0u8; 128];
    let n = unsafe { host_pqc_pubkey_to_address(pk.as_ptr(), (caller.len() / 2) as u32, addr.as_mut_ptr(), 128) };
    n > 0 && &addr[..n as usize] == owner
}

// ── Output ──────────────────────────────────────────────────────────────────────────────────

/// Fits the largest payload: a 3,904-char public-key seller plus a 256-byte collection id.
const OUT_CAP: usize = BIG + MAX_COL + 256;
static mut OUT: [u8; OUT_CAP] = [0; OUT_CAP];

struct Out { b: &'static mut [u8; OUT_CAP], n: usize }
impl Out {
    fn new() -> Self { Out { b: unsafe { &mut *core::ptr::addr_of_mut!(OUT) }, n: 0 } }
    fn s(&mut self, s: &[u8]) -> &mut Self {
        if self.n + s.len() > OUT_CAP { revert(); } // never truncate into malformed JSON
        self.b[self.n..self.n + s.len()].copy_from_slice(s);
        self.n += s.len();
        self
    }
    fn bool(&mut self, v: bool) -> &mut Self { self.s(if v { b"true" } else { b"false" }) }
    fn num(&mut self, mut v: u64) -> &mut Self {
        let mut d = [0u8; 20];
        let mut k = 0;
        loop { d[k] = b'0' + (v % 10) as u8; k += 1; v /= 10; if v == 0 { break; } }
        while k > 0 { k -= 1; self.s(&[d[k]]); }
        self
    }
    /// Return only (read-only methods: no event).
    fn ret(&self) {
        unsafe { host_set_return(self.b.as_ptr(), self.n as u32) };
    }
    fn emit(&self, topic: &[u8]) {
        unsafe {
            host_emit_event(topic.as_ptr(), topic.len() as u32, self.b.as_ptr(), self.n as u32);
            host_set_return(self.b.as_ptr(), self.n as u32);
        }
    }
}

// ── Methods ─────────────────────────────────────────────────────────────────────────────────

/// `list {"collection","token_id","price"}` — the caller must own the NFT now; then send it here.
#[no_mangle]
pub extern "C" fn list() {
    let a = args();
    let col = arg_str(a, b"collection");
    let token_id = arg_u64(a, b"token_id");
    let price = arg_u64(a, b"price");
    if col.is_empty() || col.len() > MAX_COL || price == 0 || price > i64::MAX as u64 || token_id > i64::MAX as u64 {
        revert();
    }
    if unsafe { host_nft_royalty_bps(col.as_ptr(), col.len() as u32) } < 0 { revert(); } // no such collection
    let owner = buf(core::ptr::addr_of_mut!(OWNER));
    let on = unsafe { host_nft_owner(col.as_ptr(), col.len() as u32, token_id as i64, owner.as_mut_ptr(), BIG as u32) };
    if on <= 0 { revert(); }
    let seller = caller();
    if !is_owner(&owner[..on as usize], seller) { revert(); }

    let id = read_u64(b"next").unwrap_or(1);
    write_u64(b"next", id + 1);
    let rec = unsafe { &mut *core::ptr::addr_of_mut!(REC) };
    rec[0..8].copy_from_slice(&price.to_be_bytes());
    rec[8..16].copy_from_slice(&token_id.to_be_bytes());
    rec[16..18].copy_from_slice(&(col.len() as u16).to_be_bytes());
    rec[18..18 + col.len()].copy_from_slice(col);
    rec[18 + col.len()..18 + col.len() + seller.len()].copy_from_slice(seller);
    let key = listing_key(id);
    unsafe { host_storage_write(key.as_ptr(), 9, rec.as_ptr(), (18 + col.len() + seller.len()) as u32) };
    let mut tk = [0u8; 9 + MAX_COL];
    let tl = token_key(col, token_id, &mut tk);
    write_u64(&tk[..tl], id);

    Out::new().s(b"{\"listing\":").num(id).s(b",\"seller\":\"").s(seller).s(b"\",\"collection\":\"").s(col).s(b"\",\"token_id\":").num(token_id)
        .s(b",\"price\":").num(price).s(b"}").emit(b"listed");
}

/// `buy {"listing"}` with exactly `price` quanta of XRGE attached.
#[no_mangle]
pub extern "C" fn buy() {
    let id = arg_u64(args(), b"listing");
    let l = load(id);
    if !is_current(id, &l) { revert(); } // replaced by a newer listing

    // Exact payment in XRGE, or the call fails and the payment goes back.
    let mut sym = [0u8; 8];
    let sl = unsafe { host_get_attached_symbol(sym.as_mut_ptr(), 8) };
    if sl != 4 || &sym[..4] != b"XRGE" || unsafe { host_get_attached_amount() } as u64 != l.price { revert(); }

    // The NFT must already be held here (host_nft_transfer returns non-zero otherwise).
    let buyer = caller();
    if unsafe { host_nft_transfer(l.col.as_ptr(), l.col.len() as u32, l.token_id as i64, buyer.as_ptr(), buyer.len() as u32) } != 0 {
        revert();
    }

    // Royalty: floor(price × bps / 10000), in quanta, paid to the canonical recipient.
    let bps = unsafe { host_nft_royalty_bps(l.col.as_ptr(), l.col.len() as u32) };
    if bps < 0 { revert(); }
    let royalty = (l.price as u128 * bps as u128 / 10_000) as u64;
    if royalty > 0 {
        let r = buf(core::ptr::addr_of_mut!(RECIPIENT));
        let rn = unsafe { host_nft_royalty_recipient(l.col.as_ptr(), l.col.len() as u32, r.as_mut_ptr(), BIG as u32) };
        if rn <= 0 { revert(); }
        if unsafe { host_transfer(r.as_ptr(), rn as u32, royalty as i64) } != 0 { revert(); }
    }
    let proceeds = l.price - royalty;
    if proceeds > 0 && unsafe { host_transfer(l.seller.as_ptr(), l.seller.len() as u32, proceeds as i64) } != 0 {
        revert();
    }

    delete(id, &l);
    Out::new().s(b"{\"listing\":").num(id).s(b",\"price\":").num(l.price).s(b",\"royalty\":").num(royalty)
        .s(b",\"seller_proceeds\":").num(proceeds).s(b"}").emit(b"sold");
}

/// `cancel {"listing"}` — seller only. Returns the NFT if the contract holds it for this listing.
#[no_mangle]
pub extern "C" fn cancel() {
    let id = arg_u64(args(), b"listing");
    let l = load(id);
    if caller() != l.seller { revert(); }

    // Give the NFT back if the contract holds it (1 = not ours, e.g. never deposited: nothing to
    // return). Only for the NFT's CURRENT listing: after a newer listing (possibly by a later owner)
    // the escrowed NFT belongs to that one, and a stale listing's seller must not take it back.
    let returned = is_current(id, &l) && unsafe {
        host_nft_transfer(l.col.as_ptr(), l.col.len() as u32, l.token_id as i64, l.seller.as_ptr(), l.seller.len() as u32)
    } == 0;
    delete(id, &l);
    Out::new().s(b"{\"listing\":").num(id).s(b",\"returned\":").bool(returned).s(b"}").emit(b"cancelled");
}

/// `listing {"listing":N}` — read-only view for a UI. `escrowed`: the contract holds the NFT for
/// this listing (it is the NFT's current listing and host_nft_owner is this contract — the same
/// check host_nft_transfer makes in `buy`). Buyable = exists && escrowed. Unknown or finished
/// listing → {"listing":N,"exists":false} (no trap).
#[no_mangle]
pub extern "C" fn listing() {
    let id = arg_u64(args(), b"listing");
    let mut o = Out::new();
    o.s(b"{\"listing\":").num(id);
    let Some(l) = try_load(id) else {
        o.s(b",\"exists\":false}").ret();
        return;
    };
    let active = is_current(id, &l);
    let mut escrowed = false;
    if active {
        let owner = buf(core::ptr::addr_of_mut!(OWNER));
        let on = unsafe { host_nft_owner(l.col.as_ptr(), l.col.len() as u32, l.token_id as i64, owner.as_mut_ptr(), BIG as u32) };
        let me = unsafe { &mut *core::ptr::addr_of_mut!(SELF) };
        let mn = unsafe { host_get_self_addr(me.as_mut_ptr(), me.len() as u32) };
        escrowed = on > 0 && mn > 0 && owner[..on as usize] == me[..mn as usize];
    }
    o.s(b",\"exists\":true,\"seller\":\"").s(l.seller).s(b"\",\"collection\":\"").s(l.col)
        .s(b"\",\"token_id\":").num(l.token_id).s(b",\"price\":").num(l.price)
        .s(b",\"active\":").bool(active).s(b",\"escrowed\":").bool(escrowed).s(b"}").ret();
}

/// `listing_count {}` — read-only: {"next":N}, the highest listing id issued so far (0 = none).
/// Listing ids run 1..=N; a UI iterates them with `listing` (sold/cancelled ones say exists:false).
#[no_mangle]
pub extern "C" fn listing_count() {
    let next = read_u64(b"next").unwrap_or(1);
    Out::new().s(b"{\"next\":").num(next - 1).s(b"}").ret();
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
