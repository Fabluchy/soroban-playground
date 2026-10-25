#![cfg(test)]

extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{
    types::{Error, TrancheClass},
    RwaTranche, RwaTrancheClient,
};

fn setup() -> (Env, RwaTrancheClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, RwaTranche);
    let client = RwaTrancheClient::new(&env, &id);
    (env, client)
}

fn init(env: &Env, client: &RwaTrancheClient) -> (Address, Address) {
    let admin = Address::generate(env);
    let auditor = Address::generate(env);
    client
        .initialize(
            &admin,
            &auditor,
            &800u32,  // 8% senior yield
            &2000u32, // 20% junior sub ratio
        )
        .unwrap();
    (admin, auditor)
}

// ── Initialization ────────────────────────────────────────────────────────────

#[test]
fn test_initialize_ok() {
    let (env, client) = setup();
    let (admin, _auditor) = init(&env, &client);
    let pool = client.get_pool().unwrap();
    assert_eq!(pool.admin, admin);
    assert_eq!(pool.senior_yield_bps, 800);
    assert_eq!(pool.junior_sub_ratio_bps, 2000);
    assert_eq!(pool.nav_per_share, 1_000_000);
    assert!(!pool.paused);
}

#[test]
fn test_double_init_rejected() {
    let (env, client) = setup();
    init(&env, &client);
    let admin2 = Address::generate(&env);
    let aud2 = Address::generate(&env);
    let result = client.try_initialize(&admin2, &aud2, &500, &1000);
    assert_eq!(result.unwrap_err().unwrap(), Error::AlreadyInitialized);
}

// ── Whitelist ─────────────────────────────────────────────────────────────────

#[test]
fn test_whitelist_gates_deposit() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);
    let investor = Address::generate(&env);

    // Not whitelisted yet
    let result = client.try_deposit(&investor, &TrancheClass::Senior, &1000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::NotWhitelisted);

    // Whitelist and retry
    client.set_whitelist(&admin, &investor, &true).unwrap();
    let shares = client.deposit(&investor, &TrancheClass::Senior, &1000i128).unwrap();
    assert!(shares > 0);
}

#[test]
fn test_non_whitelisted_transfer_rejected() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);

    let investor = Address::generate(&env);
    let outsider = Address::generate(&env);

    client.set_whitelist(&admin, &investor, &true).unwrap();
    client.deposit(&investor, &TrancheClass::Senior, &1000i128).unwrap();

    // outsider is not whitelisted
    let result = client.try_transfer_shares(
        &investor,
        &outsider,
        &TrancheClass::Senior,
        &100i128,
    );
    assert_eq!(result.unwrap_err().unwrap(), Error::TransferNotAllowed);
}

// ── Deposits ──────────────────────────────────────────────────────────────────

#[test]
fn test_deposit_mints_shares_at_par() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);
    let investor = Address::generate(&env);
    client.set_whitelist(&admin, &investor, &true).unwrap();

    // At par (nav = 1_000_000), 1000 units → 1000 shares
    let shares = client
        .deposit(&investor, &TrancheClass::Senior, &1_000_000i128)
        .unwrap();
    assert_eq!(shares, 1_000_000); // 1:1 at par

    let pool = client.get_pool().unwrap();
    assert_eq!(pool.senior_principal, 1_000_000);
}

#[test]
fn test_dual_tranche_deposit() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);

    let senior_investor = Address::generate(&env);
    let junior_investor = Address::generate(&env);
    client
        .set_whitelist(&admin, &senior_investor, &true)
        .unwrap();
    client
        .set_whitelist(&admin, &junior_investor, &true)
        .unwrap();

    client
        .deposit(&senior_investor, &TrancheClass::Senior, &8_000_000i128)
        .unwrap();
    client
        .deposit(&junior_investor, &TrancheClass::Junior, &2_000_000i128)
        .unwrap();

    let pool = client.get_pool().unwrap();
    assert_eq!(pool.senior_principal, 8_000_000);
    assert_eq!(pool.junior_principal, 2_000_000);
}

// ── Waterfall distribution ────────────────────────────────────────────────────

#[test]
fn test_waterfall_full_repayment() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);

    let senior_inv = Address::generate(&env);
    let junior_inv = Address::generate(&env);
    client.set_whitelist(&admin, &senior_inv, &true).unwrap();
    client.set_whitelist(&admin, &junior_inv, &true).unwrap();

    client
        .deposit(&senior_inv, &TrancheClass::Senior, &8_000_000i128)
        .unwrap();
    client
        .deposit(&junior_inv, &TrancheClass::Junior, &2_000_000i128)
        .unwrap();

    // Repayment = 10_800_000 (10M principal + 800k interest)
    client
        .distribute_repayment(&admin, &10_800_000i128, &800_000i128)
        .unwrap();

    let pool = client.get_pool().unwrap();
    // Senior should have received interest first, then principal
    assert!(pool.senior_interest_paid > 0);
    assert!(pool.senior_principal_paid > 0);
}

#[test]
fn test_waterfall_partial_repayment_fills_senior_first() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);

    let senior_inv = Address::generate(&env);
    let junior_inv = Address::generate(&env);
    client.set_whitelist(&admin, &senior_inv, &true).unwrap();
    client.set_whitelist(&admin, &junior_inv, &true).unwrap();

    client
        .deposit(&senior_inv, &TrancheClass::Senior, &8_000_000i128)
        .unwrap();
    client
        .deposit(&junior_inv, &TrancheClass::Junior, &2_000_000i128)
        .unwrap();

    // Only pay interest (not principal) – junior gets nothing
    client
        .distribute_repayment(&admin, &640_000i128, &640_000i128)
        .unwrap();

    let pool = client.get_pool().unwrap();
    assert!(pool.senior_interest_paid > 0);
    // No junior surplus if there wasn't enough for principal too
    assert_eq!(pool.junior_surplus_paid, 0);
}

// ── Default scenarios ─────────────────────────────────────────────────────────

#[test]
fn test_junior_absorbs_default() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);

    let senior_inv = Address::generate(&env);
    let junior_inv = Address::generate(&env);
    client.set_whitelist(&admin, &senior_inv, &true).unwrap();
    client.set_whitelist(&admin, &junior_inv, &true).unwrap();

    client
        .deposit(&senior_inv, &TrancheClass::Senior, &8_000_000i128)
        .unwrap();
    client
        .deposit(&junior_inv, &TrancheClass::Junior, &2_000_000i128)
        .unwrap();

    // Record a loss of 1_000_000 – well within 20% junior buffer (2_000_000)
    client.record_default(&admin, &1_000_000i128).unwrap();

    let pool = client.get_pool().unwrap();
    assert_eq!(pool.junior_write_down, 1_000_000);
    // NAV should be lower
    assert!(pool.nav_per_share < 1_000_000);
}

#[test]
fn test_default_exceeding_junior_buffer() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);

    let senior_inv = Address::generate(&env);
    let junior_inv = Address::generate(&env);
    client.set_whitelist(&admin, &senior_inv, &true).unwrap();
    client.set_whitelist(&admin, &junior_inv, &true).unwrap();

    client
        .deposit(&senior_inv, &TrancheClass::Senior, &8_000_000i128)
        .unwrap();
    client
        .deposit(&junior_inv, &TrancheClass::Junior, &2_000_000i128)
        .unwrap();

    // junior_sub_ratio = 20% × 10M = 2M max buffer
    // Loss of 3M exceeds buffer
    client.record_default(&admin, &3_000_000i128).unwrap();

    let pool = client.get_pool().unwrap();
    // Write-down capped at junior buffer
    assert_eq!(pool.junior_write_down, 2_000_000);
}

// ── NAV oracle ────────────────────────────────────────────────────────────────

#[test]
fn test_nav_update_by_auditor() {
    let (env, client) = setup();
    let (_admin, auditor) = init(&env, &client);

    // Update NAV to reflect appreciation
    client.update_nav(&auditor, &1_050_000i128).unwrap();

    let nav = client.get_nav_per_share().unwrap();
    assert_eq!(nav, 1_050_000);
}

#[test]
fn test_nav_update_by_non_auditor_rejected() {
    let (env, client) = setup();
    init(&env, &client);

    let fake = Address::generate(&env);
    let result = client.try_update_nav(&fake, &1_050_000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::UnauthorizedAuditor);
}

// ── Withdrawal ────────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_at_par() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);

    let investor = Address::generate(&env);
    client.set_whitelist(&admin, &investor, &true).unwrap();

    let shares = client
        .deposit(&investor, &TrancheClass::Senior, &1_000_000i128)
        .unwrap();

    let assets = client
        .withdraw(&investor, &TrancheClass::Senior, &shares)
        .unwrap();
    // At par, should get 1:1
    assert_eq!(assets, 1_000_000);
}

#[test]
fn test_withdraw_junior_with_write_down() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);

    let senior_inv = Address::generate(&env);
    let junior_inv = Address::generate(&env);
    client.set_whitelist(&admin, &senior_inv, &true).unwrap();
    client.set_whitelist(&admin, &junior_inv, &true).unwrap();

    client
        .deposit(&senior_inv, &TrancheClass::Senior, &8_000_000i128)
        .unwrap();
    let junior_shares = client
        .deposit(&junior_inv, &TrancheClass::Junior, &2_000_000i128)
        .unwrap();

    // 50% write-down on junior
    client.record_default(&admin, &1_000_000i128).unwrap();

    let assets = client
        .withdraw(&junior_inv, &TrancheClass::Junior, &junior_shares)
        .unwrap();
    // Should receive less than original deposit due to haircut
    assert!(assets < 2_000_000);
}

// ── Pause ─────────────────────────────────────────────────────────────────────

#[test]
fn test_pause_blocks_deposits() {
    let (env, client) = setup();
    let (admin, _) = init(&env, &client);
    let investor = Address::generate(&env);
    client.set_whitelist(&admin, &investor, &true).unwrap();

    client.pause(&admin).unwrap();
    let result = client.try_deposit(&investor, &TrancheClass::Senior, &100i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::PoolPaused);

    client.unpause(&admin).unwrap();
    let shares = client
        .deposit(&investor, &TrancheClass::Senior, &100i128)
        .unwrap();
    assert!(shares > 0);
}

// ── Per-share NAV accuracy ────────────────────────────────────────────────────

#[test]
fn test_shares_to_assets_conversion() {
    let (env, client) = setup();
    init(&env, &client);
    // At par: 1000 shares → 1000 assets
    let assets = client.shares_to_assets(&1_000_000i128).unwrap();
    assert_eq!(assets, 1_000_000);
}
