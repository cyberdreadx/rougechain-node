//! XRGE staking — holders stake XRGE and share a funded reward pot that streams over time.
//!
//! Needs payable calls (mainnet block 190). All amounts are integer XRGE **quanta** (1 XRGE = 10^9).
//! This is reward sharing, not validator staking: XRGE held here does not count as validator stake.
//!
//! * `stake {}` with `attach: {"symbol":"XRGE","amount":N}` — add N to the caller's stake. An
//!   account holds at least 1 XRGE or nothing.
//! * `request_unstake {"amount":N}` — N stops earning now and can be withdrawn after the delay
//!   (3 days of block time). A later request restarts the delay for everything pending.
//! * `cancel_unstake {}` — put everything pending back to work.
//! * `withdraw {}` — pay the pending principal back once the delay has passed.
//! * `claim {}` — pay the caller's rewards.
//! * `fund {"duration":S}` with XRGE attached — add to the pot and stream everything not yet
//!   streamed over S seconds from now (1 day to 365 days). Anyone may fund; a funding during a
//!   running stream must not lower its rate. While nobody is staked the stream is paused.
//!
//! Read-only (free through the node's query endpoint, no event, no storage write):
//! * `info {}` → totals, the reward rate (quanta per second) and when the stream ends.
//! * `account {"address":"rouge1…"}` → that address's stake, claimable rewards and pending unstake.
//!
//! Accounts are keyed by the caller's `rouge1…` address, and payouts go to that address. Only a
//! wallet (an ML-DSA-65 public key) can stake. There is no admin: nobody can move a staker's
//! principal, change the delay, or take the pot back. XRGE sent to the contract address with a
//! plain transfer is not credited to anyone and cannot be recovered — always use `stake` / `fund`.
//! A wrong symbol, a missing or unexpected payment, or a refused request makes the call fail
//! (trap), so an attached payment goes back to the caller.
//!
//! The accounting lives in `pool.rs` and is unit-tested natively (`cargo test`).

#![cfg_attr(target_arch = "wasm32", no_std)]

pub mod pool;

#[cfg(target_arch = "wasm32")]
mod contract {
    use crate::pool::{Account, Pool, MIN_STAKE, UNSTAKE_DELAY_SECS};
    use core::panic::PanicInfo;

    extern "C" {
        fn host_get_caller(buf_ptr: *mut u8, buf_len: u32) -> i32;
        fn host_get_args_len() -> i32;
        fn host_read_args(buf_ptr: *mut u8, buf_len: u32) -> i32;
        fn host_get_block_time() -> i64;
        fn host_get_attached_amount() -> i64;
        fn host_get_attached_symbol(out_ptr: *mut u8, out_cap: u32) -> i32;
        fn host_storage_read(key_ptr: *const u8, key_len: u32, val_ptr: *mut u8, val_len: u32) -> i32;
        fn host_storage_write(key_ptr: *const u8, key_len: u32, val_ptr: *const u8, val_len: u32);
        fn host_storage_delete(key_ptr: *const u8, key_len: u32);
        fn host_transfer(to_ptr: *const u8, to_len: u32, amount: i64) -> i32;
        fn host_pqc_pubkey_to_address(pk_ptr: *const u8, pk_len: u32, out_ptr: *mut u8, out_len: u32) -> i32;
        fn host_emit_event(topic_ptr: *const u8, topic_len: u32, data_ptr: *const u8, data_len: u32);
        fn host_set_return(data_ptr: *const u8, data_len: u32);
    }

    /// Fail the call: everything it did is discarded and an attached payment returns to the caller.
    fn revert() -> ! {
        core::arch::wasm32::unreachable()
    }

    const PK_BYTES: usize = 1952; // ML-DSA-65 public key
    const MAX_ADDR: usize = 128;

    static mut CALLER: [u8; 2 * PK_BYTES] = [0; 2 * PK_BYTES];
    static mut PK: [u8; PK_BYTES] = [0; PK_BYTES];
    static mut ARGS: [u8; 512] = [0; 512];
    static mut OUT: [u8; 768] = [0; 768];

    /// A `rouge1…` address: the account key and the payout target.
    struct Addr { b: [u8; MAX_ADDR], n: usize }
    impl Addr {
        fn bytes(&self) -> &[u8] { &self.b[..self.n] }
    }

    fn hex_val(c: u8) -> Option<u8> {
        match c { b'0'..=b'9' => Some(c - b'0'), b'a'..=b'f' => Some(c - b'a' + 10), b'A'..=b'F' => Some(c - b'A' + 10), _ => None }
    }

    /// The caller's address. Only a wallet key is accepted: a contract caller (a 40-hex address)
    /// has no key, and deriving an address from it would pay out to an address nobody controls.
    fn caller_addr() -> Addr {
        let c = unsafe { &mut *core::ptr::addr_of_mut!(CALLER) };
        let n = unsafe { host_get_caller(c.as_mut_ptr(), c.len() as u32) };
        if n != (2 * PK_BYTES) as i32 { revert(); }
        let pk = unsafe { &mut *core::ptr::addr_of_mut!(PK) };
        for i in 0..PK_BYTES {
            match (hex_val(c[2 * i]), hex_val(c[2 * i + 1])) {
                (Some(h), Some(l)) => pk[i] = h << 4 | l,
                _ => revert(),
            }
        }
        let mut a = Addr { b: [0; MAX_ADDR], n: 0 };
        let n = unsafe { host_pqc_pubkey_to_address(pk.as_ptr(), PK_BYTES as u32, a.b.as_mut_ptr(), MAX_ADDR as u32) };
        if n <= 0 || n as usize > MAX_ADDR || !a.b.starts_with(b"rouge1") { revert(); }
        a.n = n as usize;
        a
    }

    fn now() -> u64 {
        let t = unsafe { host_get_block_time() };
        if t <= 0 { revert(); }
        t as u64
    }

    /// The XRGE attached to this call; traps unless it is a positive XRGE payment.
    fn attached_xrge() -> u64 {
        let amount = unsafe { host_get_attached_amount() };
        let mut sym = [0u8; 8];
        let sl = unsafe { host_get_attached_symbol(sym.as_mut_ptr(), 8) };
        if amount <= 0 || sl != 4 || &sym[..4] != b"XRGE" { revert(); }
        amount as u64
    }

    /// Methods that take no payment refuse one, so it goes back instead of being stranded here.
    fn no_payment() {
        if unsafe { host_get_attached_amount() } != 0 { revert(); }
    }

    fn pay(to: &Addr, amount: u64) {
        if amount == 0 || amount > i64::MAX as u64 { revert(); }
        if unsafe { host_transfer(to.b.as_ptr(), to.n as u32, amount as i64) } != 0 { revert(); }
    }

    // ── Arguments: a tiny reader for the flat JSON object the call carries ──────────────────

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

    // ── Storage ─────────────────────────────────────────────────────────────────────────────

    fn load_pool() -> Pool {
        let mut b = [0u8; Pool::BYTES];
        let n = unsafe { host_storage_read(b"P".as_ptr(), 1, b.as_mut_ptr(), Pool::BYTES as u32) };
        if n == Pool::BYTES as i32 { Pool::from_bytes(&b) } else { Pool::default() }
    }

    fn save_pool(p: &Pool) {
        let b = p.to_bytes();
        unsafe { host_storage_write(b"P".as_ptr(), 1, b.as_ptr(), Pool::BYTES as u32) };
    }

    /// "A" ‖ address.
    fn account_key(addr: &[u8], out: &mut [u8; 1 + MAX_ADDR]) -> usize {
        out[0] = b'A';
        out[1..1 + addr.len()].copy_from_slice(addr);
        1 + addr.len()
    }

    fn load_account(addr: &[u8]) -> Account {
        let mut k = [0u8; 1 + MAX_ADDR];
        let kl = account_key(addr, &mut k);
        let mut b = [0u8; Account::BYTES];
        let n = unsafe { host_storage_read(k.as_ptr(), kl as u32, b.as_mut_ptr(), Account::BYTES as u32) };
        if n == Account::BYTES as i32 { Account::from_bytes(&b) } else { Account::default() }
    }

    fn save_account(addr: &[u8], a: &Account) {
        let mut k = [0u8; 1 + MAX_ADDR];
        let kl = account_key(addr, &mut k);
        if a.is_empty() {
            unsafe { host_storage_delete(k.as_ptr(), kl as u32) };
        } else {
            let b = a.to_bytes();
            unsafe { host_storage_write(k.as_ptr(), kl as u32, b.as_ptr(), Account::BYTES as u32) };
        }
    }

    // ── Output ──────────────────────────────────────────────────────────────────────────────

    struct Out { b: &'static mut [u8; 768], n: usize }
    impl Out {
        fn new() -> Self { Out { b: unsafe { &mut *core::ptr::addr_of_mut!(OUT) }, n: 0 } }
        fn s(&mut self, s: &[u8]) -> &mut Self {
            if self.n + s.len() > self.b.len() { revert(); } // never truncate into malformed JSON
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

    /// `{"address":"…","<what>":amount,"staked":…,"pending":…,"unlock_at":…,"total_staked":…}`
    fn emit_account(topic: &[u8], what: &[u8], amount: u64, who: &Addr, a: &Account, p: &Pool) {
        Out::new().s(b"{\"address\":\"").s(who.bytes()).s(b"\",\"").s(what).s(b"\":").num(amount)
            .s(b",\"staked\":").num(a.staked).s(b",\"pending\":").num(a.pending).s(b",\"unlock_at\":").num(a.unlock_at)
            .s(b",\"total_staked\":").num(p.total_staked).s(b"}").emit(topic);
    }

    // ── Methods ─────────────────────────────────────────────────────────────────────────────

    /// `stake {}` with XRGE attached.
    #[no_mangle]
    pub extern "C" fn stake() {
        let amount = attached_xrge();
        let who = caller_addr();
        let (mut p, mut a) = (load_pool(), load_account(who.bytes()));
        if p.stake(&mut a, now(), amount).is_err() { revert(); }
        save_pool(&p);
        save_account(who.bytes(), &a);
        emit_account(b"staked", b"amount", amount, &who, &a, &p);
    }

    /// `request_unstake {"amount":N}` — N stops earning and can be withdrawn after the delay.
    #[no_mangle]
    pub extern "C" fn request_unstake() {
        no_payment();
        let amount = arg_u64(args(), b"amount");
        let who = caller_addr();
        let (mut p, mut a) = (load_pool(), load_account(who.bytes()));
        if p.request_unstake(&mut a, now(), amount).is_err() { revert(); }
        save_pool(&p);
        save_account(who.bytes(), &a);
        emit_account(b"unstake_requested", b"amount", amount, &who, &a, &p);
    }

    /// `cancel_unstake {}` — everything pending goes back to earning.
    #[no_mangle]
    pub extern "C" fn cancel_unstake() {
        no_payment();
        let who = caller_addr();
        let (mut p, mut a) = (load_pool(), load_account(who.bytes()));
        let Ok(amount) = p.cancel_unstake(&mut a, now()) else { revert() };
        save_pool(&p);
        save_account(who.bytes(), &a);
        emit_account(b"unstake_cancelled", b"amount", amount, &who, &a, &p);
    }

    /// `withdraw {}` — pay the pending principal back once the delay has passed.
    #[no_mangle]
    pub extern "C" fn withdraw() {
        no_payment();
        let who = caller_addr();
        let (mut p, mut a) = (load_pool(), load_account(who.bytes()));
        let Ok(amount) = p.withdraw(&mut a, now()) else { revert() };
        save_pool(&p);
        save_account(who.bytes(), &a);
        pay(&who, amount);
        emit_account(b"withdrawn", b"amount", amount, &who, &a, &p);
    }

    /// `claim {}` — pay the caller's rewards.
    #[no_mangle]
    pub extern "C" fn claim() {
        no_payment();
        let who = caller_addr();
        let (mut p, mut a) = (load_pool(), load_account(who.bytes()));
        let Ok(amount) = p.claim(&mut a, now()) else { revert() };
        save_pool(&p);
        save_account(who.bytes(), &a);
        pay(&who, amount);
        emit_account(b"claimed", b"amount", amount, &who, &a, &p);
    }

    /// `fund {"duration":S}` with XRGE attached — anyone may add to the pot.
    #[no_mangle]
    pub extern "C" fn fund() {
        let amount = attached_xrge();
        let duration = arg_u64(args(), b"duration");
        let mut p = load_pool();
        if p.fund(now(), amount, duration).is_err() { revert(); }
        save_pool(&p);
        Out::new().s(b"{\"amount\":").num(amount).s(b",\"duration\":").num(duration).s(b",\"reward_rate\":").num(p.rate)
            .s(b",\"period_end\":").num(p.period_end).s(b",\"reserve\":").num(p.reserve).s(b"}").emit(b"funded");
    }

    /// `info {}` — read-only: totals and the reward stream as of now.
    #[no_mangle]
    pub extern "C" fn info() {
        let t = now();
        let mut p = load_pool();
        p.advance(t);
        Out::new().s(b"{\"total_staked\":").num(p.total_staked).s(b",\"total_pending\":").num(p.total_pending)
            .s(b",\"reserve\":").num(p.reserve).s(b",\"reward_rate\":").num(p.rate).s(b",\"period_end\":").num(p.period_end)
            .s(b",\"streaming\":").bool(p.last_update < p.period_end && p.total_staked > 0)
            .s(b",\"now\":").num(t).s(b",\"min_stake\":").num(MIN_STAKE).s(b",\"unstake_delay\":").num(UNSTAKE_DELAY_SECS).s(b"}").ret();
    }

    /// `account {"address":"rouge1…"}` — read-only: stake, claimable rewards and pending unstake.
    #[no_mangle]
    pub extern "C" fn account() {
        let addr = arg_str(args(), b"address");
        if addr.is_empty() || addr.len() > MAX_ADDR { revert(); }
        let t = now();
        let (p, a) = (load_pool(), load_account(addr));
        Out::new().s(b"{\"address\":\"").s(addr).s(b"\",\"staked\":").num(a.staked).s(b",\"earned\":").num(p.earned(&a, t))
            .s(b",\"pending\":").num(a.pending).s(b",\"unlock_at\":").num(a.unlock_at)
            .s(b",\"withdrawable\":").bool(a.pending > 0 && t >= a.unlock_at).s(b"}").ret();
    }

    #[panic_handler]
    fn panic(_: &PanicInfo) -> ! {
        core::arch::wasm32::unreachable()
    }
}
