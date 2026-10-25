// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Env};

fn setup() -> (
    Env,
    CollateralSwapAdapterClient<'static>,
    Address,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, CollateralSwapAdapter);
    let client = CollateralSwapAdapterClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let token_xlm = Address::generate(&env);
    let token_usdc = Address::generate(&env);

    client.initialize(&admin, &9); // 9 bps flash loan fee (0.09%)

    // XLM price = $1.00 (10_000_000)
    client.set_token_price(&admin, &token_xlm, &10_000_000);
    // USDC price = $1.00 (10_000_000)
    client.set_token_price(&admin, &token_usdc, &10_000_000);

    // DEX Rate XLM -> USDC = 1:1 (10_000 bps)
    client.set_dex_rate(&admin, &token_xlm, &token_usdc, &10_000);

    (env, client, admin, user, token_xlm, token_usdc)
}

#[test]
fn test_successful_atomic_collateral_swap() {
    let (_env, client, admin, user, token_xlm, token_usdc) = setup();

    // User position: 1000 XLM collateral ($1000 value), $500 debt.
    // Initial Health Factor = ($1000 * 10_000) / $500 = 20,000 bps (2.0 HF)
    client.set_position(&admin, &user, &token_xlm, &1_000, &500);

    let initial_health = client.get_health_factor(&user, &token_xlm);
    assert_eq!(initial_health.health_factor_bps, 20_000);

    // Single atomic swap: borrow 990 USDC flash loan, swap 1000 XLM to USDC, repay flash loan
    let params = SwapParams {
        user: user.clone(),
        from_collateral: token_xlm.clone(),
        to_collateral: token_usdc.clone(),
        from_amount: 1_000,
        flash_borrow_amount: 990,
        min_dex_output: 995,
    };

    let result = client.execute_collateral_swap(&params);

    assert_eq!(result.from_collateral_withdrawn, 1_000);
    assert!(result.to_collateral_deposited >= 990);
    assert_eq!(result.initial_health_factor, 20_000);
    assert!(result.final_health_factor >= result.initial_health_factor);

    // Old collateral is withdrawn (0) and new collateral is deposited in lending pool
    assert_eq!(client.get_user_collateral(&user, &token_xlm), 0);
    assert!(client.get_user_collateral(&user, &token_usdc) >= 990);
}

#[test]
fn test_rollback_on_dex_slippage() {
    let (_env, client, admin, user, token_xlm, token_usdc) = setup();

    client.set_position(&admin, &user, &token_xlm, &1_000, &500);

    // Set high minimum output that DEX cannot satisfy
    let params = SwapParams {
        user: user.clone(),
        from_collateral: token_xlm.clone(),
        to_collateral: token_usdc.clone(),
        from_amount: 1_000,
        flash_borrow_amount: 990,
        min_dex_output: 1_100, // DEX only produces 1000
    };

    assert!(client.try_execute_collateral_swap(&params).is_err());

    // Position remains untouched due to atomic rollback
    assert_eq!(client.get_user_collateral(&user, &token_xlm), 1_000);
    assert_eq!(client.get_user_collateral(&user, &token_usdc), 0);
}

#[test]
fn test_rollback_on_flash_loan_repayment_failure() {
    let (_env, client, admin, user, token_xlm, token_usdc) = setup();

    client.set_position(&admin, &user, &token_xlm, &1_000, &500);

    // Try borrowing 1500 USDC when only 1000 XLM is swapped -> DEX cannot repay flash loan
    let params = SwapParams {
        user: user.clone(),
        from_collateral: token_xlm.clone(),
        to_collateral: token_usdc.clone(),
        from_amount: 1_000,
        flash_borrow_amount: 1_500,
        min_dex_output: 500,
    };

    assert!(client.try_execute_collateral_swap(&params).is_err());
    assert_eq!(client.get_user_collateral(&user, &token_xlm), 1_000);
}

#[test]
fn test_health_factor_validation_rejects_degradation() {
    let (_env, client, admin, user, token_xlm, token_usdc) = setup();

    client.set_position(&admin, &user, &token_xlm, &1_000, &500);

    // Set USDC price lower to $0.80 (8_000_000)
    // Resulting health factor would drop from 2.0 to 1.6, violating HF_final >= HF_initial
    client.set_token_price(&admin, &token_usdc, &8_000_000);

    let params = SwapParams {
        user: user.clone(),
        from_collateral: token_xlm.clone(),
        to_collateral: token_usdc.clone(),
        from_amount: 1_000,
        flash_borrow_amount: 990,
        min_dex_output: 990,
    };

    assert!(client.try_execute_collateral_swap(&params).is_err());
    assert_eq!(client.get_user_collateral(&user, &token_xlm), 1_000);
}

#[test]
fn test_insolvent_position_rejection() {
    let (_env, client, admin, user, token_xlm, token_usdc) = setup();

    // Insolvent: 500 XLM collateral ($500), $600 debt (HF < 1.0)
    client.set_position(&admin, &user, &token_xlm, &500, &600);

    let params = SwapParams {
        user: user.clone(),
        from_collateral: token_xlm.clone(),
        to_collateral: token_usdc.clone(),
        from_amount: 500,
        flash_borrow_amount: 450,
        min_dex_output: 450,
    };

    assert!(client.try_execute_collateral_swap(&params).is_err());
}
