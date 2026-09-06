//! RougeChain v2 royalty splitter.
//!
//! Custodies XRGE (royalties are paid to this contract's address) and, on a
//! `split` call, fans its entire balance to a fixed set of collaborators by
//! weighted share — in integer **quanta**, single-hop, conserving (any
//! floor-division dust stays in the contract for the next round).
//!
//! The VM has no call-args ABI, so the recipient set is baked in at build time:
//! qRougee generates one splitter per collection by substituting the
//! `RECIPIENTS` / `SHARES` constants below and rebuilding, then uses the
//! deployed contract address as the NFT `royaltyRecipient`.

#![no_std]

use core::panic::PanicInfo;

// ─────────────────────────────────────────────────────────────────────────
// GENERATED PER COLLECTION — substitute these two arrays and rebuild.
// Addresses are 40-hex account/contract addresses. SHARES are relative weights
// (basis points or any positive integers); they need not sum to a round number.
// RECIPIENTS.len() must equal SHARES.len().
const RECIPIENTS: &[&str] = &[
    "1111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222",
    "3333333333333333333333333333333333333333",
];
const SHARES: &[u64] = &[5000, 3000, 2000]; // 50% / 30% / 20%
// ─────────────────────────────────────────────────────────────────────────

extern "C" {
    fn host_get_self_addr(buf_ptr: *mut u8, buf_len: u32) -> i32;
    fn host_get_balance(addr_ptr: *const u8, addr_len: u32) -> i64;
    fn host_transfer(to_ptr: *const u8, to_len: u32, amount: i64) -> i32;
    fn host_emit_event(topic_ptr: *const u8, topic_len: u32, data_ptr: *const u8, data_len: u32);
}

/// Distribute this contract's entire XRGE balance to the configured recipients
/// by weighted share. Idempotent-ish: calling it again splits whatever balance
/// has since accrued. Dust (floor-division remainder) stays in the contract.
#[no_mangle]
pub extern "C" fn split() {
    if RECIPIENTS.len() != SHARES.len() || RECIPIENTS.is_empty() {
        return;
    }

    // This contract's own address (40 hex chars; 64-byte buffer is ample).
    let mut addr_buf = [0u8; 64];
    let n = unsafe { host_get_self_addr(addr_buf.as_mut_ptr(), addr_buf.len() as u32) };
    if n <= 0 {
        return;
    }
    let self_addr = &addr_buf[..n as usize];

    // Balance in quanta. Nothing to do if empty.
    let bal = unsafe { host_get_balance(self_addr.as_ptr(), self_addr.len() as u32) };
    if bal <= 0 {
        return;
    }
    let balance = bal as u128;

    // Total weight.
    let mut total: u128 = 0;
    let mut i = 0;
    while i < SHARES.len() {
        total += SHARES[i] as u128;
        i += 1;
    }
    if total == 0 {
        return;
    }

    // Proportional payouts in quanta. Because each cut is floor(balance*share/
    // total), the cuts sum to <= balance, so the sequential single-hop transfers
    // never overdraft and value is conserved (remainder stays here).
    let mut j = 0;
    while j < RECIPIENTS.len() {
        let cut = balance * (SHARES[j] as u128) / total;
        if cut > 0 {
            let r = RECIPIENTS[j].as_bytes();
            unsafe {
                host_transfer(r.as_ptr(), r.len() as u32, cut as i64);
            }
        }
        j += 1;
    }

    let topic = b"royalty_split";
    let data = b"ok";
    unsafe {
        host_emit_event(topic.as_ptr(), topic.len() as u32, data.as_ptr(), data.len() as u32);
    }
}

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
