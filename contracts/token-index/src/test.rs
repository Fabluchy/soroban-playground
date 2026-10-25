// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, vec, Env, Symbol};

fn setup() -> (
    Env,
    TokenIndexClient<'static>,
    Address,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenIndex);
    let client = TokenIndexClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let oracle = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);

    client.initialize(&admin, &oracle);
    (env, client, admin, oracle, token_a, token_b)
}

#[test]
fn test_initialize() {
    let (_env, client, admin, oracle, ..) = setup();
    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_oracle(), oracle);
    assert_eq!(client.get_divisor(), 0);
    assert_eq!(client.get_index(), 0);
}

#[test]
fn test_add_token_laspeyres_base_value() {
    let (_env, client, admin, _oracle, token_a, ..) = setup();

    // Price: $10 (10_000_000), Supply: 100_000
    // Initial Cap = 10_000_000 * 100_000 = 1_000_000_000_000
    // Divisor = 1_000_000_000_000
    // Index = (Cap / Divisor) * 1000 = 1000
    client.add_token(
        &admin,
        &token_a,
        &Symbol::new(&_env, "XLM"),
        &10_000_000,
        &100_000,
    );

    assert_eq!(client.get_index(), 1000);
}

#[test]
fn test_price_change_updates_index() {
    let (env, client, admin, oracle, token_a, token_b) = setup();

    client.add_token(
        &admin,
        &token_a,
        &Symbol::new(&env, "TOK1"),
        &10_000_000,
        &100_000,
    );
    client.add_token(
        &admin,
        &token_b,
        &Symbol::new(&env, "TOK2"),
        &20_000_000,
        &50_000,
    );

    // Initial total cap: (10M * 100k) + (20M * 50k) = 1T + 1T = 2T. Divisor = 2T. Index = 1000.
    assert_eq!(client.get_index(), 1000);

    // Oracle doubles price of TOK1 to 20_000_000
    let tokens = vec![&env, token_a];
    let prices = vec![&env, 20_000_000];
    client.update_prices(&oracle, &tokens, &prices);

    // New cap: (20M * 100k) + (20M * 50k) = 2T + 1T = 3T.
    // Index: (3T * 1000) / 2T = 1500
    assert_eq!(client.get_index(), 1500);
}

#[test]
fn test_divisor_adjustment_on_addition_preserves_index() {
    let (env, client, admin, ..) = setup();
    let token_1 = Address::generate(&env);
    let token_2 = Address::generate(&env);

    client.add_token(
        &admin,
        &token_1,
        &Symbol::new(&env, "T1"),
        &10_000_000,
        &100_000,
    );
    let index_before = client.get_index();
    assert_eq!(index_before, 1000);

    // Add token 2: price = 50M, supply = 200k (adds 10T cap)
    client.add_token(
        &admin,
        &token_2,
        &Symbol::new(&env, "T2"),
        &50_000_000,
        &200_000,
    );

    // Index value MUST remain continuous without artificial jump!
    let index_after = client.get_index();
    assert_eq!(index_after, index_before);
}

#[test]
fn test_divisor_adjustment_on_removal_preserves_index() {
    let (env, client, admin, ..) = setup();
    let token_1 = Address::generate(&env);
    let token_2 = Address::generate(&env);

    client.add_token(
        &admin,
        &token_1,
        &Symbol::new(&env, "T1"),
        &10_000_000,
        &100_000,
    );
    client.add_token(
        &admin,
        &token_2,
        &Symbol::new(&env, "T2"),
        &20_000_000,
        &50_000,
    );

    let index_before = client.get_index();

    // Remove token 2
    client.remove_token(&admin, &token_2);

    // Index value remains continuous
    let index_after = client.get_index();
    assert_eq!(index_after, index_before);
}

#[test]
fn test_divisor_adjustment_on_supply_change() {
    let (env, client, admin, ..) = setup();
    let token_1 = Address::generate(&env);

    client.add_token(
        &admin,
        &token_1,
        &Symbol::new(&env, "T1"),
        &10_000_000,
        &100_000,
    );
    let index_before = client.get_index();

    // Double supply to 200_000
    client.update_token_supply(&admin, &token_1, &200_000);

    let index_after = client.get_index();
    assert_eq!(index_after, index_before);
}

#[test]
fn test_max_10_tokens_limit() {
    let (env, client, admin, ..) = setup();

    for i in 0..10 {
        let tok = Address::generate(&env);
        client.add_token(
            &admin,
            &tok,
            &Symbol::new(&env, "TOK"),
            &10_000_000,
            &100_000,
        );
    }

    assert_eq!(client.get_tokens().len(), 10);

    let tok_11 = Address::generate(&env);
    assert!(client
        .try_add_token(
            &admin,
            &tok_11,
            &Symbol::new(&env, "TOK11"),
            &10_000_000,
            &100_000
        )
        .is_err());
}

#[test]
fn test_historical_snapshots() {
    let (env, client, admin, _oracle, token_a, ..) = setup();
    let caller = Address::generate(&env);

    client.add_token(
        &admin,
        &token_a,
        &Symbol::new(&env, "XLM"),
        &10_000_000,
        &100_000,
    );

    // Initial snapshot
    let snap1 = client.record_snapshot(&caller);
    assert_eq!(snap1.index_value, 1000);

    // Advance 1 day (86,400s)
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + SECONDS_PER_DAY + 1);
    client.record_snapshot(&caller);

    let daily_snap = client.get_daily_snapshot(&1);
    assert_eq!(daily_snap.index_value, 1000);

    // Advance 1 week
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + SECONDS_PER_WEEK + 1);
    client.record_snapshot(&caller);

    let weekly_snap = client.get_weekly_snapshot(&1);
    assert_eq!(weekly_snap.index_value, 1000);
}

#[test]
fn test_index_summary_query() {
    let (env, client, admin, _oracle, token_a, ..) = setup();

    client.add_token(
        &admin,
        &token_a,
        &Symbol::new(&env, "XLM"),
        &10_000_000,
        &100_000,
    );

    let summary = client.get_index_summary();
    assert_eq!(summary.index_value, 1000);
    assert_eq!(summary.token_count, 1);
    assert!(summary.market_cap > 0);
    assert!(summary.divisor > 0);
}
