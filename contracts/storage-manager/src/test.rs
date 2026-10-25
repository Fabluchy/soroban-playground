#![cfg(test)]

extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

use crate::{
    types::{Error, StorageClass},
    StorageManager, StorageManagerClient,
};

fn setup() -> (Env, StorageManagerClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, StorageManager);
    let client = StorageManagerClient::new(&env, &id);
    (env, client)
}

fn init(env: &Env, client: &StorageManagerClient) -> Address {
    let admin = Address::generate(env);
    client
        .initialize(
            &admin,
            &100i128, // 100 stroops per crank
            &535_680u32,
        )
        .unwrap();
    admin
}

// ── Initialisation ────────────────────────────────────────────────────────────

#[test]
fn test_initialize() {
    let (env, client) = setup();
    let admin = init(&env, &client);
    assert_eq!(client.get_admin().unwrap(), admin);
    assert_eq!(client.get_crank_reward_amount(), 100);
}

#[test]
fn test_double_init_rejected() {
    let (env, client) = setup();
    init(&env, &client);
    let admin2 = Address::generate(&env);
    let result = client.try_initialize(&admin2, &0i128, &0u32);
    assert_eq!(result.unwrap_err().unwrap(), Error::AlreadyInitialized);
}

// ── Key registration ──────────────────────────────────────────────────────────

#[test]
fn test_register_instance_key() {
    let (env, client) = setup();
    let admin = init(&env, &client);

    let id = client
        .register_key(
            &admin,
            &String::from_str(&env, "contract instance"),
            &StorageClass::Instance,
            &17_280u32,
            &34_560u32,
        )
        .unwrap();

    assert_eq!(id, 0);
    assert_eq!(client.get_key_count(), 1);

    let mk = client.get_managed_key(&id).unwrap();
    assert!(mk.active);
    assert_eq!(mk.class, StorageClass::Instance);
    assert_eq!(mk.extension_ledgers, 34_560);
    assert_eq!(mk.renewals, 0);
}

#[test]
fn test_register_persistent_key() {
    let (env, client) = setup();
    let admin = init(&env, &client);

    let id = client
        .register_key(
            &admin,
            &String::from_str(&env, "proposal store"),
            &StorageClass::Persistent,
            &17_280u32,
            &100_000u32,
        )
        .unwrap();

    let mk = client.get_managed_key(&id).unwrap();
    assert_eq!(mk.class, StorageClass::Persistent);
}

#[test]
fn test_register_key_exceeds_max_rejected() {
    let (env, client) = setup();
    let admin = init(&env, &client);

    // max is 535_680 from initialization; try to register with extension > max
    let result = client.try_register_key(
        &admin,
        &String::from_str(&env, "too large"),
        &StorageClass::Persistent,
        &1000u32,
        &600_000u32, // exceeds 535_680
    );
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidExtension);
}

#[test]
fn test_deregister_key() {
    let (env, client) = setup();
    let admin = init(&env, &client);

    let id = client
        .register_key(
            &admin,
            &String::from_str(&env, "temp key"),
            &StorageClass::Persistent,
            &1000u32,
            &5000u32,
        )
        .unwrap();

    client.deregister_key(&admin, &id).unwrap();
    let mk = client.get_managed_key(&id).unwrap();
    assert!(!mk.active);
}

// ── TTL extension ─────────────────────────────────────────────────────────────

#[test]
fn test_extend_instance_ttl_credits_crank() {
    let (env, client) = setup();
    let admin = init(&env, &client);
    let crank = Address::generate(&env);

    let kid = client
        .register_key(
            &admin,
            &String::from_str(&env, "instance key"),
            &StorageClass::Instance,
            &17_280u32,
            &34_560u32,
        )
        .unwrap();

    let evt = client
        .extend_instance_ttl(&crank, &kid, &17_280u32, &34_560u32)
        .unwrap();

    assert_eq!(evt.key_id, kid);
    assert_eq!(evt.extended_by, 34_560);
    assert_eq!(evt.crank, crank);

    // Crank should now have reward balance
    let balance = client.get_crank_balance(&crank);
    assert_eq!(balance, 100); // 100 stroops per extension

    // Renewals counter incremented
    let mk = client.get_managed_key(&kid).unwrap();
    assert_eq!(mk.renewals, 1);
}

#[test]
fn test_extend_persistent_ttl_credits_crank() {
    let (env, client) = setup();
    let admin = init(&env, &client);
    let crank = Address::generate(&env);

    let kid = client
        .register_key(
            &admin,
            &String::from_str(&env, "persistent key"),
            &StorageClass::Persistent,
            &17_280u32,
            &50_000u32,
        )
        .unwrap();

    client
        .extend_persistent_ttl(&crank, &kid, &17_280u32, &50_000u32)
        .unwrap();

    let balance = client.get_crank_balance(&crank);
    assert_eq!(balance, 100);
}

#[test]
fn test_extend_inactive_key_rejected() {
    let (env, client) = setup();
    let admin = init(&env, &client);
    let crank = Address::generate(&env);

    let kid = client
        .register_key(
            &admin,
            &String::from_str(&env, "deregistered"),
            &StorageClass::Instance,
            &1000u32,
            &5000u32,
        )
        .unwrap();

    client.deregister_key(&admin, &kid).unwrap();

    let result = client.try_extend_instance_ttl(&crank, &kid, &1000u32, &5000u32);
    assert_eq!(result.unwrap_err().unwrap(), Error::KeyInactive);
}

// ── Bulk renewal ──────────────────────────────────────────────────────────────

#[test]
fn test_bulk_extend_ttl() {
    let (env, client) = setup();
    let admin = init(&env, &client);
    let crank = Address::generate(&env);

    // Register 3 keys (2 persistent, 1 instance)
    let k1 = client
        .register_key(
            &admin,
            &String::from_str(&env, "k1"),
            &StorageClass::Instance,
            &1000u32,
            &5000u32,
        )
        .unwrap();
    let k2 = client
        .register_key(
            &admin,
            &String::from_str(&env, "k2"),
            &StorageClass::Persistent,
            &1000u32,
            &5000u32,
        )
        .unwrap();
    let k3 = client
        .register_key(
            &admin,
            &String::from_str(&env, "k3"),
            &StorageClass::Persistent,
            &1000u32,
            &5000u32,
        )
        .unwrap();

    let mut ids = Vec::new(&env);
    ids.push_back(k1);
    ids.push_back(k2);
    ids.push_back(k3);

    let count = client.bulk_extend_ttl(&crank, &ids, &1000u32, &5000u32).unwrap();
    // k1 (instance) + k2 + k3 (persistent) = 3 extended (temporary class is skipped)
    assert_eq!(count, 3);

    // 3 extensions × 100 stroops = 300
    let balance = client.get_crank_balance(&crank);
    assert_eq!(balance, 300);
}

#[test]
fn test_bulk_extend_skips_inactive_keys() {
    let (env, client) = setup();
    let admin = init(&env, &client);
    let crank = Address::generate(&env);

    let k1 = client
        .register_key(
            &admin,
            &String::from_str(&env, "active"),
            &StorageClass::Persistent,
            &1000u32,
            &5000u32,
        )
        .unwrap();
    let k2 = client
        .register_key(
            &admin,
            &String::from_str(&env, "inactive"),
            &StorageClass::Persistent,
            &1000u32,
            &5000u32,
        )
        .unwrap();

    client.deregister_key(&admin, &k2).unwrap();

    let mut ids = Vec::new(&env);
    ids.push_back(k1);
    ids.push_back(k2);

    let count = client.bulk_extend_ttl(&crank, &ids, &1000u32, &5000u32).unwrap();
    assert_eq!(count, 1); // Only k1 extended
}

// ── Temporary storage (nonces) ────────────────────────────────────────────────

#[test]
fn test_set_and_get_nonce() {
    let (env, client) = setup();
    init(&env, &client);

    let user = Address::generate(&env);
    client.set_nonce(&user, &42u64, &Some(720u32)).unwrap();
    let nonce = client.get_nonce(&user);
    assert_eq!(nonce, 42);
}

#[test]
fn test_nonce_default_zero() {
    let (env, client) = setup();
    init(&env, &client);

    let user = Address::generate(&env);
    // Never set
    let nonce = client.get_nonce(&user);
    assert_eq!(nonce, 0);
}

// ── Flash-loan locks ──────────────────────────────────────────────────────────

#[test]
fn test_flash_lock_acquire_and_release() {
    let (env, client) = setup();
    init(&env, &client);

    let user = Address::generate(&env);
    assert!(!client.is_flash_locked(&user));

    client.acquire_flash_lock(&user).unwrap();
    assert!(client.is_flash_locked(&user));

    client.release_flash_lock(&user).unwrap();
    assert!(!client.is_flash_locked(&user));
}

#[test]
fn test_flash_lock_double_acquire_rejected() {
    let (env, client) = setup();
    init(&env, &client);

    let user = Address::generate(&env);
    client.acquire_flash_lock(&user).unwrap();

    let result = client.try_acquire_flash_lock(&user);
    assert_eq!(result.unwrap_err().unwrap(), Error::FlashLockActive);
}

#[test]
fn test_flash_lock_release_without_acquire_rejected() {
    let (env, client) = setup();
    init(&env, &client);

    let user = Address::generate(&env);
    let result = client.try_release_flash_lock(&user);
    assert_eq!(result.unwrap_err().unwrap(), Error::FlashLockNotActive);
}

// ── Crank rewards ─────────────────────────────────────────────────────────────

#[test]
fn test_claim_reward() {
    let (env, client) = setup();
    let admin = init(&env, &client);
    let crank = Address::generate(&env);

    let kid = client
        .register_key(
            &admin,
            &String::from_str(&env, "r"),
            &StorageClass::Instance,
            &100u32,
            &1000u32,
        )
        .unwrap();

    client.extend_instance_ttl(&crank, &kid, &100u32, &1000u32).unwrap();

    let balance = client.get_crank_balance(&crank);
    assert_eq!(balance, 100);

    let claimed = client.claim_reward(&crank).unwrap();
    assert_eq!(claimed, 100);
    assert_eq!(client.get_crank_balance(&crank), 0);
}

#[test]
fn test_claim_empty_reward_returns_zero() {
    let (env, client) = setup();
    init(&env, &client);

    let crank = Address::generate(&env);
    let claimed = client.claim_reward(&crank).unwrap();
    assert_eq!(claimed, 0);
}

#[test]
fn test_update_crank_reward() {
    let (env, client) = setup();
    let admin = init(&env, &client);

    client.set_crank_reward(&admin, &500i128).unwrap();
    assert_eq!(client.get_crank_reward_amount(), 500);
}

// ── Rent calculation tests ────────────────────────────────────────────────────

#[test]
fn test_multiple_renewals_accumulate_correctly() {
    let (env, client) = setup();
    let admin = init(&env, &client);
    let crank = Address::generate(&env);

    let kid = client
        .register_key(
            &admin,
            &String::from_str(&env, "multi"),
            &StorageClass::Instance,
            &100u32,
            &1000u32,
        )
        .unwrap();

    // Extend 5 times
    for _ in 0..5u32 {
        client.extend_instance_ttl(&crank, &kid, &100u32, &1000u32).unwrap();
    }

    let mk = client.get_managed_key(&kid).unwrap();
    assert_eq!(mk.renewals, 5);

    // 5 × 100 = 500 stroops
    assert_eq!(client.get_crank_balance(&crank), 500);
}

#[test]
fn test_extension_exceeding_max_rejected() {
    let (env, client) = setup();
    let admin = init(&env, &client);
    let crank = Address::generate(&env);

    let kid = client
        .register_key(
            &admin,
            &String::from_str(&env, "over"),
            &StorageClass::Instance,
            &100u32,
            &1000u32,
        )
        .unwrap();

    // Try extension beyond max (535_680)
    let result =
        client.try_extend_instance_ttl(&crank, &kid, &100u32, &600_000u32);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidExtension);
}
