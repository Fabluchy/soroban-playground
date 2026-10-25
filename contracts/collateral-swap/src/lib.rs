// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

//! # Automated Collateral Swap Adapter for In-Flight Debt Migration
//!
//! Enables borrowers in lending pools to swap their underlying collateral asset
//! (e.g., XLM -> USDC) in a single atomic transaction without repaying debt first.
//! Executes flash loan borrowing, lending pool collateral substitution, DEX AMM swap,
//! flash loan repayment, and health factor validation.

#![no_std]

mod storage;
mod test;
mod types;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

use crate::storage::{
    get_admin, get_dex_rate, get_flash_loan_fee_bps, get_token_price, get_user_collateral,
    get_user_debt, is_initialized, set_admin, set_dex_rate, set_flash_loan_fee_bps,
    set_initialized, set_token_price, set_user_collateral, set_user_debt,
};
use crate::types::{Error, PositionHealth, SwapParams, SwapResult};

pub const PRICE_SCALE: i128 = 10_000_000; // 1e7
pub const BPS_SCALE: i128 = 10_000;
pub const MIN_SOLVENT_HF_BPS: i128 = 10_000; // 1.0 minimum health factor

#[contract]
pub struct CollateralSwapAdapter;

#[contractimpl]
impl CollateralSwapAdapter {
    pub fn initialize(env: Env, admin: Address, flash_fee_bps: i128) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        set_admin(&env, &admin);
        set_initialized(&env);
        set_flash_loan_fee_bps(&env, flash_fee_bps);

        env.events().publish((symbol_short!("init"),), admin);
        Ok(())
    }

    pub fn set_flash_fee(env: Env, admin: Address, new_fee_bps: i128) -> Result<(), Error> {
        Self::assert_admin(&env, &admin)?;
        if new_fee_bps < 0 || new_fee_bps > 1_000 {
            return Err(Error::InvalidAmount);
        }
        set_flash_loan_fee_bps(&env, new_fee_bps);
        Ok(())
    }

    pub fn set_token_price(
        env: Env,
        admin: Address,
        token: Address,
        price: i128,
    ) -> Result<(), Error> {
        Self::assert_admin(&env, &admin)?;
        if price <= 0 {
            return Err(Error::InvalidAmount);
        }
        set_token_price(&env, &token, price);
        Ok(())
    }

    pub fn set_dex_rate(
        env: Env,
        admin: Address,
        from: Address,
        to: Address,
        rate_bps: i128,
    ) -> Result<(), Error> {
        Self::assert_admin(&env, &admin)?;
        if rate_bps <= 0 {
            return Err(Error::InvalidAmount);
        }
        set_dex_rate(&env, &from, &to, rate_bps);
        Ok(())
    }

    pub fn set_position(
        env: Env,
        admin: Address,
        user: Address,
        token: Address,
        collateral_amount: i128,
        debt_amount: i128,
    ) -> Result<(), Error> {
        Self::assert_admin(&env, &admin)?;
        set_user_collateral(&env, &user, &token, collateral_amount);
        set_user_debt(&env, &user, debt_amount);
        Ok(())
    }

    /// Calculate user health factor: (collateral_value * 10_000) / debt_value
    pub fn get_health_factor(env: Env, user: Address, token: Address) -> PositionHealth {
        let col_amount = get_user_collateral(&env, &user, &token);
        let col_price = get_token_price(&env, &token);
        let col_value = (col_amount * col_price) / PRICE_SCALE;

        let debt_value = get_user_debt(&env, &user);

        let hf_bps = if debt_value <= 0 {
            999_999
        } else {
            (col_value * BPS_SCALE) / debt_value
        };

        PositionHealth {
            collateral_value: col_value,
            debt_value,
            health_factor_bps: hf_bps,
        }
    }

    /// Single atomic transaction to swap underlying collateral without repaying debt first:
    /// 1. Pre-flight health check
    /// 2. Flash borrow new collateral asset
    /// 3. Deposit new collateral into lending pool
    /// 4. Withdraw original collateral from lending pool
    /// 5. Swap original collateral on DEX to repay flash loan + fee
    /// 6. Post-flight health check (ensures HF_final >= HF_initial)
    pub fn execute_collateral_swap(env: Env, params: SwapParams) -> Result<SwapResult, Error> {
        Self::assert_initialized(&env)?;
        params.user.require_auth();

        if params.from_amount <= 0 || params.flash_borrow_amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let cur_from_col = get_user_collateral(&env, &params.user, &params.from_collateral);
        if cur_from_col < params.from_amount {
            return Err(Error::InsufficientLendingCollateral);
        }

        // 1. Initial health factor validation
        let initial_health = Self::get_health_factor(
            env.clone(),
            params.user.clone(),
            params.from_collateral.clone(),
        );
        if initial_health.health_factor_bps < MIN_SOLVENT_HF_BPS {
            return Err(Error::InsolventPosition);
        }

        // 2. Flash loan borrowing
        let flash_fee_bps = get_flash_loan_fee_bps(&env);
        let flash_fee = (params.flash_borrow_amount * flash_fee_bps) / BPS_SCALE;
        let total_repay = params.flash_borrow_amount + flash_fee;

        // 3. Deposit new collateral into lending pool for user
        let cur_to_col = get_user_collateral(&env, &params.user, &params.to_collateral);
        let new_to_col = cur_to_col + params.flash_borrow_amount;
        set_user_collateral(&env, &params.user, &params.to_collateral, new_to_col);

        // 4. Withdraw original collateral from lending pool
        let updated_from_col = cur_from_col - params.from_amount;
        set_user_collateral(
            &env,
            &params.user,
            &params.from_collateral,
            updated_from_col,
        );

        // 5. Swap original collateral on DEX to repay flash loan
        let dex_rate = get_dex_rate(&env, &params.from_collateral, &params.to_collateral);
        let dex_output = (params.from_amount * dex_rate) / BPS_SCALE;

        if dex_output < params.min_dex_output {
            return Err(Error::SlippageExceeded);
        }
        if dex_output < total_repay {
            return Err(Error::FlashLoanRepaymentFailed);
        }

        // Any surplus from swap is deposited as additional collateral
        let surplus = dex_output - total_repay;
        if surplus > 0 {
            let final_to_col =
                get_user_collateral(&env, &params.user, &params.to_collateral) + surplus;
            set_user_collateral(&env, &params.user, &params.to_collateral, final_to_col);
        }

        // 6. Post-flight health factor check: MUST be >= initial health factor
        let final_health = Self::get_health_factor(
            env.clone(),
            params.user.clone(),
            params.to_collateral.clone(),
        );
        if final_health.health_factor_bps < initial_health.health_factor_bps {
            return Err(Error::HealthFactorDecreased);
        }
        if final_health.health_factor_bps < MIN_SOLVENT_HF_BPS {
            return Err(Error::InsolventPosition);
        }

        env.events().publish(
            (symbol_short!("col_swap"),),
            (
                params.user,
                params.from_amount,
                params.flash_borrow_amount,
                final_health.health_factor_bps,
            ),
        );

        Ok(SwapResult {
            from_collateral_withdrawn: params.from_amount,
            to_collateral_deposited: params.flash_borrow_amount + surplus,
            flash_loan_repaid: total_repay,
            initial_health_factor: initial_health.health_factor_bps,
            final_health_factor: final_health.health_factor_bps,
        })
    }

    pub fn get_user_collateral(env: Env, user: Address, token: Address) -> i128 {
        get_user_collateral(&env, &user, &token)
    }

    pub fn get_user_debt(env: Env, user: Address) -> i128 {
        get_user_debt(&env, &user)
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        get_admin(&env)
    }

    fn assert_admin(env: &Env, admin: &Address) -> Result<(), Error> {
        Self::assert_initialized(env)?;
        admin.require_auth();
        let stored_admin = get_admin(env)?;
        if stored_admin != *admin {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    fn assert_initialized(env: &Env) -> Result<(), Error> {
        if !is_initialized(env) {
            return Err(Error::NotInitialized);
        }
        Ok(())
    }
}
