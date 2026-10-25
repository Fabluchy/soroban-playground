#![no_std]

mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, Env,
};

use storage::{DataKey, get_delegation as storage_get_delegation};
use types::{DelegationRecord, Proposal, ProposalStatus, VoteRecord};

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GovernanceError {
    AlreadyInitialized   = 1,
    NotInitialized       = 2,
    Unauthorized         = 3,
    ProposalNotFound     = 4,
    ProposalNotActive    = 5,
    AlreadyVoted         = 6,
    NoBadge              = 7,
    InsufficientDeposit  = 8,
    VotingPeriodNotEnded = 9,
    TimelockNotExpired   = 10,
    AlreadyExecuted      = 11,
    AlreadyCancelled     = 12,
    CircularDelegation   = 13,
    Paused               = 14,
    InvalidCredits       = 15,
}

impl From<GovernanceError> for soroban_sdk::Error {
    fn from(e: GovernanceError) -> Self {
        soroban_sdk::Error::from_contract_error(e as u32)
    }
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/// Integer square root via Newton's method (no floating-point).
/// Returns floor(sqrt(n)).
fn integer_sqrt(n: i128) -> i128 {
    if n <= 0 {
        return 0;
    }
    if n == 1 {
        return 1;
    }
    // Initial guess: shift right by half the bit length
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct DaoGovernance;

#[contractimpl]
impl DaoGovernance {
    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    /// Initialize the DAO governance contract.
    /// Can only be called once.
    pub fn initialize(
        env: Env,
        admin: Address,
        token_contract: Address,
        min_deposit: i128,
        voting_period_ledgers: u32,
        timelock_delay_ledgers: u32,
    ) -> Result<(), GovernanceError> {
        if env
            .storage()
            .instance()
            .has(&DataKey::Admin)
        {
            return Err(GovernanceError::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::TokenContract, &token_contract);
        env.storage()
            .instance()
            .set(&DataKey::MinDeposit, &min_deposit);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriod, &voting_period_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::TimelockDelay, &timelock_delay_ledgers);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::Paused, &false);

        env.storage().instance().extend_ttl(100_000, 200_000);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Soulbound badge management
    // -----------------------------------------------------------------------

    /// Admin grants a soulbound badge to a voter (Sybil resistance).
    pub fn grant_badge(
        env: Env,
        admin: Address,
        voter: Address,
    ) -> Result<(), GovernanceError> {
        Self::require_admin(&env, &admin)?;
        storage::grant_badge(&env, &voter);
        Ok(())
    }

    /// Admin revokes a soulbound badge from a voter.
    pub fn revoke_badge(
        env: Env,
        admin: Address,
        voter: Address,
    ) -> Result<(), GovernanceError> {
        Self::require_admin(&env, &admin)?;
        storage::revoke_badge(&env, &voter);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Proposal lifecycle
    // -----------------------------------------------------------------------

    /// Create a new governance proposal.
    /// Proposer must hold a soulbound badge and provide >= min_deposit.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        title: Bytes,
        description: Bytes,
        deposit: i128,
        payload: Bytes,
    ) -> Result<u32, GovernanceError> {
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;

        proposer.require_auth();

        // Sybil resistance check
        if !storage::has_soulbound_badge(&env, &proposer) {
            return Err(GovernanceError::NoBadge);
        }

        // Deposit check (tracked internally — no token transfer)
        let min_deposit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinDeposit)
            .unwrap_or(0);
        if deposit < min_deposit {
            return Err(GovernanceError::InsufficientDeposit);
        }

        let voting_period: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(1000);
        let timelock_delay: u32 = env
            .storage()
            .instance()
            .get(&DataKey::TimelockDelay)
            .unwrap_or(500);

        let current_ledger = env.ledger().sequence();
        let end_ledger = current_ledger + voting_period;
        let execution_ledger = end_ledger + timelock_delay;

        // Assign proposal ID
        let proposal_count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = proposal_count;

        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            title,
            description,
            yes_votes: 0,
            no_votes: 0,
            start_ledger: current_ledger,
            end_ledger,
            execution_ledger,
            executed: false,
            cancelled: false,
            deposit,
            payload,
            status: ProposalStatus::Active,
        };

        storage::set_proposal(&env, &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &(proposal_count + 1));
        env.storage().instance().extend_ttl(100_000, 200_000);

        env.events().publish(
            (symbol_short!("proposed"), proposer),
            proposal_id,
        );

        Ok(proposal_id)
    }

    // -----------------------------------------------------------------------
    // Voting
    // -----------------------------------------------------------------------

    /// Cast a quadratic vote on a proposal.
    /// effective_votes = integer_sqrt(credits).
    /// Voter must hold a soulbound badge. One vote per voter per proposal.
    pub fn vote(
        env: Env,
        voter: Address,
        proposal_id: u32,
        credits: i128,
        is_for: bool,
    ) -> Result<(), GovernanceError> {
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;

        voter.require_auth();

        if credits <= 0 {
            return Err(GovernanceError::InvalidCredits);
        }

        // Sybil resistance
        if !storage::has_soulbound_badge(&env, &voter) {
            return Err(GovernanceError::NoBadge);
        }

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(GovernanceError::ProposalNotActive);
        }

        // Check voting window is still open
        let current_ledger = env.ledger().sequence();
        if current_ledger > proposal.end_ledger {
            return Err(GovernanceError::ProposalNotActive);
        }

        // Prevent duplicate votes
        if storage::get_vote(&env, proposal_id, &voter).is_some() {
            return Err(GovernanceError::AlreadyVoted);
        }

        let vote_weight = integer_sqrt(credits);

        let record = VoteRecord {
            credits_spent: credits,
            vote_weight,
            is_for,
        };
        storage::set_vote(&env, proposal_id, &voter, &record);

        if is_for {
            proposal.yes_votes += vote_weight;
        } else {
            proposal.no_votes += vote_weight;
        }
        storage::set_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("voted"), voter),
            (proposal_id, credits, vote_weight, is_for),
        );

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Delegation
    // -----------------------------------------------------------------------

    /// Delegate voting power to another address.
    /// Detects circular loops up to depth 10.
    pub fn delegate(
        env: Env,
        voter: Address,
        delegate: Address,
    ) -> Result<(), GovernanceError> {
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;

        voter.require_auth();

        // Walk the delegation chain starting from `delegate` and check
        // whether we ever reach `voter` (circular loop detection).
        let mut current = delegate.clone();
        for _ in 0..10 {
            if current == voter {
                return Err(GovernanceError::CircularDelegation);
            }
            match storage_get_delegation(&env, &current) {
                Some(rec) => current = rec.delegate,
                None => break,
            }
        }

        storage::set_delegation(
            &env,
            &voter,
            &DelegationRecord {
                delegate: delegate.clone(),
            },
        );

        env.events().publish(
            (symbol_short!("delegated"), voter),
            delegate,
        );

        Ok(())
    }

    /// Remove an existing delegation.
    pub fn remove_delegation(env: Env, voter: Address) -> Result<(), GovernanceError> {
        Self::require_initialized(&env)?;
        voter.require_auth();
        storage::remove_delegation(&env, &voter);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Finalization & execution
    // -----------------------------------------------------------------------

    /// Finalize a proposal after the voting period ends.
    /// Sets status to Passed or Failed based on vote totals.
    pub fn finalize(env: Env, proposal_id: u32) -> Result<(), GovernanceError> {
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(GovernanceError::ProposalNotActive);
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger <= proposal.end_ledger {
            return Err(GovernanceError::VotingPeriodNotEnded);
        }

        proposal.status = if proposal.yes_votes > proposal.no_votes {
            ProposalStatus::Passed
        } else {
            ProposalStatus::Failed
        };

        storage::set_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("finalized"),),
            (proposal_id, proposal.yes_votes, proposal.no_votes),
        );

        Ok(())
    }

    /// Execute a passed proposal after the timelock expires.
    /// Marks the proposal as executed and emits an event.
    /// Actual cross-contract dispatch is intentionally out-of-scope for the
    /// on-chain MVP — callers can use the payload bytes off-chain or extend
    /// this function for specific dispatch patterns.
    pub fn execute(
        env: Env,
        caller: Address,
        proposal_id: u32,
    ) -> Result<(), GovernanceError> {
        Self::require_not_paused(&env)?;
        Self::require_initialized(&env)?;

        caller.require_auth();

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.cancelled {
            return Err(GovernanceError::AlreadyCancelled);
        }
        if proposal.executed {
            return Err(GovernanceError::AlreadyExecuted);
        }
        if proposal.status != ProposalStatus::Passed {
            return Err(GovernanceError::ProposalNotActive);
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger < proposal.execution_ledger {
            return Err(GovernanceError::TimelockNotExpired);
        }

        proposal.executed = true;
        proposal.status = ProposalStatus::Executed;
        storage::set_proposal(&env, &proposal);

        env.events().publish(
            (symbol_short!("executed"),),
            (proposal_id, caller),
        );

        Ok(())
    }

    /// Admin cancels an active proposal.
    pub fn cancel(
        env: Env,
        admin: Address,
        proposal_id: u32,
    ) -> Result<(), GovernanceError> {
        Self::require_admin(&env, &admin)?;

        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.cancelled {
            return Err(GovernanceError::AlreadyCancelled);
        }
        if proposal.executed {
            return Err(GovernanceError::AlreadyExecuted);
        }

        proposal.cancelled = true;
        proposal.status = ProposalStatus::Cancelled;
        storage::set_proposal(&env, &proposal);

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Emergency pause
    // -----------------------------------------------------------------------

    pub fn pause(env: Env, admin: Address) -> Result<(), GovernanceError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage().instance().extend_ttl(100_000, 200_000);
        env.events().publish((symbol_short!("paused"),), ());
        Ok(())
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), GovernanceError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().extend_ttl(100_000, 200_000);
        env.events().publish((symbol_short!("unpaused"),), ());
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Read-only helpers
    // -----------------------------------------------------------------------

    pub fn get_proposal(env: Env, id: u32) -> Result<Proposal, GovernanceError> {
        storage::get_proposal(&env, id).ok_or(GovernanceError::ProposalNotFound)
    }

    /// Pure function: integer_sqrt(credits).
    pub fn credits_to_votes(credits: i128) -> i128 {
        integer_sqrt(credits)
    }

    pub fn get_delegation(env: Env, voter: Address) -> Option<Address> {
        storage_get_delegation(&env, &voter).map(|r| r.delegate)
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    fn require_admin(env: &Env, caller: &Address) -> Result<(), GovernanceError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(GovernanceError::NotInitialized)?;
        if *caller != admin {
            return Err(GovernanceError::Unauthorized);
        }
        caller.require_auth();
        Ok(())
    }

    fn require_initialized(env: &Env) -> Result<(), GovernanceError> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(GovernanceError::NotInitialized);
        }
        Ok(())
    }

    fn require_not_paused(env: &Env) -> Result<(), GovernanceError> {
        if storage::is_paused(env) {
            return Err(GovernanceError::Paused);
        }
        Ok(())
    }
}
