#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Vec};

use crate::{
    types::{Error, TeleportRequest},
    TeleportBridgeContract, TeleportBridgeContractClient,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Deploy the contract and return `(env, client, admin, validators)`.
fn setup(
    threshold: u32,
    daily_limit: i128,
    num_validators: u32,
) -> (
    Env,
    TeleportBridgeContractClient<'static>,
    Address,
    Vec<Address>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(TeleportBridgeContract, ());
    let client = TeleportBridgeContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let mut validators = Vec::new(&env);
    for _ in 0..num_validators {
        validators.push_back(Address::generate(&env));
    }

    client
        .initialize(&admin, &threshold, &daily_limit, &validators)
        .unwrap();
    (env, client, admin, validators)
}

/// Build a Merkle root for a single-element tree where the leaf = sha256(leaf_bytes).
/// Returns `(root, proof, leaf_index)` where proof is empty and index = 0.
fn single_leaf_root(env: &Env, leaf: &BytesN<32>) -> (BytesN<32>, Vec<BytesN<32>>, u32) {
    let leaf_bytes = Bytes::from_slice(env, &leaf.to_array());
    let hash = env.crypto().sha256(&leaf_bytes);
    (hash, Vec::new(env), 0)
}

/// Build a 2-leaf Merkle tree:
///   root = sha256( sha256(leaf0) ++ sha256(leaf1) )
/// Returns `(root, proof_for_leaf0, proof_for_leaf1)`.
fn two_leaf_tree(
    env: &Env,
    leaf0: &BytesN<32>,
    leaf1: &BytesN<32>,
) -> (BytesN<32>, Vec<BytesN<32>>, Vec<BytesN<32>>) {
    let h0 = env
        .crypto()
        .sha256(&Bytes::from_slice(env, &leaf0.to_array()));
    let h1 = env
        .crypto()
        .sha256(&Bytes::from_slice(env, &leaf1.to_array()));

    let mut combined = Bytes::new(env);
    combined.extend_from_slice(&h0.to_array());
    combined.extend_from_slice(&h1.to_array());
    let root = env.crypto().sha256(&combined);

    // proof for leaf0 (index=0): sibling is h1
    let mut proof0 = Vec::new(env);
    proof0.push_back(h1.clone());

    // proof for leaf1 (index=1): sibling is h0
    let mut proof1 = Vec::new(env);
    proof1.push_back(h0.clone());

    (root, proof0, proof1)
}

/// Convenience: build a 32-byte value from a u32 (right-padded with zeros).
fn tx_id_from_u32(env: &Env, n: u32) -> BytesN<32> {
    let mut arr = [0u8; 32];
    arr[0] = ((n >> 24) & 0xff) as u8;
    arr[1] = ((n >> 16) & 0xff) as u8;
    arr[2] = ((n >> 8) & 0xff) as u8;
    arr[3] = (n & 0xff) as u8;
    BytesN::from_array(env, &arr)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. initialize ────────────────────────────────────────────────────────────────

#[test]
fn test_initialize_stores_config() {
    let (env, client, admin, validators) = setup(2, 1_000_000, 3);
    let cfg = client.get_config().unwrap();
    assert_eq!(cfg.threshold, 2);
    assert_eq!(cfg.daily_limit, 1_000_000);
    assert!(!cfg.paused);
    assert_eq!(cfg.admin, admin);
    let _ = validators; // suppress unused warning
}

#[test]
fn test_initialize_twice_fails() {
    let (env, client, admin, validators) = setup(1, 1_000, 1);
    // second call must fail
    let result = client.try_initialize(&admin, &1u32, &1_000i128, &validators);
    assert!(result.is_err());
}

#[test]
fn test_initialize_bad_threshold_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TeleportBridgeContract, ());
    let client = TeleportBridgeContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let mut validators = Vec::new(&env);
    validators.push_back(Address::generate(&env));
    // threshold 0 is invalid
    let r = client.try_initialize(&admin, &0u32, &1_000i128, &validators);
    assert!(matches!(r, Err(Ok(Error::InvalidAmount))));
    // threshold > count is invalid
    let r2 = client.try_initialize(&admin, &5u32, &1_000i128, &validators);
    assert!(matches!(r2, Err(Ok(Error::InvalidAmount))));
}

// 2. attest / threshold ────────────────────────────────────────────────────────

#[test]
fn test_teleport_fails_below_threshold() {
    // threshold=2, only 1 attestation → InsufficientAttestations
    let (env, client, _admin, validators) = setup(2, 1_000_000, 3);
    let tx_id = tx_id_from_u32(&env, 1);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    let (root, proof, idx) = single_leaf_root(&env, &tx_id);

    // Only ONE validator attests.
    client.attest(&validators.get(0).unwrap(), &tx_id).unwrap();

    let request = TeleportRequest {
        tx_id: tx_id.clone(),
        source_chain_id: 1,
        merkle_root: root,
        recipient,
        amount: 100,
        token,
        merkle_proof: proof,
        leaf_index: idx,
        attestations: Vec::new(&env),
    };
    let result = client.try_teleport(&request);
    assert!(matches!(result, Err(Ok(Error::InsufficientAttestations))));
}

#[test]
fn test_teleport_succeeds_at_threshold() {
    // threshold=2, exactly 2 attestations → Ok
    let (env, client, _admin, validators) = setup(2, 1_000_000, 3);
    let tx_id = tx_id_from_u32(&env, 42);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    let (root, proof, idx) = single_leaf_root(&env, &tx_id);

    client.attest(&validators.get(0).unwrap(), &tx_id).unwrap();
    client.attest(&validators.get(1).unwrap(), &tx_id).unwrap();

    let request = TeleportRequest {
        tx_id,
        source_chain_id: 1,
        merkle_root: root,
        recipient,
        amount: 500,
        token,
        merkle_proof: proof,
        leaf_index: idx,
        attestations: Vec::new(&env),
    };
    let ok = client.teleport(&request).unwrap();
    assert!(ok);
}

#[test]
fn test_double_attest_fails() {
    let (env, client, _admin, validators) = setup(1, 1_000_000, 2);
    let tx_id = tx_id_from_u32(&env, 99);
    let v0 = validators.get(0).unwrap();

    client.attest(&v0, &tx_id).unwrap();
    let r = client.try_attest(&v0, &tx_id);
    assert!(matches!(r, Err(Ok(Error::AlreadyAttested))));
}

#[test]
fn test_non_validator_attest_fails() {
    let (env, client, _admin, _validators) = setup(1, 1_000_000, 2);
    let imposter = Address::generate(&env);
    let tx_id = tx_id_from_u32(&env, 7);
    let r = client.try_attest(&imposter, &tx_id);
    assert!(matches!(r, Err(Ok(Error::Unauthorized))));
}

// 3. Nullifier replay prevention ───────────────────────────────────────────────

#[test]
fn test_nullifier_replay_prevention() {
    let (env, client, _admin, validators) = setup(1, 10_000_000, 2);
    let tx_id = tx_id_from_u32(&env, 55);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    let (root, proof, idx) = single_leaf_root(&env, &tx_id);

    // Attest and teleport successfully.
    client.attest(&validators.get(0).unwrap(), &tx_id).unwrap();
    let req = TeleportRequest {
        tx_id: tx_id.clone(),
        source_chain_id: 1,
        merkle_root: root.clone(),
        recipient: recipient.clone(),
        amount: 100,
        token: token.clone(),
        merkle_proof: proof.clone(),
        leaf_index: idx,
        attestations: Vec::new(&env),
    };
    client.teleport(&req).unwrap();
    assert!(client.is_nullifier_used(&tx_id));

    // Second teleport with same tx_id → NullifierAlreadyUsed.
    let req2 = TeleportRequest {
        tx_id: tx_id.clone(),
        source_chain_id: 1,
        merkle_root: root,
        recipient,
        amount: 100,
        token,
        merkle_proof: proof,
        leaf_index: idx,
        attestations: Vec::new(&env),
    };
    let r = client.try_teleport(&req2);
    assert!(matches!(r, Err(Ok(Error::NullifierAlreadyUsed))));
}

// 4. Daily limit enforcement ───────────────────────────────────────────────────

#[test]
fn test_daily_limit_enforced() {
    // daily_limit = 1000; first transfer of 900 succeeds, second of 200 fails.
    let (env, client, _admin, validators) = setup(1, 1_000, 2);

    let tx_id_a = tx_id_from_u32(&env, 10);
    let tx_id_b = tx_id_from_u32(&env, 20);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    let (root_a, proof_a, idx_a) = single_leaf_root(&env, &tx_id_a);
    let (root_b, proof_b, idx_b) = single_leaf_root(&env, &tx_id_b);

    let v0 = validators.get(0).unwrap();
    client.attest(&v0, &tx_id_a).unwrap();
    client.attest(&v0, &tx_id_b).unwrap();

    // First transfer: 900 (within limit).
    client
        .teleport(&TeleportRequest {
            tx_id: tx_id_a,
            source_chain_id: 1,
            merkle_root: root_a,
            recipient: recipient.clone(),
            amount: 900,
            token: token.clone(),
            merkle_proof: proof_a,
            leaf_index: idx_a,
            attestations: Vec::new(&env),
        })
        .unwrap();
    assert_eq!(client.get_daily_volume(), 900);

    // Second transfer: 200 → cumulative 1100 > 1000 → fail.
    let r = client.try_teleport(&TeleportRequest {
        tx_id: tx_id_b,
        source_chain_id: 1,
        merkle_root: root_b,
        recipient,
        amount: 200,
        token,
        merkle_proof: proof_b,
        leaf_index: idx_b,
        attestations: Vec::new(&env),
    });
    assert!(matches!(r, Err(Ok(Error::DailyLimitExceeded))));
}

// 5. Merkle proof verification ─────────────────────────────────────────────────

#[test]
fn test_verify_merkle_proof_single_leaf() {
    let env = Env::default();
    let contract_id = env.register(TeleportBridgeContract, ());
    let client = TeleportBridgeContractClient::new(&env, &contract_id);

    let leaf = tx_id_from_u32(&env, 1);
    let (root, proof, idx) = single_leaf_root(&env, &leaf);

    assert!(client.verify_merkle_proof(&leaf, &proof, &idx, &root));
}

#[test]
fn test_verify_merkle_proof_two_leaf_tree() {
    let env = Env::default();
    let contract_id = env.register(TeleportBridgeContract, ());
    let client = TeleportBridgeContractClient::new(&env, &contract_id);

    let leaf0 = tx_id_from_u32(&env, 0xAA);
    let leaf1 = tx_id_from_u32(&env, 0xBB);
    let (root, proof0, proof1) = two_leaf_tree(&env, &leaf0, &leaf1);

    // Proof for leaf0 (index = 0)
    assert!(client.verify_merkle_proof(&leaf0, &proof0, &0u32, &root));
    // Proof for leaf1 (index = 1)
    assert!(client.verify_merkle_proof(&leaf1, &proof1, &1u32, &root));

    // Wrong sibling should fail
    let bad_proof = proof0.clone(); // proof0's sibling = h1, but for leaf1 we need h0
    assert!(!client.verify_merkle_proof(&leaf1, &bad_proof, &1u32, &root));
}

#[test]
fn test_verify_merkle_proof_wrong_root_fails() {
    let env = Env::default();
    let contract_id = env.register(TeleportBridgeContract, ());
    let client = TeleportBridgeContractClient::new(&env, &contract_id);

    let leaf = tx_id_from_u32(&env, 99);
    let (_, proof, idx) = single_leaf_root(&env, &leaf);
    // supply an incorrect root
    let wrong_root = tx_id_from_u32(&env, 0xDEAD);
    assert!(!client.verify_merkle_proof(&leaf, &proof, &idx, &wrong_root));
}

// 6. Pause prevents teleport ───────────────────────────────────────────────────

#[test]
fn test_pause_prevents_teleport() {
    let (env, client, admin, validators) = setup(1, 1_000_000, 2);
    let tx_id = tx_id_from_u32(&env, 77);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    let (root, proof, idx) = single_leaf_root(&env, &tx_id);
    client.attest(&validators.get(0).unwrap(), &tx_id).unwrap();

    // Pause.
    client.pause(&admin).unwrap();
    assert!(client.get_config().unwrap().paused);

    let r = client.try_teleport(&TeleportRequest {
        tx_id: tx_id.clone(),
        source_chain_id: 1,
        merkle_root: root.clone(),
        recipient: recipient.clone(),
        amount: 100,
        token: token.clone(),
        merkle_proof: proof.clone(),
        leaf_index: idx,
        attestations: Vec::new(&env),
    });
    assert!(matches!(r, Err(Ok(Error::Paused))));

    // Unpause and retry → should succeed.
    client.unpause(&admin).unwrap();
    assert!(!client.get_config().unwrap().paused);

    let ok = client
        .teleport(&TeleportRequest {
            tx_id,
            source_chain_id: 1,
            merkle_root: root,
            recipient,
            amount: 100,
            token,
            merkle_proof: proof,
            leaf_index: idx,
            attestations: Vec::new(&env),
        })
        .unwrap();
    assert!(ok);
}

#[test]
fn test_pause_by_non_admin_fails() {
    let (env, client, _admin, _validators) = setup(1, 1_000_000, 1);
    let non_admin = Address::generate(&env);
    let r = client.try_pause(&non_admin);
    assert!(matches!(r, Err(Ok(Error::Unauthorized))));
}

// 7. End-to-end valid teleport flow ────────────────────────────────────────────

#[test]
fn test_valid_teleport_end_to_end() {
    // threshold=3, 5 validators, 3 attest → success, volume updated, nullifier set
    let (env, client, admin, validators) = setup(3, 100_000, 5);

    let tx_id = tx_id_from_u32(&env, 0x1234_5678);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    let (root, proof, idx) = single_leaf_root(&env, &tx_id);

    // 3 validators attest
    for i in 0..3 {
        client
            .attest(&validators.get(i).unwrap(), &tx_id)
            .unwrap();
    }

    assert!(!client.is_nullifier_used(&tx_id));
    assert_eq!(client.get_daily_volume(), 0);

    let ok = client
        .teleport(&TeleportRequest {
            tx_id: tx_id.clone(),
            source_chain_id: 137, // e.g. Polygon chain id
            merkle_root: root,
            recipient: recipient.clone(),
            amount: 5_000,
            token: token.clone(),
            merkle_proof: proof,
            leaf_index: idx,
            attestations: Vec::new(&env),
        })
        .unwrap();

    assert!(ok);
    assert!(client.is_nullifier_used(&tx_id));
    assert_eq!(client.get_daily_volume(), 5_000);
}

// 8. add_validator / remove_validator ──────────────────────────────────────────

#[test]
fn test_add_and_remove_validator() {
    let (env, client, admin, _validators) = setup(1, 1_000_000, 1);
    let new_val = Address::generate(&env);

    client.add_validator(&admin, &new_val).unwrap();

    // New validator can attest
    let tx_id = tx_id_from_u32(&env, 3);
    client.attest(&new_val, &tx_id).unwrap();

    // Remove new validator
    client.remove_validator(&admin, &new_val).unwrap();

    // After removal, they can no longer attest
    let tx_id2 = tx_id_from_u32(&env, 4);
    let r = client.try_attest(&new_val, &tx_id2);
    assert!(matches!(r, Err(Ok(Error::Unauthorized))));
}

#[test]
fn test_remove_nonexistent_validator_fails() {
    let (env, client, admin, _validators) = setup(1, 1_000_000, 1);
    let ghost = Address::generate(&env);
    let r = client.try_remove_validator(&admin, &ghost);
    assert!(matches!(r, Err(Ok(Error::ValidatorNotFound))));
}

// 9. set_minted_token ──────────────────────────────────────────────────────────

#[test]
fn test_set_minted_token() {
    let (env, client, admin, _validators) = setup(1, 1_000_000, 1);
    let token = Address::generate(&env);
    // Should not panic
    client.set_minted_token(&admin, &token).unwrap();
}

// 10. Merkle proof in teleport path ────────────────────────────────────────────

#[test]
fn test_bad_merkle_proof_rejected_in_teleport() {
    let (env, client, _admin, validators) = setup(1, 1_000_000, 2);
    let tx_id = tx_id_from_u32(&env, 0xFF);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    // Build correct root but supply wrong leaf
    let (root, proof, idx) = single_leaf_root(&env, &tx_id);
    let wrong_tx_id = tx_id_from_u32(&env, 0x00); // different leaf

    client.attest(&validators.get(0).unwrap(), &wrong_tx_id).unwrap();

    let r = client.try_teleport(&TeleportRequest {
        tx_id: wrong_tx_id.clone(),
        source_chain_id: 1,
        merkle_root: root, // root was computed for tx_id, not wrong_tx_id
        recipient,
        amount: 100,
        token,
        merkle_proof: proof,
        leaf_index: idx,
        attestations: Vec::new(&env),
    });
    assert!(matches!(r, Err(Ok(Error::InvalidMerkleProof))));
}
