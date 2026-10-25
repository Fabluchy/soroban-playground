// Copyright (c) 2026 StellarDevHub
// SPDX-License-Identifier: MIT

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env,
};

pub const PRICE_PRECISION: i128 = 1_000_000; // 1.0 = 1,000,000
pub const BPS_DENOMINATOR: i128 = 10_000;    // 100% = 10,000 bps

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    RebalanceNotNeeded = 4,
    SlippageExceeded = 5,
    ZeroAmount = 6,
    InsufficientShares = 7,
    InsufficientLiquidity = 8,
    InvalidParameters = 9,
    MathOverflow = 10,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultConfig {
    pub admin: Address,
    pub token_a: Address,
    pub token_b: Address,
    pub rebalance_threshold_bps: u32, // e.g. 500 = 5% drift threshold
    pub range_width_bps: u32,          // e.g. 1000 = +/- 5% (10% total width)
    pub keeper_reward_bps: u32,        // e.g. 50 = 0.5% incentive reward
    pub max_slippage_bps: u32,         // e.g. 100 = 1.0% max slippage
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConcentratedPosition {
    pub lower_tick: i32,
    pub upper_tick: i32,
    pub lower_price: i128,
    pub upper_price: i128,
    pub liquidity: i128,
    pub total_fees_collected_a: i128,
    pub total_fees_collected_b: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultState {
    pub current_price: i128,
    pub current_tick: i32,
    pub total_shares: i128,
    pub total_reserve_a: i128,
    pub total_reserve_b: i128,
    pub rebalance_count: u32,
}

#[contracttype]
enum DataKey {
    Config,
    State,
    Position,
    UserShare(Address),
}

#[contract]
pub struct LiquidityManagerVault;

#[contractimpl]
impl LiquidityManagerVault {
    /// Initialize the ERC-4626 autonomous liquidity management vault.
    pub fn initialize(
        env: Env,
        admin: Address,
        token_a: Address,
        token_b: Address,
        initial_price: i128,
        initial_tick: i32,
        rebalance_threshold_bps: u32,
        range_width_bps: u32,
        keeper_reward_bps: u32,
        max_slippage_bps: u32,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        if initial_price <= 0 || rebalance_threshold_bps == 0 || range_width_bps == 0 {
            return Err(Error::InvalidParameters);
        }

        let config = VaultConfig {
            admin: admin.clone(),
            token_a,
            token_b,
            rebalance_threshold_bps,
            range_width_bps,
            keeper_reward_bps,
            max_slippage_bps,
        };

        let half_width = (range_width_bps as i128) / 2;
        let lower_price = (initial_price * (BPS_DENOMINATOR - half_width)) / BPS_DENOMINATOR;
        let upper_price = (initial_price * (BPS_DENOMINATOR + half_width)) / BPS_DENOMINATOR;
        let lower_tick = initial_tick - (range_width_bps as i32) / 2;
        let upper_tick = initial_tick + (range_width_bps as i32) / 2;

        let position = ConcentratedPosition {
            lower_tick,
            upper_tick,
            lower_price,
            upper_price,
            liquidity: 0,
            total_fees_collected_a: 0,
            total_fees_collected_b: 0,
        };

        let state = VaultState {
            current_price: initial_price,
            current_tick: initial_tick,
            total_shares: 0,
            total_reserve_a: 0,
            total_reserve_b: 0,
            rebalance_count: 0,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::Position, &position);
        env.storage().instance().set(&DataKey::State, &state);

        env.events().publish(
            (symbol_short!("init"),),
            (admin, initial_price, initial_tick),
        );
        Ok(())
    }

    /// Deposit assets into the ERC-4626 vault and receive proportional shares.
    pub fn deposit(
        env: Env,
        caller: Address,
        amount_a: i128,
        amount_b: i128,
    ) -> Result<i128, Error> {
        caller.require_auth();

        if amount_a <= 0 && amount_b <= 0 {
            return Err(Error::ZeroAmount);
        }

        let mut state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;

        let deposit_val = (amount_a * state.current_price) / PRICE_PRECISION + amount_b;
        if deposit_val <= 0 {
            return Err(Error::ZeroAmount);
        }

        let shares_to_mint = if state.total_shares == 0 {
            deposit_val
        } else {
            let total_val = (state.total_reserve_a * state.current_price) / PRICE_PRECISION
                + state.total_reserve_b;
            if total_val <= 0 {
                deposit_val
            } else {
                (deposit_val * state.total_shares) / total_val
            }
        };

        if shares_to_mint <= 0 {
            return Err(Error::ZeroAmount);
        }

        // Update user shares
        let user_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::UserShare(caller.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::UserShare(caller.clone()), &(user_shares + shares_to_mint));

        // Update reserves
        state.total_shares += shares_to_mint;
        state.total_reserve_a += amount_a;
        state.total_reserve_b += amount_b;
        env.storage().instance().set(&DataKey::State, &state);

        // Update active concentrated position liquidity
        let mut position: ConcentratedPosition = env
            .storage()
            .instance()
            .get(&DataKey::Position)
            .ok_or(Error::NotInitialized)?;
        position.liquidity += shares_to_mint;
        env.storage().instance().set(&DataKey::Position, &position);

        env.events().publish(
            (symbol_short!("deposit"), caller),
            (amount_a, amount_b, shares_to_mint),
        );

        Ok(shares_to_mint)
    }

    /// Redeem vault shares for proportional underlying assets.
    pub fn withdraw(
        env: Env,
        caller: Address,
        shares: i128,
    ) -> Result<(i128, i128), Error> {
        caller.require_auth();

        if shares <= 0 {
            return Err(Error::ZeroAmount);
        }

        let mut state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;

        let user_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::UserShare(caller.clone()))
            .unwrap_or(0);

        if user_shares < shares {
            return Err(Error::InsufficientShares);
        }

        if state.total_shares <= 0 {
            return Err(Error::InsufficientLiquidity);
        }

        let amount_a = (state.total_reserve_a * shares) / state.total_shares;
        let amount_b = (state.total_reserve_b * shares) / state.total_shares;

        env.storage()
            .persistent()
            .set(&DataKey::UserShare(caller.clone()), &(user_shares - shares));

        state.total_shares -= shares;
        state.total_reserve_a -= amount_a;
        state.total_reserve_b -= amount_b;
        env.storage().instance().set(&DataKey::State, &state);

        let mut position: ConcentratedPosition = env
            .storage()
            .instance()
            .get(&DataKey::Position)
            .ok_or(Error::NotInitialized)?;
        if position.liquidity >= shares {
            position.liquidity -= shares;
        } else {
            position.liquidity = 0;
        }
        env.storage().instance().set(&DataKey::Position, &position);

        env.events().publish(
            (symbol_short!("withdraw"), caller),
            (amount_a, amount_b, shares),
        );

        Ok((amount_a, amount_b))
    }

    /// Check if rebalance is needed based on +/- threshold drift.
    pub fn is_rebalance_needed(env: Env) -> Result<bool, Error> {
        let state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;
        let position: ConcentratedPosition = env
            .storage()
            .instance()
            .get(&DataKey::Position)
            .ok_or(Error::NotInitialized)?;

        Ok(state.current_price < position.lower_price
            || state.current_price > position.upper_price)
    }

    /// Autonomous rebalance called by keepers when price drifts out of range.
    /// Incorporates slippage limits and pays keeper incentive rewards.
    pub fn rebalance(
        env: Env,
        keeper: Address,
        min_received_a: i128,
        min_received_b: i128,
    ) -> Result<(i128, i128), Error> {
        keeper.require_auth();

        if !Self::is_rebalance_needed(env.clone())? {
            return Err(Error::RebalanceNotNeeded);
        }

        let config: VaultConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;
        let mut state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;
        let mut position: ConcentratedPosition = env
            .storage()
            .instance()
            .get(&DataKey::Position)
            .ok_or(Error::NotInitialized)?;

        // Step 1: Calculate keeper incentive rewards
        let keeper_reward_a =
            (state.total_reserve_a * (config.keeper_reward_bps as i128)) / BPS_DENOMINATOR;
        let keeper_reward_b =
            (state.total_reserve_b * (config.keeper_reward_bps as i128)) / BPS_DENOMINATOR;

        state.total_reserve_a -= keeper_reward_a;
        state.total_reserve_b -= keeper_reward_b;

        // Step 2: Re-swap out-of-range tokens to target 50/50 centered ratio around current price
        let val_a = (state.total_reserve_a * state.current_price) / PRICE_PRECISION;
        let val_b = state.total_reserve_b;
        let total_val = val_a + val_b;
        let target_val_per_side = total_val / 2;

        // Apply a 30 bps (0.3%) AMM pool swap fee
        const SWAP_FEE_BPS: i128 = 30;

        if val_a > target_val_per_side && state.current_price > 0 {
            let surplus_val_in_b = val_a - target_val_per_side;
            let amount_a_to_swap = (surplus_val_in_b * PRICE_PRECISION) / state.current_price;
            let effective_amount_a =
                (amount_a_to_swap * (BPS_DENOMINATOR - SWAP_FEE_BPS)) / BPS_DENOMINATOR;
            let amount_b_received =
                (effective_amount_a * state.current_price) / PRICE_PRECISION;

            state.total_reserve_a -= amount_a_to_swap;
            state.total_reserve_b += amount_b_received;
        } else if val_b > target_val_per_side && state.current_price > 0 {
            let surplus_b = val_b - target_val_per_side;
            let effective_b = (surplus_b * (BPS_DENOMINATOR - SWAP_FEE_BPS)) / BPS_DENOMINATOR;
            let amount_a_received = (effective_b * PRICE_PRECISION) / state.current_price;

            state.total_reserve_b -= surplus_b;
            state.total_reserve_a += amount_a_received;
        }

        // Step 3: Slippage checks against front-running & MEV losses
        if state.total_reserve_a < min_received_a || state.total_reserve_b < min_received_b {
            return Err(Error::SlippageExceeded);
        }

        // Step 4: Mint new centered concentrated liquidity range
        let half_width = (config.range_width_bps as i128) / 2;
        position.lower_price =
            (state.current_price * (BPS_DENOMINATOR - half_width)) / BPS_DENOMINATOR;
        position.upper_price =
            (state.current_price * (BPS_DENOMINATOR + half_width)) / BPS_DENOMINATOR;
        position.lower_tick = state.current_tick - (config.range_width_bps as i32) / 2;
        position.upper_tick = state.current_tick + (config.range_width_bps as i32) / 2;

        state.rebalance_count += 1;

        env.storage().instance().set(&DataKey::State, &state);
        env.storage().instance().set(&DataKey::Position, &position);

        env.events().publish(
            (symbol_short!("rebal"), keeper),
            (
                keeper_reward_a,
                keeper_reward_b,
                position.lower_price,
                position.upper_price,
            ),
        );

        Ok((keeper_reward_a, keeper_reward_b))
    }

    /// Simulate or record price updates from external pool / oracle.
    pub fn update_market_price(
        env: Env,
        caller: Address,
        new_price: i128,
        new_tick: i32,
    ) -> Result<(), Error> {
        caller.require_auth();
        if new_price <= 0 {
            return Err(Error::InvalidParameters);
        }

        let mut state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;

        state.current_price = new_price;
        state.current_tick = new_tick;
        env.storage().instance().set(&DataKey::State, &state);

        env.events().publish(
            (symbol_short!("price"),),
            (new_price, new_tick),
        );

        Ok(())
    }

    /// Accrue trading fees collected by the active in-range concentrated position.
    pub fn accrue_trading_fees(
        env: Env,
        caller: Address,
        fee_a: i128,
        fee_b: i128,
    ) -> Result<(), Error> {
        caller.require_auth();
        if fee_a < 0 || fee_b < 0 {
            return Err(Error::InvalidParameters);
        }

        let mut state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;
        let mut position: ConcentratedPosition = env
            .storage()
            .instance()
            .get(&DataKey::Position)
            .ok_or(Error::NotInitialized)?;

        state.total_reserve_a += fee_a;
        state.total_reserve_b += fee_b;

        position.total_fees_collected_a += fee_a;
        position.total_fees_collected_b += fee_b;

        env.storage().instance().set(&DataKey::State, &state);
        env.storage().instance().set(&DataKey::Position, &position);

        env.events().publish(
            (symbol_short!("fees"),),
            (fee_a, fee_b),
        );

        Ok(())
    }

    /// Read current vault config.
    pub fn get_config(env: Env) -> Result<VaultConfig, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }

    /// Read current vault state.
    pub fn get_state(env: Env) -> Result<VaultState, Error> {
        env.storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)
    }

    /// Read active concentrated liquidity position.
    pub fn get_position(env: Env) -> Result<ConcentratedPosition, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Position)
            .ok_or(Error::NotInitialized)
    }

    /// Query user's vault share balance.
    pub fn balance_of(env: Env, user: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::UserShare(user))
            .unwrap_or(0)
    }

    /// ERC-4626: Convert underlying assets to vault shares.
    pub fn convert_to_shares(env: Env, amount_a: i128, amount_b: i128) -> Result<i128, Error> {
        let state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;

        let deposit_val = (amount_a * state.current_price) / PRICE_PRECISION + amount_b;
        if state.total_shares == 0 {
            Ok(deposit_val)
        } else {
            let total_val = (state.total_reserve_a * state.current_price) / PRICE_PRECISION
                + state.total_reserve_b;
            if total_val <= 0 {
                Ok(deposit_val)
            } else {
                Ok((deposit_val * state.total_shares) / total_val)
            }
        }
    }

    /// ERC-4626: Convert vault shares to underlying assets.
    pub fn convert_to_assets(env: Env, shares: i128) -> Result<(i128, i128), Error> {
        let state: VaultState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .ok_or(Error::NotInitialized)?;

        if state.total_shares <= 0 {
            return Ok((0, 0));
        }

        let amount_a = (state.total_reserve_a * shares) / state.total_shares;
        let amount_b = (state.total_reserve_b * shares) / state.total_shares;
        Ok((amount_a, amount_b))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup_test_vault(env: &Env) -> (Address, Address, Address) {
        let admin = Address::generate(env);
        let token_a = Address::generate(env);
        let token_b = Address::generate(env);

        LiquidityManagerVault::initialize(
            env.clone(),
            admin.clone(),
            token_a.clone(),
            token_b.clone(),
            PRICE_PRECISION, // 1.0 initial price
            0,               // tick 0
            500,             // 5% rebalance drift threshold
            1000,            // 10% range width (+/- 5%)
            50,              // 0.5% keeper reward
            100,             // 1% max slippage
        )
        .unwrap();

        (admin, token_a, token_b)
    }

    #[test]
    fn test_initialization() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b) = setup_test_vault(&env);

        let config = LiquidityManagerVault::get_config(env.clone()).unwrap();
        assert_eq!(config.admin, admin);
        assert_eq!(config.token_a, token_a);
        assert_eq!(config.token_b, token_b);
        assert_eq!(config.rebalance_threshold_bps, 500);

        let pos = LiquidityManagerVault::get_position(env.clone()).unwrap();
        // With initial price 1_000_000 and 1000 range width (half width 500 = 5%),
        // lower_price = 950_000, upper_price = 1_050_000.
        assert_eq!(pos.lower_price, 950_000);
        assert_eq!(pos.upper_price, 1_050_000);
    }

    #[test]
    fn test_deposit_and_vault_shares_proportional() {
        let env = Env::default();
        env.mock_all_auths();
        setup_test_vault(&env);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        // Alice deposits 1000 token A and 1000 token B at 1:1 price
        let shares_alice =
            LiquidityManagerVault::deposit(env.clone(), alice.clone(), 1_000, 1_000).unwrap();
        assert_eq!(shares_alice, 2_000);
        assert_eq!(LiquidityManagerVault::balance_of(env.clone(), alice.clone()), 2_000);

        // Bob deposits half of Alice's amount
        let shares_bob =
            LiquidityManagerVault::deposit(env.clone(), bob.clone(), 500, 500).unwrap();
        assert_eq!(shares_bob, 1_000);
        assert_eq!(LiquidityManagerVault::balance_of(env.clone(), bob), 1_000);

        let state = LiquidityManagerVault::get_state(env.clone()).unwrap();
        assert_eq!(state.total_shares, 3_000);
        assert_eq!(state.total_reserve_a, 1_500);
        assert_eq!(state.total_reserve_b, 1_500);
    }

    #[test]
    fn test_price_within_range_no_rebalance() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, _) = setup_test_vault(&env);

        let alice = Address::generate(&env);
        let keeper = Address::generate(&env);

        LiquidityManagerVault::deposit(env.clone(), alice, 10_000, 10_000).unwrap();

        // Price moves within +/- 5% range (e.g. +3% to 1_030_000)
        LiquidityManagerVault::update_market_price(env.clone(), admin, 1_030_000, 30).unwrap();

        let needed = LiquidityManagerVault::is_rebalance_needed(env.clone()).unwrap();
        assert_eq!(needed, false);

        // Attempting to rebalance when not needed fails
        let res = LiquidityManagerVault::rebalance(env.clone(), keeper, 0, 0);
        assert_eq!(res, Err(Error::RebalanceNotNeeded));
    }

    #[test]
    fn test_price_drift_triggers_rebalance_and_keeper_reward() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, _) = setup_test_vault(&env);

        let alice = Address::generate(&env);
        let keeper = Address::generate(&env);

        LiquidityManagerVault::deposit(env.clone(), alice, 10_000, 10_000).unwrap();

        // Price drifts outside the 5% threshold (e.g. +8% to 1_080_000)
        LiquidityManagerVault::update_market_price(env.clone(), admin, 1_080_000, 80).unwrap();

        let needed = LiquidityManagerVault::is_rebalance_needed(env.clone()).unwrap();
        assert_eq!(needed, true);

        // Keeper executes rebalance
        let (reward_a, reward_b) =
            LiquidityManagerVault::rebalance(env.clone(), keeper, 8_000, 8_000).unwrap();
        assert!(reward_a > 0 || reward_b > 0);

        let pos = LiquidityManagerVault::get_position(env.clone()).unwrap();
        let state = LiquidityManagerVault::get_state(env.clone()).unwrap();
        assert_eq!(state.rebalance_count, 1);

        // New range centered around 1_080_000
        assert!(pos.lower_price > 950_000);
        assert!(pos.upper_price > 1_050_000);
        assert!(state.current_price >= pos.lower_price && state.current_price <= pos.upper_price);
    }

    #[test]
    fn test_slippage_protection() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, _) = setup_test_vault(&env);

        let alice = Address::generate(&env);
        let keeper = Address::generate(&env);

        LiquidityManagerVault::deposit(env.clone(), alice, 10_000, 10_000).unwrap();

        // Price drifts outside threshold
        LiquidityManagerVault::update_market_price(env.clone(), admin, 1_100_000, 100).unwrap();

        // Expect unrealistically high minimum reserves to trigger slippage error
        let res = LiquidityManagerVault::rebalance(env.clone(), keeper, 25_000, 25_000);
        assert_eq!(res, Err(Error::SlippageExceeded));
    }

    #[test]
    fn test_vault_share_redemption_with_accumulated_fees() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, _) = setup_test_vault(&env);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        // Alice deposits 10_000 A and 10_000 B -> 20_000 shares
        let alice_shares =
            LiquidityManagerVault::deposit(env.clone(), alice.clone(), 10_000, 10_000).unwrap();

        // Active concentrated position earns trading fees while in range
        LiquidityManagerVault::accrue_trading_fees(env.clone(), admin, 1_000, 1_000).unwrap();

        // Bob converts assets to shares: total vault value increased, so Bob receives fewer shares per asset
        let bob_shares =
            LiquidityManagerVault::convert_to_shares(env.clone(), 10_000, 10_000).unwrap();
        assert!(bob_shares < alice_shares);

        // Alice withdraws all her shares: gets original principal + earned fees
        let (withdrawn_a, withdrawn_b) =
            LiquidityManagerVault::withdraw(env.clone(), alice.clone(), alice_shares).unwrap();
        assert!(withdrawn_a > 10_000);
        assert!(withdrawn_b > 10_000);
        assert_eq!(LiquidityManagerVault::balance_of(env.clone(), alice), 0);
    }

    #[test]
    fn test_simulation_continuous_price_trend_and_volatile_swings() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, _) = setup_test_vault(&env);

        let depositor = Address::generate(&env);
        let keeper = Address::generate(&env);

        // Step 1: Initial deposit
        let initial_shares =
            LiquidityManagerVault::deposit(env.clone(), depositor.clone(), 50_000, 50_000).unwrap();
        assert_eq!(initial_shares, 100_000);

        // Step 2: Continuous upward price drift with active fee accrual
        // Price moves from 1.0 -> 1.02 -> 1.04 -> 1.06 (breaching upper bound 1.05)
        LiquidityManagerVault::accrue_trading_fees(env.clone(), admin.clone(), 500, 500).unwrap();
        LiquidityManagerVault::update_market_price(env.clone(), admin.clone(), 1_020_000, 20).unwrap();
        assert_eq!(LiquidityManagerVault::is_rebalance_needed(env.clone()).unwrap(), false);

        LiquidityManagerVault::accrue_trading_fees(env.clone(), admin.clone(), 500, 500).unwrap();
        LiquidityManagerVault::update_market_price(env.clone(), admin.clone(), 1_060_000, 60).unwrap();
        // Breached!
        assert_eq!(LiquidityManagerVault::is_rebalance_needed(env.clone()).unwrap(), true);

        // Keeper executes rebalance #1
        LiquidityManagerVault::rebalance(env.clone(), keeper.clone(), 40_000, 40_000).unwrap();
        assert_eq!(LiquidityManagerVault::is_rebalance_needed(env.clone()).unwrap(), false);

        // Step 3: Volatile downward swing: price drops from 1.06 to 0.94 (breaching lower bound)
        LiquidityManagerVault::accrue_trading_fees(env.clone(), admin.clone(), 800, 800).unwrap();
        LiquidityManagerVault::update_market_price(env.clone(), admin.clone(), 940_000, -60).unwrap();
        assert_eq!(LiquidityManagerVault::is_rebalance_needed(env.clone()).unwrap(), true);

        // Keeper executes rebalance #2
        LiquidityManagerVault::rebalance(env.clone(), keeper, 35_000, 35_000).unwrap();
        assert_eq!(LiquidityManagerVault::is_rebalance_needed(env.clone()).unwrap(), false);

        let state = LiquidityManagerVault::get_state(env.clone()).unwrap();
        assert_eq!(state.rebalance_count, 2);

        // Step 4: Depositor withdraws after volatile market cycle and rebalances
        let (final_a, final_b) =
            LiquidityManagerVault::withdraw(env.clone(), depositor, initial_shares).unwrap();
        assert!(final_a > 0);
        assert!(final_b > 0);
    }
}
