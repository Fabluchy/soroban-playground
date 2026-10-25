#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, BytesN as _, Ledger},
    Address, Bytes, BytesN, Env, String, Vec,
};

use crate::{
    types::{AssetTransfer, Error, ProposalStatus, SignatureBundle},
    MultisigTreasury, MultisigTreasuryClient,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Build a 32-byte Ed25519 "public key" for testing (just random bytes since
/// we will not actually call ed25519_verify in unit tests – the SDK test env
/// does not enforce crypto, so we stub with zero signatures recognised as
/// valid for signature verification skipping in testutils mode.
fn make_pubkey(env: &Env) -> BytesN<32> {
    BytesN::<32>::random(env)
}

fn make_64_sig(env: &Env, proposal_id: u32) -> Bytes {
    // First 4 bytes encode proposal_id (big-endian) – contract convention.
    let mut raw = [0u8; 64];
    let pid_bytes = proposal_id.to_be_bytes();
    raw[0] = pid_bytes[0];
    raw[1] = pid_bytes[1];
    raw[2] = pid_bytes[2];
    raw[3] = pid_bytes[3];
    Bytes::from_slice(env, &raw)
}

fn setup() -> (Env, MultisigTreasuryClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, MultisigTreasury);
    let client = MultisigTreasuryClient::new(&env, &contract_id);
    (env, client)
}

fn initialize_2_of_3(
    env: &Env,
    client: &MultisigTreasuryClient,
) -> (Address, Address, Address, Address) {
    let s1 = Address::generate(env);
    let s2 = Address::generate(env);
    let s3 = Address::generate(env);
    let guardian = Address::generate(env);

    let mut signers = Vec::new(env);
    signers.push_back(s1.clone());
    signers.push_back(s2.clone());
    signers.push_back(s3.clone());

    let mut pubkeys = Vec::new(env);
    pubkeys.push_back(make_pubkey(env));
    pubkeys.push_back(make_pubkey(env));
    pubkeys.push_back(make_pubkey(env));

    client
        .initialize(
            &2u32,
            &signers,
            &pubkeys,
            &3600u64,
            &1_000_000i128,
            &guardian,
        )
        .unwrap();

    (s1, s2, s3, guardian)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_success() {
    let (env, client) = setup();
    let (s1, s2, s3, guardian) = initialize_2_of_3(&env, &client);

    assert_eq!(client.get_threshold(), 2);
    assert_eq!(client.signer_count(), 3);
    assert_eq!(client.get_time_lock(), 3600);
    assert!(!client.is_paused());
    assert!(client.is_signer(&s1));
    assert!(client.is_signer(&s2));
    assert!(client.is_signer(&s3));
}

#[test]
fn test_double_initialize_rejected() {
    let (env, client) = setup();
    initialize_2_of_3(&env, &client);

    let s = Address::generate(&env);
    let mut signers = Vec::new(&env);
    signers.push_back(s.clone());
    let mut pks = Vec::new(&env);
    pks.push_back(make_pubkey(&env));

    let guardian = Address::generate(&env);
    let result = client.try_initialize(&1, &signers, &pks, &0, &0, &guardian);
    assert_eq!(result.unwrap_err().unwrap(), Error::AlreadyInitialized);
}

#[test]
fn test_invalid_threshold_rejected() {
    let (env, client) = setup();
    let s1 = Address::generate(&env);
    let mut signers = Vec::new(&env);
    signers.push_back(s1.clone());
    let mut pks = Vec::new(&env);
    pks.push_back(make_pubkey(&env));
    let guardian = Address::generate(&env);

    // threshold > n signers
    let result = client.try_initialize(&5, &signers, &pks, &0, &0, &guardian);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidThreshold);

    // threshold = 0
    let result2 = client.try_initialize(&0, &signers, &pks, &0, &0, &guardian);
    assert_eq!(result2.unwrap_err().unwrap(), Error::InvalidThreshold);
}

#[test]
fn test_propose_transfer() {
    let (env, client) = setup();
    let (s1, _s2, _s3, _guardian) = initialize_2_of_3(&env, &client);

    let token = Address::generate(&env);
    let recipient = Address::generate(&env);

    let mut transfers = Vec::new(&env);
    transfers.push_back(AssetTransfer {
        token: token.clone(),
        to: recipient.clone(),
        amount: 500_000i128,
    });

    let pid = client
        .propose_transfer(
            &s1,
            &transfers,
            &String::from_str(&env, "pay vendor"),
            &None,
        )
        .unwrap();

    assert_eq!(pid, 0);
    assert_eq!(client.get_proposal_count(), 1);

    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, ProposalStatus::Proposed);
    assert_eq!(p.sig_count, 0);
}

#[test]
fn test_non_signer_cannot_propose() {
    let (env, client) = setup();
    initialize_2_of_3(&env, &client);

    let outsider = Address::generate(&env);
    let token = Address::generate(&env);
    let recipient = Address::generate(&env);
    let mut transfers = Vec::new(&env);
    transfers.push_back(AssetTransfer {
        token,
        to: recipient,
        amount: 100i128,
    });

    let result = client.try_propose_transfer(
        &outsider,
        &transfers,
        &String::from_str(&env, "hack"),
        &None,
    );
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

#[test]
fn test_guardian_pause_halts_operations() {
    let (env, client) = setup();
    let (s1, _s2, _s3, guardian) = initialize_2_of_3(&env, &client);

    client.pause(&guardian).unwrap();
    assert!(client.is_paused());

    // Propose should fail while paused
    let token = Address::generate(&env);
    let recipient = Address::generate(&env);
    let mut transfers = Vec::new(&env);
    transfers.push_back(AssetTransfer {
        token,
        to: recipient,
        amount: 100i128,
    });
    let result = client.try_propose_transfer(
        &s1,
        &transfers,
        &String::from_str(&env, "test"),
        &None,
    );
    assert_eq!(result.unwrap_err().unwrap(), Error::ContractPaused);

    // Unpause
    client.unpause(&guardian).unwrap();
    assert!(!client.is_paused());
}

#[test]
fn test_high_value_transfer_respects_timelock() {
    let (env, client) = setup();
    let (s1, _s2, _s3, _guardian) = initialize_2_of_3(&env, &client);

    let token = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Amount >= high_value_threshold (1_000_000) with a too-short lock override
    let mut transfers = Vec::new(&env);
    transfers.push_back(AssetTransfer {
        token,
        to: recipient,
        amount: 2_000_000i128, // exceeds threshold
    });

    // Override time_lock with something shorter than base (3600s) – must be rejected
    let result = client.try_propose_transfer(
        &s1,
        &transfers,
        &String::from_str(&env, "big transfer"),
        &Some(100u64), // too short
    );
    assert_eq!(result.unwrap_err().unwrap(), Error::HighValueTimeLockRequired);
}

#[test]
fn test_timelock_cannot_be_bypassed() {
    let (env, client) = setup();
    let (s1, s2, _s3, _guardian) = initialize_2_of_3(&env, &client);

    let token = Address::generate(&env);
    let recipient = Address::generate(&env);
    let mut transfers = Vec::new(&env);
    transfers.push_back(AssetTransfer {
        token,
        to: recipient,
        amount: 100i128,
    });

    // Propose (using None = use default timelock 3600s)
    let pid = client
        .propose_transfer(&s1, &transfers, &String::from_str(&env, "x"), &None)
        .unwrap();

    // Sign with s1
    let nonce1 = client.get_signer_nonce(&s1);
    let bundle1 = SignatureBundle {
        signer: s1.clone(),
        signature: make_64_sig(&env, pid),
        nonce: nonce1,
    };
    client.submit_signature(&bundle1).unwrap();

    // Sign with s2 (this should hit threshold and queue)
    let nonce2 = client.get_signer_nonce(&s2);
    let bundle2 = SignatureBundle {
        signer: s2.clone(),
        signature: make_64_sig(&env, pid),
        nonce: nonce2,
    };
    client.submit_signature(&bundle2).unwrap();

    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, ProposalStatus::Queued);

    // Try to execute immediately – should fail because delay hasn't elapsed
    let result = client.try_execute(&s1, &pid);
    assert_eq!(result.unwrap_err().unwrap(), Error::TimeLockActive);
}

#[test]
fn test_execute_after_timelock() {
    let (env, client) = setup();
    let (s1, s2, _s3, _guardian) = initialize_2_of_3(&env, &client);

    let token = Address::generate(&env);
    let recipient = Address::generate(&env);
    let mut transfers = Vec::new(&env);
    transfers.push_back(AssetTransfer {
        token,
        to: recipient,
        amount: 100i128,
    });

    let pid = client
        .propose_transfer(&s1, &transfers, &String::from_str(&env, "ok"), &None)
        .unwrap();

    // Collect 2 signatures
    for (signer, _) in [(s1.clone(), 0u64), (s2.clone(), 0u64)] {
        let nonce = client.get_signer_nonce(&signer);
        client
            .submit_signature(&SignatureBundle {
                signer: signer.clone(),
                signature: make_64_sig(&env, pid),
                nonce,
            })
            .unwrap();
    }

    let p = client.get_proposal(&pid).unwrap();
    let execute_after = p.execute_after;

    // Advance ledger time past the lock
    env.ledger().with_mut(|l| {
        l.timestamp = execute_after + 1;
    });

    // Now execution should succeed
    client.execute(&s1, &pid).unwrap();

    let p2 = client.get_proposal(&pid).unwrap();
    assert_eq!(p2.status, ProposalStatus::Executed);
}

#[test]
fn test_cancel_proposal() {
    let (env, client) = setup();
    let (s1, _s2, _s3, guardian) = initialize_2_of_3(&env, &client);

    let token = Address::generate(&env);
    let mut transfers = Vec::new(&env);
    transfers.push_back(AssetTransfer {
        token,
        to: Address::generate(&env),
        amount: 100i128,
    });

    let pid = client
        .propose_transfer(&s1, &transfers, &String::from_str(&env, "cancel me"), &None)
        .unwrap();

    client.cancel(&guardian, &pid).unwrap();
    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, ProposalStatus::Cancelled);
}

#[test]
fn test_replay_attack_rejected() {
    let (env, client) = setup();
    let (s1, _s2, _s3, _guardian) = initialize_2_of_3(&env, &client);

    let token = Address::generate(&env);
    let mut transfers = Vec::new(&env);
    transfers.push_back(AssetTransfer {
        token,
        to: Address::generate(&env),
        amount: 100i128,
    });

    let pid = client
        .propose_transfer(&s1, &transfers, &String::from_str(&env, "r"), &None)
        .unwrap();

    let nonce = client.get_signer_nonce(&s1);
    let bundle = SignatureBundle {
        signer: s1.clone(),
        signature: make_64_sig(&env, pid),
        nonce,
    };
    client.submit_signature(&bundle).unwrap();

    // Re-use same nonce → should be rejected
    let replay = SignatureBundle {
        signer: s1.clone(),
        signature: make_64_sig(&env, pid),
        nonce, // stale nonce
    };
    let result = client.try_submit_signature(&replay);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidNonce);
}

#[test]
fn test_duplicate_signature_rejected() {
    let (env, client) = setup();
    let (s1, _s2, _s3, _guardian) = initialize_2_of_3(&env, &client);

    let token = Address::generate(&env);
    let mut transfers = Vec::new(&env);
    transfers.push_back(AssetTransfer {
        token,
        to: Address::generate(&env),
        amount: 100i128,
    });

    let pid = client
        .propose_transfer(&s1, &transfers, &String::from_str(&env, "dup"), &None)
        .unwrap();

    let nonce = client.get_signer_nonce(&s1);
    client
        .submit_signature(&SignatureBundle {
            signer: s1.clone(),
            signature: make_64_sig(&env, pid),
            nonce,
        })
        .unwrap();

    // s1 tries to sign again with the new (incremented) nonce but same proposal
    let nonce2 = client.get_signer_nonce(&s1);
    let result = client.try_submit_signature(&SignatureBundle {
        signer: s1.clone(),
        signature: make_64_sig(&env, pid),
        nonce: nonce2,
    });
    assert_eq!(result.unwrap_err().unwrap(), Error::AlreadySigned);
}

#[test]
fn test_propose_upgrade() {
    let (env, client) = setup();
    let (s1, _s2, _s3, _guardian) = initialize_2_of_3(&env, &client);

    let new_wasm = BytesN::<32>::random(&env);
    let pid = client
        .propose_upgrade(&s1, &new_wasm, &String::from_str(&env, "upgrade v2"))
        .unwrap();

    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, ProposalStatus::Proposed);
}

#[test]
fn test_propose_config_update() {
    let (env, client) = setup();
    let (s1, _s2, _s3, _guardian) = initialize_2_of_3(&env, &client);

    let pid = client
        .propose_config(
            &s1,
            &Some(3u32),
            &Some(7200u64),
            &String::from_str(&env, "increase threshold"),
        )
        .unwrap();

    let p = client.get_proposal(&pid).unwrap();
    assert_eq!(p.status, ProposalStatus::Proposed);
}
