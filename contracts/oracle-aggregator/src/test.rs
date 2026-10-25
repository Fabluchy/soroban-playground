#![cfg(test)]

extern crate std;

use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env, String};

use crate::{types::Error, OracleAggregator, OracleAggregatorClient};

fn setup() -> (Env, OracleAggregatorClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, OracleAggregator);
    let client = OracleAggregatorClient::new(&env, &id);
    (env, client)
}

fn asset(env: &Env, sym: &str) -> String {
    String::from_str(env, sym)
}

fn init_default(env: &Env, client: &OracleAggregatorClient) -> Address {
    let admin = Address::generate(env);
    client
        .initialize(
            &admin,
            &Some(3600u64), // max_price_age
            &Some(2000u32), // outlier_bps  = 20%
            &Some(2000u32), // cb_bps        = 20%
            &Some(3600u64), // twap_window
        )
        .unwrap();
    admin
}

// ── Init ──────────────────────────────────────────────────────────────────────

#[test]
fn test_initialize() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);
    assert_eq!(client.get_admin().unwrap(), admin);
    assert_eq!(client.get_max_price_age(), 3600);
    assert_eq!(client.get_outlier_bps(), 2000);
}

#[test]
fn test_double_init_rejected() {
    let (env, client) = setup();
    init_default(&env, &client);
    let admin2 = Address::generate(&env);
    let result = client.try_initialize(&admin2, &None, &None, &None, &None);
    assert_eq!(result.unwrap_err().unwrap(), Error::AlreadyInitialized);
}

// ── Node management ───────────────────────────────────────────────────────────

#[test]
fn test_add_node() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);
    let reporter = Address::generate(&env);
    let id = client
        .add_node(&admin, &reporter, &asset(&env, "chainlink"))
        .unwrap();
    assert_eq!(id, 0);
    assert_eq!(client.get_node_count(), 1);

    let node = client.get_node(&id).unwrap();
    assert!(node.active);
    assert_eq!(node.address, reporter);
}

#[test]
fn test_duplicate_node_rejected() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);
    let reporter = Address::generate(&env);
    client.add_node(&admin, &reporter, &asset(&env, "n1")).unwrap();
    let result = client.try_add_node(&admin, &reporter, &asset(&env, "n1dup"));
    assert_eq!(result.unwrap_err().unwrap(), Error::NodeExists);
}

#[test]
fn test_deactivate_node() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);
    let reporter = Address::generate(&env);
    let id = client
        .add_node(&admin, &reporter, &asset(&env, "n"))
        .unwrap();
    client.deactivate_node(&admin, &id).unwrap();
    let node = client.get_node(&id).unwrap();
    assert!(!node.active);
}

// ── Price submission ──────────────────────────────────────────────────────────

#[test]
fn test_submit_price_single_node() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);
    let reporter = Address::generate(&env);
    client.add_node(&admin, &reporter, &asset(&env, "btc")).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.submit_price(&reporter, &asset(&env, "BTC/USD"), &50_000i128).unwrap();

    let agg = client.get_aggregated_price(&asset(&env, "BTC/USD")).unwrap();
    assert_eq!(agg.median, 50_000);
}

#[test]
fn test_stale_price_excluded() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    client.add_node(&admin, &r1, &asset(&env, "n1")).unwrap();
    client.add_node(&admin, &r2, &asset(&env, "n2")).unwrap();

    // r1 submits at t=100
    env.ledger().with_mut(|l| l.timestamp = 100);
    client.submit_price(&r1, &asset(&env, "ETH/USD"), &3000i128).unwrap();

    // r2 submits at t=5000 (r1 is now stale: age = 4900 > max_age 3600)
    env.ledger().with_mut(|l| l.timestamp = 5000);
    client.submit_price(&r2, &asset(&env, "ETH/USD"), &3100i128).unwrap();

    let agg = client.get_aggregated_price(&asset(&env, "ETH/USD")).unwrap();
    // Only r2 contributes
    assert_eq!(agg.contributing_nodes, 1);
    assert_eq!(agg.median, 3100);
}

#[test]
fn test_outlier_trimmed_from_median() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);

    // 5 nodes: 4 agree ~100, one rogue at 500
    let mut reporters = soroban_sdk::Vec::new(&env);
    for _ in 0..5u32 {
        reporters.push_back(Address::generate(&env));
    }
    for r in reporters.iter() {
        client.add_node(&admin, &r, &asset(&env, "x")).unwrap();
    }

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let prices = [100i128, 101i128, 99i128, 100i128, 500i128]; // 500 = outlier
    for i in 0..5usize {
        let r = reporters.get_unchecked(i as u32);
        client
            .submit_price(&r, &asset(&env, "XLM/USD"), &prices[i])
            .unwrap();
    }

    let agg = client.get_aggregated_price(&asset(&env, "XLM/USD")).unwrap();
    // Rogue 500 should be trimmed; median of [99,100,100,101] = 100
    assert!(agg.median < 200, "outlier should have been trimmed, got {}", agg.median);
}

#[test]
fn test_median_even_count() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    client.add_node(&admin, &r1, &asset(&env, "a")).unwrap();
    client.add_node(&admin, &r2, &asset(&env, "b")).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.submit_price(&r1, &asset(&env, "GOLD/USD"), &1800i128).unwrap();
    client.submit_price(&r2, &asset(&env, "GOLD/USD"), &1900i128).unwrap();

    let agg = client.get_aggregated_price(&asset(&env, "GOLD/USD")).unwrap();
    // Median of [1800, 1900] = 1850
    assert_eq!(agg.median, 1850);
}

// ── Circuit-breaker ───────────────────────────────────────────────────────────

#[test]
fn test_circuit_breaker_trips_on_large_deviation() {
    let (env, client) = setup();
    // Set cb_bps to 1000 (10%) so a 50% jump trips it
    let admin = Address::generate(&env);
    client
        .initialize(&admin, &Some(3600u64), &Some(2000u32), &Some(1000u32), &Some(3600u64))
        .unwrap();

    let reporter = Address::generate(&env);
    client.add_node(&admin, &reporter, &asset(&env, "cb_test")).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.submit_price(&reporter, &asset(&env, "SOL/USD"), &100i128).unwrap();

    // Price jumps 50% – should trip
    env.ledger().with_mut(|l| l.timestamp = 2000);
    client.submit_price(&reporter, &asset(&env, "SOL/USD"), &150i128).unwrap();

    assert!(client.is_circuit_breaker_tripped());
}

#[test]
fn test_circuit_breaker_blocks_submissions() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client
        .initialize(&admin, &Some(3600u64), &Some(2000u32), &Some(1000u32), &Some(3600u64))
        .unwrap();

    let reporter = Address::generate(&env);
    client.add_node(&admin, &reporter, &asset(&env, "n")).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.submit_price(&reporter, &asset(&env, "DOT/USD"), &20i128).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 2000);
    client.submit_price(&reporter, &asset(&env, "DOT/USD"), &40i128).unwrap(); // trips

    let result = client
        .try_submit_price(&reporter, &asset(&env, "DOT/USD"), &41i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::CircuitBreakerTripped);
}

#[test]
fn test_circuit_breaker_reset_by_admin() {
    let (env, client) = setup();
    let admin = Address::generate(&env);
    client
        .initialize(&admin, &Some(3600u64), &Some(2000u32), &Some(1000u32), &Some(3600u64))
        .unwrap();

    let reporter = Address::generate(&env);
    client.add_node(&admin, &reporter, &asset(&env, "r")).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.submit_price(&reporter, &asset(&env, "AVAX/USD"), &20i128).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 2000);
    client.submit_price(&reporter, &asset(&env, "AVAX/USD"), &40i128).unwrap(); // trips

    assert!(client.is_circuit_breaker_tripped());

    client.reset_circuit_breaker(&admin).unwrap();
    assert!(!client.is_circuit_breaker_tripped());
}

// ── TWAP ──────────────────────────────────────────────────────────────────────

#[test]
fn test_twap_single_point_equals_price() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);
    let reporter = Address::generate(&env);
    client.add_node(&admin, &reporter, &asset(&env, "t")).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.submit_price(&reporter, &asset(&env, "LINK/USD"), &15i128).unwrap();

    // First submission: TWAP = price (no elapsed time yet)
    let twap = client.get_twap(&asset(&env, "LINK/USD")).unwrap();
    assert_eq!(twap, 15);
}

#[test]
fn test_twap_accumulates_over_time() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);
    let reporter = Address::generate(&env);
    client.add_node(&admin, &reporter, &asset(&env, "tw")).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    client.submit_price(&reporter, &asset(&env, "UNI/USD"), &10i128).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 2000);
    client.submit_price(&reporter, &asset(&env, "UNI/USD"), &20i128).unwrap();

    // After two samples: TWAP should reflect time-weighted average
    let twap = client.get_twap(&asset(&env, "UNI/USD")).unwrap();
    // price_time_sum = 10 * 1000 = 10000, total_time = 1000 → TWAP = 10
    assert_eq!(twap, 10);
}

// ── Unauthorized ──────────────────────────────────────────────────────────────

#[test]
fn test_unauthorized_node_rejected() {
    let (env, client) = setup();
    init_default(&env, &client);

    let outsider = Address::generate(&env);
    env.ledger().with_mut(|l| l.timestamp = 1000);
    let result = client.try_submit_price(&outsider, &asset(&env, "BTC/USD"), &1000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::NodeNotFound);
}

#[test]
fn test_inactive_node_rejected() {
    let (env, client) = setup();
    let admin = init_default(&env, &client);
    let reporter = Address::generate(&env);
    let id = client.add_node(&admin, &reporter, &asset(&env, "n")).unwrap();
    client.deactivate_node(&admin, &id).unwrap();

    env.ledger().with_mut(|l| l.timestamp = 1000);
    let result = client.try_submit_price(&reporter, &asset(&env, "BTC/USD"), &1000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::NodeInactive);
}
