//! Deliberately broken rule variants, used only by the mutation self-tests
//! (they prove that each property checker can see the failure it guards against).
//!
//! In every non-test build [`active`] is a constant `false`, so the mutated
//! branches are dead code and cannot ship. In test builds the switch is
//! thread-local: a test enables one mutation for its own thread and the guard
//! restores the correct rules when it is dropped.

/// A broken rule variant and the property that must catch it.
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Mutation {
    /// Precommit a block without taking the lock (§3.5 lock rule). Caught by P1.
    NoLockOnPrecommit,
    /// Quorum `⌊2T/3⌋` instead of `⌊2T/3⌋ + 1`. Caught by P1.
    QuorumOffByOne,
    /// Proposer rotation that ignores stake (plain round-robin). Caught by P6.
    ScheduleNotStakeWeighted,
    /// Downtime jailing without the "at least `m` distinct proposers" rule (§4.4 rule 2). Caught by P9.
    JailWithoutProposerRule,
    /// §4.4 rule 2 read literally: the *window* was assembled by `m` proposers,
    /// rather than the certificates the validator is *missing from*. Caught by P9.
    JailWindowProposersLiteral,
    /// Unearned reward share computed by formula instead of as the residual, losing rounding dust. Caught by P7.
    RewardRoundingLeak,
}

#[cfg(not(test))]
#[inline(always)]
/// Always `false` outside tests.
pub fn active(_m: Mutation) -> bool {
    false
}

#[cfg(test)]
thread_local! {
    static ACTIVE: std::cell::Cell<Option<Mutation>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
/// True if `m` is enabled on this thread.
pub fn active(m: Mutation) -> bool {
    ACTIVE.with(|a| a.get() == Some(m))
}

#[cfg(test)]
/// Restores the correct rules on drop.
pub struct Guard(());

#[cfg(test)]
/// Enable one mutation on this thread until the guard is dropped.
pub fn enable(m: Mutation) -> Guard {
    ACTIVE.with(|a| a.set(Some(m)));
    Guard(())
}

#[cfg(test)]
impl Drop for Guard {
    fn drop(&mut self) {
        ACTIVE.with(|a| a.set(None));
    }
}
