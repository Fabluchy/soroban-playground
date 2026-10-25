// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Env};

const INITIAL_PRICE: i128 = 100_000_000; // $100.00
const SIZE: i128 = 1_000_000;
const COLLATERAL: i128 = 200_000;

fn setup() -> (
    Env,
    PerpetualFuturesClient<'static>,
    Address,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, PerpetualFutures);
    let client = PerpetualFuturesClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let trader = Address::generate(&env);
    let liquidator = Address::generate(&env);
    client.initialize(&admin, &INITIAL_PRICE);
    (env, client, admin, trader, liquidator)
}

#[test]
fn test_initialize_sets_admin() {
    let (_env, client, admin, ..) = setup();
    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_insurance_fund(), 0);
}

#[test]
fn test_initialize_twice_fails() {
    let (_env, client, admin, ..) = setup();
    assert!(client.try_initialize(&admin, &INITIAL_PRICE).is_err());
}

#[test]
fn test_open_long_position() {
    let (_env, client, _admin, trader, _) = setup();
    let id = client.open_position(&trader, &true, &SIZE, &10u32, &COLLATERAL);
    assert_eq!(id, 1);
    assert_eq!(client.position_count(), 1);

    let pos = client.get_position(&id);
    assert_eq!(pos.trader, trader);
    assert!(pos.is_long);
    assert_eq!(pos.size, SIZE);
    assert_eq!(pos.leverage, 10);
    assert_eq!(pos.status, PositionStatus::Active);

    let oi = client.get_open_interest();
    assert_eq!(oi.long_oi, SIZE);
    assert_eq!(oi.short_oi, 0);
}

#[test]
fn test_open_short_position() {
    let (_env, client, _admin, trader, _) = setup();
    let id = client.open_position(&trader, &false, &SIZE, &5u32, &COLLATERAL);
    let pos = client.get_position(&id);
    assert!(!pos.is_long);
    assert_eq!(pos.leverage, 5);

    let oi = client.get_open_interest();
    assert_eq!(oi.long_oi, 0);
    assert_eq!(oi.short_oi, SIZE);
}

#[test]
fn test_invalid_leverage_fails() {
    let (_env, client, _admin, trader, _) = setup();
    // 0 leverage fails
    assert!(client
        .try_open_position(&trader, &true, &SIZE, &0u32, &COLLATERAL)
        .is_err());
    // > 20 leverage fails (max 20x cross margin leverage)
    assert!(client
        .try_open_position(&trader, &true, &SIZE, &21u32, &COLLATERAL)
        .is_err());
}

#[test]
fn test_close_position_long() {
    let (_env, client, _admin, trader, _) = setup();
    let id = client.open_position(&trader, &true, &SIZE, &10u32, &COLLATERAL);

    let exit_price = INITIAL_PRICE + 10_000_000;
    let net = client.close_position(&trader, &id, &exit_price);
    assert!(net > COLLATERAL);

    let pos = client.get_position(&id);
    assert_eq!(pos.status, PositionStatus::Closed);

    let oi = client.get_open_interest();
    assert_eq!(oi.long_oi, 0);
}

#[test]
fn test_close_position_short() {
    let (_env, client, _admin, trader, _) = setup();
    let id = client.open_position(&trader, &false, &SIZE, &10u32, &COLLATERAL);

    let exit_price = INITIAL_PRICE - 10_000_000;
    let net = client.close_position(&trader, &id, &exit_price);
    assert!(net > COLLATERAL);

    let oi = client.get_open_interest();
    assert_eq!(oi.short_oi, 0);
}

#[test]
fn test_funding_rate_clamping() {
    let (_env, client, admin, ..) = setup();

    // Normal calculation: mark = 101, index = 100 -> +1% = +100 bps
    let mark = INITIAL_PRICE + 1_000_000;
    let index = INITIAL_PRICE;
    let bps = client.update_funding_rate(&admin, &mark, &index);
    assert_eq!(bps, 100);

    // Large deviation above +5%: mark = 120, index = 100 -> +20%, clamped to +500 bps (+5%)
    let high_mark = INITIAL_PRICE + 20_000_000;
    let bps_clamped_high = client.update_funding_rate(&admin, &high_mark, &index);
    assert_eq!(bps_clamped_high, 500);

    // Large deviation below -5%: mark = 80, index = 100 -> -20%, clamped to -500 bps (-5%)
    let low_mark = INITIAL_PRICE - 20_000_000;
    let bps_clamped_low = client.update_funding_rate(&admin, &low_mark, &index);
    assert_eq!(bps_clamped_low, -500);
}

#[test]
fn test_continuous_funding_payment_transfer() {
    let (env, client, admin, trader, _) = setup();
    let trader_b = Address::generate(&env);

    // Open long position
    client.open_position(&trader, &true, &SIZE, &10u32, &COLLATERAL);
    // Open short position
    client.open_position(&trader_b, &false, &SIZE, &10u32, &COLLATERAL);

    let oi = client.get_open_interest();
    assert_eq!(oi.long_oi, SIZE);
    assert_eq!(oi.short_oi, SIZE);

    // Advance ledger timestamp by 8 hours
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + EIGHT_HOURS_SECONDS);

    // Positive funding rate (longs pay shorts) at +100 bps
    let mark = INITIAL_PRICE + 1_000_000;
    let index = INITIAL_PRICE;
    client.update_funding_rate(&admin, &mark, &index);

    let transferred = client.get_funding_transferred();
    assert!(transferred > 0);
}

#[test]
fn test_cross_margin_accounting() {
    let (_env, client, _admin, trader, _) = setup();

    // Trader deposits additional collateral
    client.deposit_collateral(&trader, &500_000);
    // Trader opens 1 long position
    client.open_position(&trader, &true, &SIZE, &10u32, &100_000);

    // When price rises by 10%
    let higher_price = INITIAL_PRICE + 10_000_000;
    let acct = client.get_account(&trader, &higher_price);
    assert_eq!(acct.total_position_size, SIZE);
    assert!(acct.unrealized_pnl > 0);
    assert_eq!(acct.equity, acct.collateral + acct.unrealized_pnl);
    assert!(acct.margin_ratio_bps > 500);
}

#[test]
fn test_insurance_fund_covers_deficit_liquidation() {
    let (_env, client, admin, trader, liquidator) = setup();

    // Admin seeds insurance fund with 500,000
    client.deposit_insurance_fund(&admin, &500_000);
    assert_eq!(client.get_insurance_fund(), 500_000);

    // Trader opens long position at 20x leverage (5% initial margin)
    let id = client.open_position(&trader, &true, &SIZE, &20u32, &50_000);

    // Severe crash: price drops by 50%
    let crash_price = INITIAL_PRICE / 2;
    let deficit = client.liquidate_position(&liquidator, &id, &crash_price);

    assert!(deficit > 0);
    let remaining_fund = client.get_insurance_fund();
    assert_eq!(remaining_fund, 500_000 - deficit);

    let pos = client.get_position(&id);
    assert_eq!(pos.status, PositionStatus::Liquidated);
}

#[test]
fn test_partial_liquidation() {
    let (_env, client, _admin, trader, liquidator) = setup();

    // Trader opens position with 50_000 collateral for 1_000_000 size (20x)
    let id = client.open_position(&trader, &true, &SIZE, &20u32, &50_000);

    // Price drops slightly so margin is below 5% maintenance threshold
    let drop_price = INITIAL_PRICE - 5_000_000; // -5%
    let closed_size = client.partial_liquidate(&liquidator, &id, &drop_price, &5000); // 50%

    assert_eq!(closed_size, SIZE / 2);
    let pos = client.get_position(&id);
    assert_eq!(pos.size, SIZE / 2);
    assert_eq!(pos.status, PositionStatus::PartiallyLiquidated);
}

#[test]
fn test_rapid_crash_and_squeeze_simulation() {
    let (env, client, admin, trader_long, liquidator) = setup();
    let trader_short = Address::generate(&env);

    client.deposit_insurance_fund(&admin, &1_000_000);

    // 1. Long and Short open positions
    let pos_long = client.open_position(&trader_long, &true, &SIZE, &20u32, &50_000);
    let pos_short = client.open_position(&trader_short, &false, &SIZE, &20u32, &50_000);

    // 2. Flash crash: price plummets to 60% of value
    let crash_price = INITIAL_PRICE * 6 / 10;
    client.liquidate_position(&liquidator, &pos_long, &crash_price);
    let pos_long_after = client.get_position(&pos_long);
    assert_eq!(pos_long_after.status, PositionStatus::Liquidated);

    // Short trader is now in huge profit
    let short_pnl = client.close_position(&trader_short, &pos_short, &crash_price);
    assert!(short_pnl > 50_000);

    // 3. Short squeeze: new short enters, price surges to 150%
    let trader_short_2 = Address::generate(&env);
    let pos_short_2 = client.open_position(&trader_short_2, &false, &SIZE, &20u32, &50_000);

    let squeeze_price = INITIAL_PRICE * 15 / 10;
    client.liquidate_position(&liquidator, &pos_short_2, &squeeze_price);
    let pos_short_2_after = client.get_position(&pos_short_2);
    assert_eq!(pos_short_2_after.status, PositionStatus::Liquidated);

    // Insurance fund absorbed bankruptcies cleanly without draining completely
    assert!(client.get_insurance_fund() > 0);
}

#[test]
fn test_pause_blocks_operations() {
    let (_env, client, admin, trader, _) = setup();
    client.set_paused(&admin, &true);
    assert!(client
        .try_open_position(&trader, &true, &SIZE, &10u32, &COLLATERAL)
        .is_err());
}
