//! Loot roll — an example RougeChain game contract.
//!
//! * `setup` creates the contract's own `LOOT` NFT collection (max 1,000 items). Call it once.
//! * `roll` draws a random number 0–99 for the caller (the verified signer) and pays a prize
//!   from the contract's own treasury:
//!     0–4    Legendary Sword NFT (minted from the LOOT collection)
//!     5–29   10 GOLD tokens (send GOLD to the contract address to stock it)
//!     30–49  0.5 XRGE (send XRGE to the contract address to stock it)
//!     50–99  nothing
//!   Every roll emits a `roll` event: {"roll":N,"prize":"..."} — subscribe to `contract:<addr>`
//!   to animate results live. The prize outcome is also the call's return value.
//!
//! Randomness comes from `host_random`: fixed by the parent block and this transaction, so a
//! player can't re-roll a transaction they already sent. A block producer could still choose
//! whether to include a roll, so use commit-reveal for high-value outcomes.

#![no_std]

use core::panic::PanicInfo;

extern "C" {
    fn host_get_caller(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_get_self_addr(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_random(out_ptr: *mut u8) -> i32;
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

#[no_mangle]
pub extern "C" fn roll() {
    let caller_len = unsafe { host_get_caller(core::ptr::addr_of_mut!(CALLER) as *mut u8, 8192) };
    if caller_len <= 0 { return; }
    let caller = unsafe { &(&*core::ptr::addr_of!(CALLER))[..caller_len as usize] };

    let mut r = [0u8; 32];
    unsafe { host_random(r.as_mut_ptr()) };
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

    // {"roll":NN,"prize":"..."}
    let mut out = [0u8; 64];
    let mut i = 0;
    for b in b"{\"roll\":" { out[i] = *b; i += 1; }
    if roll >= 10 { out[i] = b'0' + roll / 10; i += 1; }
    out[i] = b'0' + roll % 10; i += 1;
    for b in b",\"prize\":\"" { out[i] = *b; i += 1; }
    for b in prize { out[i] = *b; i += 1; }
    for b in b"\"}" { out[i] = *b; i += 1; }
    let topic = b"roll";
    unsafe {
        host_emit_event(topic.as_ptr(), topic.len() as u32, out.as_ptr(), i as u32);
        host_set_return(out.as_ptr(), i as u32);
    }
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
