//! Tests for the ERC-4337-style smart wallet (Issue #1810).
//!
//! Covers:
//!   1. Initialisation and owner retrieval
//!   2. Guardian add/remove
//!   3. Recovery proposal flow (multi-guardian approval)
//!   4. Recovery timelock enforcement
//!   5. Recovery execution after timelock
//!   6. Session key add/revoke/validity checks
//!   7. Nonce increment

#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    vec, Address, BytesN, Env, Symbol,
};

use crate::{Error, SmartWallet, SmartWalletClient};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Deploy the contract and return (env, client).
fn setup() -> (Env, SmartWalletClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(SmartWallet, ());
    let client = SmartWalletClient::new(&env, &contract_id);
    (env, client)
}

/// Generate a deterministic 32-byte owner public key for testing.
fn dummy_owner(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0x01u8; 32])
}

fn dummy_owner2(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0x02u8; 32])
}

// ---------------------------------------------------------------------------
// 1. Initialisation
// ---------------------------------------------------------------------------

#[test]
fn test_initialize_and_get_owner() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);

    client.initialize(&owner, &1u32);

    let stored = client.get_owner();
    assert_eq!(stored, owner);
}

#[test]
fn test_initialize_twice_returns_error() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);

    client.initialize(&owner, &1u32);
    let result = client.try_initialize(&owner, &1u32);
    assert_eq!(result, Err(Ok(Error::AlreadyInitialized)));
}

#[test]
fn test_initialize_zero_threshold_returns_error() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);

    let result = client.try_initialize(&owner, &0u32);
    assert_eq!(result, Err(Ok(Error::InvalidThreshold)));
}

#[test]
fn test_get_owner_before_init_returns_error() {
    let (_env, client) = setup();
    let result = client.try_get_owner();
    assert_eq!(result, Err(Ok(Error::NotInitialized)));
}

// ---------------------------------------------------------------------------
// 2. Rotate owner
// ---------------------------------------------------------------------------

#[test]
fn test_rotate_owner() {
    let (env, client) = setup();
    let owner_key = dummy_owner(&env);
    let new_key = dummy_owner2(&env);
    let caller = Address::generate(&env);

    client.initialize(&owner_key, &1u32);
    client.rotate_owner(&caller, &new_key);

    assert_eq!(client.get_owner(), new_key);
}

// ---------------------------------------------------------------------------
// 3. Guardian management
// ---------------------------------------------------------------------------

#[test]
fn test_add_and_verify_guardian() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian = Address::generate(&env);

    client.initialize(&owner, &1u32);
    client.add_guardian(&caller, &guardian);

    // Guardian should now be able to initiate recovery.
    let new_key = dummy_owner2(&env);
    client.initiate_recovery(&guardian, &new_key);

    let proposal = client
        .get_recovery_proposal()
        .expect("proposal should exist");
    assert_eq!(proposal.approvals, 1);
    assert_eq!(proposal.new_owner, new_key);
}

#[test]
fn test_add_guardian_twice_returns_error() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian = Address::generate(&env);

    client.initialize(&owner, &1u32);
    client.add_guardian(&caller, &guardian);

    let result = client.try_add_guardian(&caller, &guardian);
    assert_eq!(result, Err(Ok(Error::GuardianAlreadyExists)));
}

#[test]
fn test_remove_guardian() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian = Address::generate(&env);

    client.initialize(&owner, &1u32);
    client.add_guardian(&caller, &guardian);
    client.remove_guardian(&caller, &guardian);

    // Guardian should no longer be able to initiate recovery.
    let new_key = dummy_owner2(&env);
    let result = client.try_initiate_recovery(&guardian, &new_key);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_remove_nonexistent_guardian_returns_error() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian = Address::generate(&env);

    client.initialize(&owner, &1u32);

    let result = client.try_remove_guardian(&caller, &guardian);
    assert_eq!(result, Err(Ok(Error::GuardianNotFound)));
}

// ---------------------------------------------------------------------------
// 4. Recovery proposal – multiple guardians
// ---------------------------------------------------------------------------

#[test]
fn test_recovery_multiple_guardians_accumulate_approvals() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian1 = Address::generate(&env);
    let guardian2 = Address::generate(&env);
    let new_key = dummy_owner2(&env);

    client.initialize(&owner, &2u32);
    client.add_guardian(&caller, &guardian1);
    client.add_guardian(&caller, &guardian2);

    client.initiate_recovery(&guardian1, &new_key);
    let p1 = client.get_recovery_proposal().unwrap();
    assert_eq!(p1.approvals, 1);

    client.initiate_recovery(&guardian2, &new_key);
    let p2 = client.get_recovery_proposal().unwrap();
    assert_eq!(p2.approvals, 2);
}

#[test]
fn test_recovery_different_target_resets_proposal() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian1 = Address::generate(&env);
    let guardian2 = Address::generate(&env);
    let key_a = dummy_owner(&env);
    let key_b = dummy_owner2(&env);

    client.initialize(&owner, &2u32);
    client.add_guardian(&caller, &guardian1);
    client.add_guardian(&caller, &guardian2);

    // Guardian 1 proposes key_a.
    client.initiate_recovery(&guardian1, &key_a);
    assert_eq!(client.get_recovery_proposal().unwrap().approvals, 1);

    // Guardian 2 proposes a *different* key – proposal resets.
    client.initiate_recovery(&guardian2, &key_b);
    let p = client.get_recovery_proposal().unwrap();
    assert_eq!(p.approvals, 1, "approvals should reset to 1 for new target");
    assert_eq!(p.new_owner, key_b);
}

// ---------------------------------------------------------------------------
// 5. Recovery timelock enforcement
// ---------------------------------------------------------------------------

#[test]
fn test_execute_recovery_fails_before_timelock() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian = Address::generate(&env);
    let new_key = dummy_owner2(&env);
    let exec_caller = Address::generate(&env);

    client.initialize(&owner, &1u32);
    client.add_guardian(&caller, &guardian);
    client.initiate_recovery(&guardian, &new_key);

    // Advance ledger by less than RECOVERY_TIMELOCK_LEDGERS (34560).
    let current_seq = env.ledger().sequence();
    env.ledger().set(LedgerInfo {
        sequence_number: current_seq + 100, // well within timelock
        timestamp: 0,
        protocol_version: 22,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_312_000,
    });

    let result = client.try_execute_recovery(&exec_caller);
    assert_eq!(result, Err(Ok(Error::RecoveryTimelockActive)));
}

// ---------------------------------------------------------------------------
// 6. Recovery executes after timelock
// ---------------------------------------------------------------------------

#[test]
fn test_execute_recovery_succeeds_after_timelock() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian = Address::generate(&env);
    let new_key = dummy_owner2(&env);
    let exec_caller = Address::generate(&env);

    client.initialize(&owner, &1u32);
    client.add_guardian(&caller, &guardian);
    client.initiate_recovery(&guardian, &new_key);

    // Advance ledger beyond RECOVERY_TIMELOCK_LEDGERS (34560).
    let current_seq = env.ledger().sequence();
    env.ledger().set(LedgerInfo {
        sequence_number: current_seq + 34_561,
        timestamp: 0,
        protocol_version: 22,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_312_000,
    });

    client.execute_recovery(&exec_caller);
    assert_eq!(client.get_owner(), new_key);

    // Proposal should be marked executed.
    let proposal = client.get_recovery_proposal().unwrap();
    assert!(proposal.executed);
}

#[test]
fn test_execute_recovery_fails_insufficient_approvals() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian = Address::generate(&env);
    let new_key = dummy_owner2(&env);
    let exec_caller = Address::generate(&env);

    // Threshold = 2 but only 1 guardian approves.
    client.initialize(&owner, &2u32);
    client.add_guardian(&caller, &guardian);
    client.initiate_recovery(&guardian, &new_key);

    let current_seq = env.ledger().sequence();
    env.ledger().set(LedgerInfo {
        sequence_number: current_seq + 34_561,
        timestamp: 0,
        protocol_version: 22,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_312_000,
    });

    let result = client.try_execute_recovery(&exec_caller);
    assert_eq!(result, Err(Ok(Error::InsufficientApprovals)));
}

// ---------------------------------------------------------------------------
// 7. Cancel recovery
// ---------------------------------------------------------------------------

#[test]
fn test_cancel_recovery() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let guardian = Address::generate(&env);
    let new_key = dummy_owner2(&env);
    let owner_caller = Address::generate(&env);

    client.initialize(&owner, &1u32);
    client.add_guardian(&caller, &guardian);
    client.initiate_recovery(&guardian, &new_key);

    // Owner cancels.
    client.cancel_recovery(&owner_caller);
    assert!(client.get_recovery_proposal().is_none());
}

#[test]
fn test_cancel_recovery_no_proposal_returns_error() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);

    client.initialize(&owner, &1u32);

    let result = client.try_cancel_recovery(&caller);
    assert_eq!(result, Err(Ok(Error::RecoveryNotFound)));
}

// ---------------------------------------------------------------------------
// 8. Session key management
// ---------------------------------------------------------------------------

#[test]
fn test_add_and_validate_session_key() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let session_key = Address::generate(&env);

    let transfer_sym = Symbol::new(&env, "transfer");
    let allowed = vec![&env, transfer_sym.clone()];
    let expiry = 1_000u32;

    client.initialize(&owner, &1u32);
    client.add_session_key(&caller, &session_key, &allowed, &expiry);

    // Current ledger is 0 (< expiry=1000); should be valid.
    assert!(client.is_session_key_valid(&session_key, &transfer_sym));

    // A different function should NOT be valid.
    let other_sym = Symbol::new(&env, "swap");
    assert!(!client.is_session_key_valid(&session_key, &other_sym));
}

#[test]
fn test_session_key_expired() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let session_key = Address::generate(&env);

    let transfer_sym = Symbol::new(&env, "transfer");
    let allowed = vec![&env, transfer_sym.clone()];
    let expiry = 5u32; // expires at ledger 5

    client.initialize(&owner, &1u32);
    client.add_session_key(&caller, &session_key, &allowed, &expiry);

    // Advance past expiry.
    let current_seq = env.ledger().sequence();
    env.ledger().set(LedgerInfo {
        sequence_number: current_seq + 10,
        timestamp: 0,
        protocol_version: 22,
        network_id: Default::default(),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 4096,
        max_entry_ttl: 6_312_000,
    });

    assert!(!client.is_session_key_valid(&session_key, &transfer_sym));
}

#[test]
fn test_revoke_session_key() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let session_key = Address::generate(&env);

    let transfer_sym = Symbol::new(&env, "transfer");
    let allowed = vec![&env, transfer_sym.clone()];
    let expiry = 10_000u32;

    client.initialize(&owner, &1u32);
    client.add_session_key(&caller, &session_key, &allowed, &expiry);

    // Sanity: valid before revocation.
    assert!(client.is_session_key_valid(&session_key, &transfer_sym));

    // Revoke.
    client.revoke_session_key(&caller, &session_key);

    // Should be invalid now.
    assert!(!client.is_session_key_valid(&session_key, &transfer_sym));
}

#[test]
fn test_revoke_nonexistent_session_key_returns_error() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);
    let session_key = Address::generate(&env);

    client.initialize(&owner, &1u32);

    let result = client.try_revoke_session_key(&caller, &session_key);
    assert_eq!(result, Err(Ok(Error::SessionKeyNotFound)));
}

#[test]
fn test_is_session_key_valid_unknown_key_returns_false() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let unknown = Address::generate(&env);

    client.initialize(&owner, &1u32);

    let sym = Symbol::new(&env, "transfer");
    assert!(!client.is_session_key_valid(&unknown, &sym));
}

// ---------------------------------------------------------------------------
// 9. Nonce
// ---------------------------------------------------------------------------

#[test]
fn test_nonce_starts_at_zero() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);

    client.initialize(&owner, &1u32);
    assert_eq!(client.get_nonce(), 0u64);
}

#[test]
fn test_increment_nonce() {
    let (env, client) = setup();
    let owner = dummy_owner(&env);
    let caller = Address::generate(&env);

    client.initialize(&owner, &1u32);
    client.increment_nonce(&caller);
    assert_eq!(client.get_nonce(), 1u64);

    client.increment_nonce(&caller);
    assert_eq!(client.get_nonce(), 2u64);
}
