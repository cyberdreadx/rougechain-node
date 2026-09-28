//! Loot roll — an example RougeChain game contract (commit, then settle).
//!
//! * `setup` creates the contract's own `LOOT` NFT collection (max 1,000 items). Call it once.
//! * `roll` commits: it records the current block height for the caller (one open roll per player)
//!   and emits `committed` {"height":H}. Nothing is decided yet.
//! * `settle` (from block H+2 on) decides the roll from the hash of block H+1 — a block that did not
//!   exist when the player committed, whose hash covers the producer's signature and the validators'
//!   finality signatures — mixed with the caller and H. It pays a prize from the contract's treasury:
//!     0–4    Legendary Sword NFT (minted from the LOOT collection)
//!     5–29   10 GOLD tokens (send GOLD to the contract address to stock it)
//!     30–49  0.5 XRGE (send XRGE to the contract address to stock it)
//!     50–99  nothing
//!   and emits `roll` {"roll":N,"prize":"..."} (also the return value). Settle too early and it
//!   returns {"error":"too_early"}; after 250 blocks the commitment expires ({"error":"expired"},
//!   cleared so the player can roll again).
//!
//! Why two steps: `host_random` is fixed by the parent block and the transaction, so a player can sign
//! many variants of a one-step roll offline and send only a winner. Committing first removes that
//! choice. The single block producer could still bias a result by withholding a block.

#![no_std]

use core::panic::PanicInfo;

extern "C" {
    fn host_get_caller(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_get_self_addr(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_block_hash(height: i64, out_ptr: *mut u8) -> i32;
    fn host_get_block_height() -> i64;
    fn host_sha256(data_ptr: *const u8, data_len: u32, out_ptr: *mut u8) -> i32;
    fn host_storage_read(key_ptr: *const u8, key_len: u32, val_ptr: *mut u8, val_len: u32) -> i32;
    fn host_storage_write(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32);
    fn host_storage_delete(key_ptr: *const u8, key_len: u32);
    fn host_transfer(to_ptr: *const u8, to_len: u32, amount: i64) -> i32;
    fn host_token_transfer(sym_ptr: *const u8, sym_len: u32, to_ptr: *const u8, to_len: u32, amount: i64) -> i32;
    fn host_nft_create_collection(sym_ptr: *const u8, sym_len: u32, name_ptr: *const u8, name_len: u32,
                                  max_supply: i64, out_ptr: *mut u8, out_cap: u32) -> i32;
    fn host_nft_mint(col_ptr: *const u8, col_len: u32, to_ptr: *const u8, to_len: u32,
                     name_ptr: *const u8, name_len: u32, meta_ptr: *const u8, meta_len: u32) -> i64;
    fn host_emit_event(topic_ptr: *const u8, topic_len: u32, data_ptr: *const u8, data_len: u32);
    fn host_set_return(data_ptr: *const u8, data_len: u32);
}

const SYMBOL: &[u8] = b"LOOT";
const HALF_XRGE: i64 = 500_000_000; // quanta

static mut CALLER: [u8; 8192] = [0; 8192];
static mut SELF_ADDR: [u8; 64] = [0; 64];
static mut OUT: [u8; 256] = [0; 256];
/// block hash (32) ‖ caller (≤ 8192) ‖ height (8), hashed into the roll.
static mut SEED_BUF: [u8; 32 + 8192 + 8] = [0; 32 + 8192 + 8];
const EXPIRY_BLOCKS: i64 = 250;

/// Collection id the VM derives: "col:" + first 16 chars of the contract address + ":LOOT".
fn collection_id(buf: &mut [u8; 64]) -> usize {
    let n = unsafe { host_get_self_addr(core::ptr::addr_of_mut!(SELF_ADDR) as *mut u8, 64) };
    if n < 16 { return 0; }
    let addr = unsafe { &*core::ptr::addr_of!(SELF_ADDR) };
    let mut i = 0;
    for b in b"col:" { buf[i] = *b; i += 1; }
    for b in &addr[..16] { buf[i] = *b; i += 1; }
    buf[i] = b':'; i += 1;
    for b in SYMBOL { buf[i] = *b; i += 1; }
    i
}

#[no_mangle]
pub extern "C" fn setup() {
    let name = b"Loot";
    let n = unsafe {
        host_nft_create_collection(SYMBOL.as_ptr(), SYMBOL.len() as u32, name.as_ptr(), name.len() as u32,
                                   1000, core::ptr::addr_of_mut!(OUT) as *mut u8, 256)
    };
    let msg: &[u8] = if n > 0 { b"{\"created\":true}" } else { b"{\"created\":false}" };
    unsafe { host_set_return(msg.as_ptr(), msg.len() as u32) };
}

fn caller() -> &'static [u8] {
    let n = unsafe { host_get_caller(core::ptr::addr_of_mut!(CALLER) as *mut u8, 8192) };
    if n <= 0 { return &[]; }
    unsafe { &(&*core::ptr::addr_of!(CALLER))[..n as usize] }
}

/// Storage key for a player's open roll: "p" ‖ sha256(caller).
fn pending_key(caller: &[u8]) -> [u8; 33] {
    let mut k = [0u8; 33];
    k[0] = b'p';
    unsafe { host_sha256(caller.as_ptr(), caller.len() as u32, k[1..].as_mut_ptr()) };
    k
}

fn reply(topic: &[u8], msg: &[u8]) {
    unsafe {
        host_emit_event(topic.as_ptr(), topic.len() as u32, msg.as_ptr(), msg.len() as u32);
        host_set_return(msg.as_ptr(), msg.len() as u32);
    }
}

fn push_num(out: &mut [u8], i: &mut usize, mut n: u64) {
    let mut digits = [0u8; 20];
    let mut d = 0;
    loop { digits[d] = b'0' + (n % 10) as u8; d += 1; n /= 10; if n == 0 { break; } }
    while d > 0 { d -= 1; out[*i] = digits[d]; *i += 1; }
}

fn push(out: &mut [u8], i: &mut usize, s: &[u8]) {
    for b in s { out[*i] = *b; *i += 1; }
}

/// Commit to a roll at the current block height.
#[no_mangle]
pub extern "C" fn roll() {
    let caller = caller();
    if caller.is_empty() { return; }
    let key = pending_key(caller);
    let mut existing = [0u8; 8];
    if unsafe { host_storage_read(key.as_ptr(), 33, existing.as_mut_ptr(), 8) } == 8 {
        reply(b"error", b"{\"error\":\"already_committed\"}");
        return;
    }
    let h = unsafe { host_get_block_height() };
    let hb = h.to_be_bytes();
    unsafe { host_storage_write(key.as_ptr(), 33, hb.as_ptr(), 8) };
    let mut out = [0u8; 48];
    let mut i = 0;
    push(&mut out, &mut i, b"{\"height\":");
    push_num(&mut out, &mut i, h as u64);
    push(&mut out, &mut i, b"}");
    reply(b"committed", &out[..i]);
}

/// Settle the caller's open roll from the hash of the block after the commitment.
#[no_mangle]
pub extern "C" fn settle() {
    let caller = caller();
    if caller.is_empty() { return; }
    let key = pending_key(caller);
    let mut hb = [0u8; 8];
    if unsafe { host_storage_read(key.as_ptr(), 33, hb.as_mut_ptr(), 8) } != 8 {
        reply(b"error", b"{\"error\":\"no_roll\"}");
        return;
    }
    let h = i64::from_be_bytes(hb);
    let now = unsafe { host_get_block_height() };
    if now < h + 2 {
        reply(b"error", b"{\"error\":\"too_early\"}");
        return;
    }
    if now - (h + 1) > EXPIRY_BLOCKS {
        unsafe { host_storage_delete(key.as_ptr(), 33) };
        reply(b"error", b"{\"error\":\"expired\"}");
        return;
    }
    let seed = unsafe { &mut *core::ptr::addr_of_mut!(SEED_BUF) };
    if unsafe { host_block_hash(h + 1, seed.as_mut_ptr()) } != 32 {
        reply(b"error", b"{\"error\":\"block_unavailable\"}");
        return;
    }
    seed[32..32 + caller.len()].copy_from_slice(caller);
    seed[32 + caller.len()..32 + caller.len() + 8].copy_from_slice(&hb);
    let mut r = [0u8; 32];
    unsafe { host_sha256(seed.as_ptr(), (32 + caller.len() + 8) as u32, r.as_mut_ptr()) };
    unsafe { host_storage_delete(key.as_ptr(), 33) };
    let roll = (u16::from_be_bytes([r[0], r[1]]) % 100) as u8;

    let prize: &[u8] = if roll < 5 {
        let mut col = [0u8; 64];
        let cl = collection_id(&mut col);
        let name = b"Legendary Sword";
        let meta = b"{\"rarity\":\"legendary\",\"power\":99}";
        let id = unsafe {
            host_nft_mint(col.as_ptr(), cl as u32, caller.as_ptr(), caller.len() as u32,
                          name.as_ptr(), name.len() as u32, meta.as_ptr(), meta.len() as u32)
        };
        if id > 0 { b"sword" } else { b"sold_out" }
    } else if roll < 30 {
        let sym = b"GOLD";
        let ok = unsafe { host_token_transfer(sym.as_ptr(), sym.len() as u32, caller.as_ptr(), caller.len() as u32, 10) };
        if ok == 0 { b"gold" } else { b"treasury_empty" }
    } else if roll < 50 {
        let ok = unsafe { host_transfer(caller.as_ptr(), caller.len() as u32, HALF_XRGE) };
        if ok == 0 { b"xrge" } else { b"treasury_empty" }
    } else {
        b"nothing"
    };

    let mut out = [0u8; 64];
    let mut i = 0;
    push(&mut out, &mut i, b"{\"roll\":");
    push_num(&mut out, &mut i, roll as u64);
    push(&mut out, &mut i, b",\"prize\":\"");
    push(&mut out, &mut i, prize);
    push(&mut out, &mut i, b"\"}");
    reply(b"roll", &out[..i]);
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
