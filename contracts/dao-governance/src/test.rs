#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};

use crate::{DaoGovernance, DaoGovernanceClient, GovernanceError};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Deploy and initialise a fresh contract, returning (env, client, admin, token).
fn setup() -> (Env, DaoGovernanceClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(DaoGovernance, ());
    let client = DaoGovernanceClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);

    client
        .initialize(&admin, &token, &100_i128, &100_u32, &50_u32)
        .unwrap();

    (env, client, admin, token)
}

/// Helper: create a proposal and return its id.
fn make_proposal(
    env: &Env,
    client: &DaoGovernanceClient,
    proposer: &Address,
    deposit: i128,
) -> u32 {
    let title = Bytes::from_slice(env, b"Test Proposal");
    let desc = Bytes::from_slice(env, b"A test governance proposal");
    let payload = Bytes::from_slice(env, b"");
    client
        .create_proposal(proposer, &title, &desc, &deposit, &payload)
        .unwrap()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn test_initialize_stores_admin() {
    let (_env, _client, _admin, _token) = setup();
    // If setup() returned without panic, initialization succeeded.
}

#[test]
fn test_double_initialize_fails() {
    let (env, client, admin, token) = setup();
    let result = client.try_initialize(&admin, &token, &100_i128, &100_u32, &50_u32);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::AlreadyInitialized as u32)
    );
    let _ = env;
}

// ---------------------------------------------------------------------------
// Badge + vote flow
// ---------------------------------------------------------------------------

#[test]
fn test_grant_badge_and_vote() {
    let (env, client, admin, _token) = setup();

    let voter = Address::generate(&env);
    client.grant_badge(&admin, &voter).unwrap();

    // Create proposal (proposer also needs a badge)
    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    // Vote FOR with 9 credits → 3 votes
    client.vote(&voter, &pid, &9_i128, &true).unwrap();

    let proposal = client.get_proposal(&pid).unwrap();
    assert_eq!(proposal.yes_votes, 3);
    assert_eq!(proposal.no_votes, 0);
}

// ---------------------------------------------------------------------------
// credits_to_votes (quadratic math)
// ---------------------------------------------------------------------------

#[test]
fn test_credits_to_votes_sqrt() {
    assert_eq!(DaoGovernance::credits_to_votes(1), 1);
    assert_eq!(DaoGovernance::credits_to_votes(4), 2);
    assert_eq!(DaoGovernance::credits_to_votes(9), 3);
    assert_eq!(DaoGovernance::credits_to_votes(16), 4);
    assert_eq!(DaoGovernance::credits_to_votes(25), 5);
    assert_eq!(DaoGovernance::credits_to_votes(100), 10);
    // Non-perfect squares → floor
    assert_eq!(DaoGovernance::credits_to_votes(2), 1);
    assert_eq!(DaoGovernance::credits_to_votes(10), 3);
}

// ---------------------------------------------------------------------------
// Duplicate vote rejection
// ---------------------------------------------------------------------------

#[test]
fn test_duplicate_vote_rejected() {
    let (env, client, admin, _token) = setup();

    let voter = Address::generate(&env);
    client.grant_badge(&admin, &voter).unwrap();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    client.vote(&voter, &pid, &4_i128, &true).unwrap();

    let result = client.try_vote(&voter, &pid, &4_i128, &true);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::AlreadyVoted as u32)
    );
}

// ---------------------------------------------------------------------------
// No-badge rejection
// ---------------------------------------------------------------------------

#[test]
fn test_vote_without_badge_rejected() {
    let (env, client, admin, _token) = setup();

    let no_badge_voter = Address::generate(&env);

    // Need a badged proposer
    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    let result = client.try_vote(&no_badge_voter, &pid, &4_i128, &true);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::NoBadge as u32)
    );
}

#[test]
fn test_create_proposal_without_badge_rejected() {
    let (env, client, _admin, _token) = setup();

    let proposer = Address::generate(&env);
    let title = Bytes::from_slice(&env, b"Rogue Proposal");
    let desc = Bytes::from_slice(&env, b"Should fail");
    let payload = Bytes::from_slice(&env, b"");

    let result = client.try_create_proposal(&proposer, &title, &desc, &100_i128, &payload);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::NoBadge as u32)
    );
}

// ---------------------------------------------------------------------------
// Proposal creation and finalization
// ---------------------------------------------------------------------------

#[test]
fn test_proposal_creation_and_finalization() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();

    let pid = make_proposal(&env, &client, &proposer, 100);

    // Proposal should be Active
    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, crate::types::ProposalStatus::Active);

    // Add a YES voter
    let voter = Address::generate(&env);
    client.grant_badge(&admin, &voter).unwrap();
    client.vote(&voter, &pid, &9_i128, &true).unwrap();

    // Advance ledger past end_ledger (voting_period = 100)
    env.ledger().set_sequence_number(env.ledger().sequence() + 101);

    client.finalize(&pid).unwrap();

    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, crate::types::ProposalStatus::Passed);
}

#[test]
fn test_finalize_fails_voted_no() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    // Vote AGAINST
    let voter = Address::generate(&env);
    client.grant_badge(&admin, &voter).unwrap();
    client.vote(&voter, &pid, &25_i128, &false).unwrap(); // 5 votes no

    env.ledger().set_sequence_number(env.ledger().sequence() + 101);
    client.finalize(&pid).unwrap();

    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, crate::types::ProposalStatus::Failed);
}

#[test]
fn test_finalize_before_period_ends_fails() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    // Do NOT advance ledger
    let result = client.try_finalize(&pid);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::VotingPeriodNotEnded as u32)
    );
}

// ---------------------------------------------------------------------------
// Execute with timelock
// ---------------------------------------------------------------------------

#[test]
fn test_execute_after_timelock() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    let voter = Address::generate(&env);
    client.grant_badge(&admin, &voter).unwrap();
    client.vote(&voter, &pid, &4_i128, &true).unwrap();

    // Advance past end_ledger (100) + timelock (50) = 151 ledgers
    env.ledger().set_sequence_number(env.ledger().sequence() + 160);

    client.finalize(&pid).unwrap();

    let caller = Address::generate(&env);
    client.execute(&caller, &pid).unwrap();

    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, crate::types::ProposalStatus::Executed);
    assert!(p.executed);
}

#[test]
fn test_execute_before_timelock_fails() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    let voter = Address::generate(&env);
    client.grant_badge(&admin, &voter).unwrap();
    client.vote(&voter, &pid, &4_i128, &true).unwrap();

    // Advance past voting period but NOT past timelock
    env.ledger().set_sequence_number(env.ledger().sequence() + 110);
    client.finalize(&pid).unwrap();

    let caller = Address::generate(&env);
    let result = client.try_execute(&caller, &pid);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::TimelockNotExpired as u32)
    );
}

// ---------------------------------------------------------------------------
// Circular delegation detection
// ---------------------------------------------------------------------------

#[test]
fn test_circular_delegation_direct() {
    // A -> B -> A  should fail
    let (env, client, _admin, _token) = setup();

    let a = Address::generate(&env);
    let b = Address::generate(&env);

    client.delegate(&a, &b).unwrap();

    let result = client.try_delegate(&b, &a);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::CircularDelegation as u32)
    );
}

#[test]
fn test_circular_delegation_chain() {
    // A -> B -> C -> A  should fail
    let (env, client, _admin, _token) = setup();

    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let c = Address::generate(&env);

    client.delegate(&a, &b).unwrap();
    client.delegate(&b, &c).unwrap();

    // C -> A would close the loop
    let result = client.try_delegate(&c, &a);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::CircularDelegation as u32)
    );
}

#[test]
fn test_self_delegation_rejected() {
    let (env, client, _admin, _token) = setup();
    let a = Address::generate(&env);
    // A -> A is immediately circular
    let result = client.try_delegate(&a, &a);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::CircularDelegation as u32)
    );
}

#[test]
fn test_remove_delegation() {
    let (env, client, _admin, _token) = setup();
    let a = Address::generate(&env);
    let b = Address::generate(&env);

    client.delegate(&a, &b).unwrap();
    assert!(client.get_delegation(&a).is_some());

    client.remove_delegation(&a).unwrap();
    assert!(client.get_delegation(&a).is_none());
}

// ---------------------------------------------------------------------------
// Pause / unpause
// ---------------------------------------------------------------------------

#[test]
fn test_pause_blocks_vote() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    let voter = Address::generate(&env);
    client.grant_badge(&admin, &voter).unwrap();

    // Pause the contract
    client.pause(&admin).unwrap();

    let result = client.try_vote(&voter, &pid, &9_i128, &true);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::Paused as u32)
    );
}

#[test]
fn test_unpause_allows_vote() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    let voter = Address::generate(&env);
    client.grant_badge(&admin, &voter).unwrap();

    client.pause(&admin).unwrap();
    client.unpause(&admin).unwrap();

    // Should succeed after unpause
    client.vote(&voter, &pid, &9_i128, &true).unwrap();
    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.yes_votes, 3);
}

#[test]
fn test_pause_blocks_create_proposal() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();

    client.pause(&admin).unwrap();

    let title = Bytes::from_slice(&env, b"Blocked");
    let desc = Bytes::from_slice(&env, b"Should fail");
    let payload = Bytes::from_slice(&env, b"");
    let result = client.try_create_proposal(&proposer, &title, &desc, &100_i128, &payload);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::Paused as u32)
    );
}

// ---------------------------------------------------------------------------
// Insufficient deposit
// ---------------------------------------------------------------------------

#[test]
fn test_insufficient_deposit_rejected() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();

    let title = Bytes::from_slice(&env, b"Low-budget proposal");
    let desc = Bytes::from_slice(&env, b"Should fail");
    let payload = Bytes::from_slice(&env, b"");

    // min_deposit is 100, we send 50
    let result = client.try_create_proposal(&proposer, &title, &desc, &50_i128, &payload);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::InsufficientDeposit as u32)
    );
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

#[test]
fn test_cancel_proposal() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    client.cancel(&admin, &pid).unwrap();

    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, crate::types::ProposalStatus::Cancelled);
    assert!(p.cancelled);
}

#[test]
fn test_non_admin_cannot_cancel() {
    let (env, client, admin, _token) = setup();

    let proposer = Address::generate(&env);
    client.grant_badge(&admin, &proposer).unwrap();
    let pid = make_proposal(&env, &client, &proposer, 100);

    let rando = Address::generate(&env);
    let result = client.try_cancel(&rando, &pid);
    assert_eq!(
        result.unwrap_err().unwrap(),
        soroban_sdk::Error::from_contract_error(GovernanceError::Unauthorized as u32)
    );
}
