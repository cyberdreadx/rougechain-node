//! Reward accounting for the XRGE staking contract. Pure integer arithmetic, no host calls, so it
//! is unit-tested natively (`cargo test`); `lib.rs` is the thin WASM wrapper around it.
//!
//! Rewards are a funded pot streamed over time: `fund(amount, duration)` sets a rate in quanta per
//! second, and every second of the stream is shared by the stakers of that second in proportion
//! to their stake. Nothing is minted: the contract only ever pays out what was paid in.
//!
//! Three balances are tracked and the contract's XRGE always covers their sum:
//!   `total_staked`  — principal that is earning,
//!   `total_pending` — principal waiting out the unstake delay (not earning),
//!   `reserve`       — funded rewards not yet claimed.
//! A claim is capped by `reserve`, so rewards can never be paid out of anyone's principal.

/// Fixed-point scale of `acc` (reward per staked quantum).
pub const PREC: u128 = 1_000_000_000_000;
/// Smallest stake an account may hold: 1 XRGE. Keeps `total_staked` away from tiny values.
pub const MIN_STAKE: u64 = 1_000_000_000;
/// Wait between `request_unstake` and `withdraw`.
pub const UNSTAKE_DELAY_SECS: u64 = 3 * 24 * 60 * 60;
/// A funding must stream over at least a day and at most a year.
pub const MIN_FUND_SECS: u64 = 24 * 60 * 60;
pub const MAX_FUND_SECS: u64 = 365 * 24 * 60 * 60;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pool {
    pub total_staked: u64,
    pub total_pending: u64,
    /// Rewards per staked quantum so far, scaled by `PREC`.
    pub acc: u128,
    /// Quanta streamed per second while `last_update < period_end`.
    pub rate: u64,
    pub period_end: u64,
    pub last_update: u64,
    /// Remainder of the last `fund` division, added to the next funding.
    pub carry: u64,
    /// Funded rewards not yet claimed.
    pub reserve: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Account {
    pub staked: u64,
    /// `Pool::acc` when this account was last settled.
    pub acc_paid: u128,
    /// Settled, unclaimed rewards.
    pub rewards: u64,
    pub pending: u64,
    pub unlock_at: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    ZeroAmount,
    BelowMinimum,
    Insufficient,
    NothingPending,
    StillLocked,
    NothingToClaim,
    BadDuration,
    RateTooLow,
    Overflow,
}

impl Pool {
    pub const BYTES: usize = 72;

    pub fn to_bytes(&self) -> [u8; Self::BYTES] {
        let mut b = [0u8; Self::BYTES];
        b[0..8].copy_from_slice(&self.total_staked.to_be_bytes());
        b[8..16].copy_from_slice(&self.total_pending.to_be_bytes());
        b[16..32].copy_from_slice(&self.acc.to_be_bytes());
        b[32..40].copy_from_slice(&self.rate.to_be_bytes());
        b[40..48].copy_from_slice(&self.period_end.to_be_bytes());
        b[48..56].copy_from_slice(&self.last_update.to_be_bytes());
        b[56..64].copy_from_slice(&self.carry.to_be_bytes());
        b[64..72].copy_from_slice(&self.reserve.to_be_bytes());
        b
    }

    pub fn from_bytes(b: &[u8; Self::BYTES]) -> Self {
        let u = |i: usize| u64::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3], b[i + 4], b[i + 5], b[i + 6], b[i + 7]]);
        let mut acc = [0u8; 16];
        acc.copy_from_slice(&b[16..32]);
        Pool { total_staked: u(0), total_pending: u(8), acc: u128::from_be_bytes(acc), rate: u(32), period_end: u(40),
            last_update: u(48), carry: u(56), reserve: u(64) }
    }

    /// Bring the stream up to `now`. While nobody is staked the stream is paused: the end moves
    /// out by the idle time, so no funded reward is lost to an empty pool.
    pub fn advance(&mut self, now: u64) {
        let now = now.max(self.last_update); // block time never runs the accounting backwards
        if self.last_update < self.period_end {
            if self.total_staked == 0 {
                self.period_end = self.period_end.saturating_add(now - self.last_update);
            } else {
                let dt = now.min(self.period_end) - self.last_update;
                let add = (self.rate as u128).saturating_mul(dt as u128).saturating_mul(PREC) / self.total_staked as u128;
                self.acc = self.acc.saturating_add(add);
            }
        }
        self.last_update = now;
    }

    /// Move what `a` earned since its last settlement into `a.rewards`.
    fn settle(&self, a: &mut Account) {
        let earned = (a.staked as u128).saturating_mul(self.acc.saturating_sub(a.acc_paid)) / PREC;
        a.rewards = a.rewards.saturating_add(earned.min(u64::MAX as u128) as u64);
        a.acc_paid = self.acc;
    }

    /// Rewards `a` could claim at `now` (settled + streamed since), capped by the reserve.
    pub fn earned(&self, a: &Account, now: u64) -> u64 {
        let (mut p, mut a) = (*self, *a);
        p.advance(now);
        p.settle(&mut a);
        a.rewards.min(p.reserve)
    }

    pub fn stake(&mut self, a: &mut Account, now: u64, amount: u64) -> Result<(), Error> {
        if amount == 0 { return Err(Error::ZeroAmount); }
        let staked = a.staked.checked_add(amount).ok_or(Error::Overflow)?;
        if staked < MIN_STAKE { return Err(Error::BelowMinimum); }
        let total = self.total_staked.checked_add(amount).ok_or(Error::Overflow)?;
        self.advance(now);
        self.settle(a);
        self.total_staked = total;
        a.staked = staked;
        Ok(())
    }

    /// Stop `amount` earning now; it can be withdrawn after the delay. A later request restarts
    /// the delay for everything pending.
    pub fn request_unstake(&mut self, a: &mut Account, now: u64, amount: u64) -> Result<(), Error> {
        if amount == 0 { return Err(Error::ZeroAmount); }
        if amount > a.staked { return Err(Error::Insufficient); }
        let left = a.staked - amount;
        if left != 0 && left < MIN_STAKE { return Err(Error::BelowMinimum); }
        self.advance(now);
        self.settle(a);
        let pending = a.pending.checked_add(amount).ok_or(Error::Overflow)?;
        let total_pending = self.total_pending.checked_add(amount).ok_or(Error::Overflow)?;
        a.staked = left;
        a.pending = pending;
        a.unlock_at = self.last_update.saturating_add(UNSTAKE_DELAY_SECS);
        self.total_staked -= amount;
        self.total_pending = total_pending;
        Ok(())
    }

    /// Put everything pending back to work.
    pub fn cancel_unstake(&mut self, a: &mut Account, now: u64) -> Result<u64, Error> {
        if a.pending == 0 { return Err(Error::NothingPending); }
        self.advance(now);
        self.settle(a);
        let amount = a.pending;
        let staked = a.staked.checked_add(amount).ok_or(Error::Overflow)?;
        self.total_staked = self.total_staked.checked_add(amount).ok_or(Error::Overflow)?;
        self.total_pending -= amount;
        a.staked = staked;
        a.pending = 0;
        a.unlock_at = 0;
        Ok(amount)
    }

    /// Principal to pay back once the delay has passed.
    pub fn withdraw(&mut self, a: &mut Account, now: u64) -> Result<u64, Error> {
        if a.pending == 0 { return Err(Error::NothingPending); }
        if now < a.unlock_at { return Err(Error::StillLocked); }
        let amount = a.pending;
        self.total_pending -= amount;
        a.pending = 0;
        a.unlock_at = 0;
        Ok(amount)
    }

    /// Rewards to pay now.
    pub fn claim(&mut self, a: &mut Account, now: u64) -> Result<u64, Error> {
        self.advance(now);
        self.settle(a);
        let pay = a.rewards.min(self.reserve);
        if pay == 0 { return Err(Error::NothingToClaim); }
        a.rewards -= pay;
        self.reserve -= pay;
        Ok(pay)
    }

    /// Add `amount` to the pot and stream everything not yet streamed over `duration` seconds
    /// from now. Anyone may fund, so a funding during a running stream must not lower its rate:
    /// otherwise a dust-sized funding with a long duration could stretch someone else's pot.
    pub fn fund(&mut self, now: u64, amount: u64, duration: u64) -> Result<(), Error> {
        if amount == 0 { return Err(Error::ZeroAmount); }
        if !(MIN_FUND_SECS..=MAX_FUND_SECS).contains(&duration) { return Err(Error::BadDuration); }
        self.advance(now);
        let running = self.last_update < self.period_end;
        let unstreamed = if running { (self.period_end - self.last_update) as u128 * self.rate as u128 } else { 0 };
        let pot = amount as u128 + unstreamed + self.carry as u128;
        let rate = pot / duration as u128;
        if rate == 0 || rate > u64::MAX as u128 || (running && rate < self.rate as u128) { return Err(Error::RateTooLow); }
        let reserve = self.reserve.checked_add(amount).ok_or(Error::Overflow)?;
        self.rate = rate as u64;
        self.carry = (pot % duration as u128) as u64;
        self.period_end = self.last_update.checked_add(duration).ok_or(Error::Overflow)?;
        self.reserve = reserve;
        Ok(())
    }
}

impl Account {
    pub const BYTES: usize = 48;

    pub fn to_bytes(&self) -> [u8; Self::BYTES] {
        let mut b = [0u8; Self::BYTES];
        b[0..8].copy_from_slice(&self.staked.to_be_bytes());
        b[8..24].copy_from_slice(&self.acc_paid.to_be_bytes());
        b[24..32].copy_from_slice(&self.rewards.to_be_bytes());
        b[32..40].copy_from_slice(&self.pending.to_be_bytes());
        b[40..48].copy_from_slice(&self.unlock_at.to_be_bytes());
        b
    }

    pub fn from_bytes(b: &[u8; Self::BYTES]) -> Self {
        let u = |i: usize| u64::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3], b[i + 4], b[i + 5], b[i + 6], b[i + 7]]);
        let mut acc = [0u8; 16];
        acc.copy_from_slice(&b[8..24]);
        Account { staked: u(0), acc_paid: u128::from_be_bytes(acc), rewards: u(24), pending: u(32), unlock_at: u(40) }
    }

    pub fn is_empty(&self) -> bool {
        self.staked == 0 && self.rewards == 0 && self.pending == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const X: u64 = 1_000_000_000; // 1 XRGE in quanta
    const DAY: u64 = 86_400;
    const T0: u64 = 1_800_000_000;

    #[test]
    fn records_round_trip() {
        let p = Pool { total_staked: 1, total_pending: 2, acc: u128::MAX - 3, rate: 4, period_end: 5, last_update: 6, carry: 7, reserve: 8 };
        assert_eq!(Pool::from_bytes(&p.to_bytes()), p);
        let a = Account { staked: 9, acc_paid: u128::MAX / 3, rewards: 10, pending: 11, unlock_at: 12 };
        assert_eq!(Account::from_bytes(&a.to_bytes()), a);
        assert!(Account::default().is_empty() && !a.is_empty());
    }

    #[test]
    fn a_stream_is_shared_by_stake_and_time() {
        let (mut p, mut a, mut b) = (Pool::default(), Account::default(), Account::default());
        p.stake(&mut a, T0, 100 * X).unwrap();
        p.fund(T0, 1_000 * X, 10 * DAY).unwrap(); // 100 XRGE a day
        // A is alone for 2 days, then B joins with 3× A's stake for the remaining 8.
        p.stake(&mut b, T0 + 2 * DAY, 300 * X).unwrap();
        let end = T0 + 10 * DAY;
        let (ea, eb) = (p.earned(&a, end), p.earned(&b, end));
        // A: 200 + 800/4 = 400; B: 800 × 3/4 = 600. Rounding only ever loses quanta.
        assert!(ea <= 400 * X && 400 * X - ea < 1_000_000, "{ea}");
        assert!(eb <= 600 * X && 600 * X - eb < 1_000_000, "{eb}");
        // Nothing more accrues after the stream ends.
        assert_eq!(p.earned(&a, end + 100 * DAY), ea);
        let (ca, cb) = (p.claim(&mut a, end).unwrap(), p.claim(&mut b, end).unwrap());
        assert_eq!((ca, cb), (ea, eb));
        assert!(ca + cb <= 1_000 * X && p.reserve == 1_000 * X - ca - cb);
        assert_eq!(p.claim(&mut a, end + DAY), Err(Error::NothingToClaim));
    }

    #[test]
    fn the_stream_pauses_while_nobody_is_staked() {
        let (mut p, mut a) = (Pool::default(), Account::default());
        p.fund(T0, 700 * X, 7 * DAY).unwrap();
        // Three idle days: nothing is streamed and the end moves out by three days.
        p.stake(&mut a, T0 + 3 * DAY, 10 * X).unwrap();
        assert_eq!(p.period_end, T0 + 10 * DAY);
        // The staker leaves for two days in the middle and comes back: paused again.
        p.request_unstake(&mut a, T0 + 5 * DAY, 10 * X).unwrap();
        p.cancel_unstake(&mut a, T0 + 7 * DAY).unwrap();
        assert_eq!(p.period_end, T0 + 12 * DAY);
        let e = p.earned(&a, T0 + 12 * DAY);
        assert!(e <= 700 * X && 700 * X - e < 1_000_000, "the whole pot reaches the only staker: {e}");
    }

    #[test]
    fn unstaking_stops_earning_and_waits_out_the_delay() {
        let (mut p, mut a) = (Pool::default(), Account::default());
        p.stake(&mut a, T0, 50 * X).unwrap();
        p.fund(T0, 365 * X, 365 * DAY).unwrap();
        let t = T0 + 10 * DAY;
        assert_eq!(p.request_unstake(&mut a, t, 60 * X), Err(Error::Insufficient));
        assert_eq!(p.request_unstake(&mut a, t, 0), Err(Error::ZeroAmount));
        assert_eq!(p.request_unstake(&mut a, t, 50 * X - 1), Err(Error::BelowMinimum), "would leave dust staked");
        p.request_unstake(&mut a, t, 50 * X).unwrap();
        assert_eq!((a.staked, a.pending, a.unlock_at, p.total_staked, p.total_pending), (0, 50 * X, t + UNSTAKE_DELAY_SECS, 0, 50 * X));
        let earned = p.earned(&a, t);
        assert_eq!(p.earned(&a, t + 30 * DAY), earned, "pending principal earns nothing");
        assert_eq!(p.withdraw(&mut a, t + UNSTAKE_DELAY_SECS - 1), Err(Error::StillLocked));
        assert_eq!(p.withdraw(&mut a, t + UNSTAKE_DELAY_SECS), Ok(50 * X));
        assert_eq!(p.withdraw(&mut a, t + UNSTAKE_DELAY_SECS), Err(Error::NothingPending));
        assert_eq!(p.total_pending, 0);
        // Rewards earned before unstaking are still claimable afterwards.
        assert_eq!(p.claim(&mut a, t + 40 * DAY), Ok(earned));
        assert!(a.is_empty());
    }

    #[test]
    fn a_second_unstake_request_restarts_the_delay_for_everything_pending() {
        let (mut p, mut a) = (Pool::default(), Account::default());
        p.stake(&mut a, T0, 10 * X).unwrap();
        p.request_unstake(&mut a, T0, 4 * X).unwrap();
        p.request_unstake(&mut a, T0 + 2 * DAY, 6 * X).unwrap();
        assert_eq!((a.pending, a.unlock_at), (10 * X, T0 + 2 * DAY + UNSTAKE_DELAY_SECS));
        assert_eq!(p.withdraw(&mut a, T0 + UNSTAKE_DELAY_SECS), Err(Error::StillLocked));
        assert_eq!(p.withdraw(&mut a, T0 + 2 * DAY + UNSTAKE_DELAY_SECS), Ok(10 * X));
    }

    #[test]
    fn stake_has_a_minimum() {
        let (mut p, mut a) = (Pool::default(), Account::default());
        assert_eq!(p.stake(&mut a, T0, 0), Err(Error::ZeroAmount));
        assert_eq!(p.stake(&mut a, T0, X - 1), Err(Error::BelowMinimum));
        assert_eq!(p, Pool::default(), "a refused stake changes nothing");
        p.stake(&mut a, T0, X).unwrap();
        p.stake(&mut a, T0, 1).unwrap(); // topping up by any amount is fine
        assert_eq!((a.staked, p.total_staked), (X + 1, X + 1));
    }

    #[test]
    fn funding_rules() {
        let mut p = Pool::default();
        assert_eq!(p.fund(T0, 0, DAY), Err(Error::ZeroAmount));
        assert_eq!(p.fund(T0, X, DAY - 1), Err(Error::BadDuration));
        assert_eq!(p.fund(T0, X, MAX_FUND_SECS + 1), Err(Error::BadDuration));
        assert_eq!(p.fund(T0, DAY - 1, DAY), Err(Error::RateTooLow), "less than one quantum a second");
        let mut a = Account::default();
        p.stake(&mut a, T0, X).unwrap();
        p.fund(T0, 100 * X + 5, 10 * DAY).unwrap();
        let rate = p.rate;
        assert_eq!((rate, p.carry, p.reserve), (((100 * X + 5) / (10 * DAY)), (100 * X + 5) % (10 * DAY), 100 * X + 5));
        // A dust funding that would stretch the running stream is refused …
        assert_eq!(p.fund(T0 + DAY, 1, MAX_FUND_SECS), Err(Error::RateTooLow));
        assert_eq!((p.rate, p.period_end), (rate, T0 + 10 * DAY));
        // … one that keeps or raises the rate is accepted and restarts the period.
        p.fund(T0 + DAY, 100 * X, 10 * DAY).unwrap();
        assert!(p.rate >= rate && p.period_end == T0 + 11 * DAY);
        // After the stream has ended any rate of at least one quantum a second is fine.
        p.fund(T0 + 400 * DAY, 2 * DAY, DAY).unwrap();
    }

    #[test]
    fn the_clock_never_runs_backwards() {
        let (mut p, mut a) = (Pool::default(), Account::default());
        p.stake(&mut a, T0, X).unwrap();
        p.fund(T0, 10 * X, DAY).unwrap();
        p.advance(T0 + 100);
        let acc = p.acc;
        p.advance(T0 + 50);
        assert_eq!((p.acc, p.last_update), (acc, T0 + 100));
    }

    /// Many accounts stake, top up, unstake, cancel, withdraw and claim at pseudo-random times
    /// while the pot is funded repeatedly. Whatever the order: principal comes back exactly,
    /// rewards paid never exceed rewards funded, and the three tracked balances always add up.
    #[test]
    fn value_is_conserved_under_random_activity() {
        let mut seed = 0x9e37_79b9_7f4a_7c15u64;
        let mut rnd = move |n: u64| { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; seed % n };
        for _ in 0..40 {
            let mut p = Pool::default();
            let mut accts = [Account::default(); 6];
            let (mut now, mut paid_in, mut paid_out, mut funded, mut claimed) = (T0, 0u128, 0u128, 0u128, 0u128);
            for _ in 0..600 {
                now += rnd(2 * DAY);
                let i = rnd(6) as usize;
                let a = &mut accts[i];
                match rnd(7) {
                    0 | 1 => { let amt = rnd(5_000 * X) + 1; if p.stake(a, now, amt).is_ok() { paid_in += amt as u128; } }
                    2 => { let amt = rnd(a.staked.max(1)) + 1; let _ = p.request_unstake(a, now, amt); }
                    3 => { let _ = p.cancel_unstake(a, now); }
                    4 => { if let Ok(v) = p.withdraw(a, now) { paid_out += v as u128; } }
                    5 => { if let Ok(v) = p.claim(a, now) { claimed += v as u128; } }
                    _ => { let amt = rnd(20_000 * X) + 1; if p.fund(now, amt, DAY + rnd(60 * DAY)).is_ok() { funded += amt as u128; } }
                }
                let (st, pe): (u128, u128) = accts.iter().fold((0, 0), |(s, q), a| (s + a.staked as u128, q + a.pending as u128));
                assert_eq!((st, pe), (p.total_staked as u128, p.total_pending as u128));
                assert_eq!(paid_in - paid_out, st + pe, "principal held = principal tracked");
                assert_eq!(funded - claimed, p.reserve as u128, "rewards held = rewards tracked");
            }
            // Everyone leaves: all principal returns, and no more than what was funded was claimed.
            now += 400 * DAY;
            for a in accts.iter_mut() {
                if a.staked > 0 { let s = a.staked; p.request_unstake(a, now, s).unwrap(); }
            }
            now += UNSTAKE_DELAY_SECS;
            for a in accts.iter_mut() {
                if let Ok(v) = p.withdraw(a, now) { paid_out += v as u128; }
                if let Ok(v) = p.claim(a, now) { claimed += v as u128; }
                assert!(a.is_empty(), "{a:?}");
            }
            assert_eq!(paid_in, paid_out, "every staker gets exactly their principal back");
            assert!(claimed <= funded);
            assert_eq!((p.total_staked, p.total_pending), (0, 0));
        }
    }
}
