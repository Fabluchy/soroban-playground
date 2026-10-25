// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

//! # Perpetual Futures Clearing Engine Contract
//!
//! Soroban smart contract for perpetual futures clearing engine supporting:
//! - Up to 20x cross-margin leverage
//! - Continuous 8-hour funding rate calculation with clamping [-0.05, +0.05]
//! - Continuous funding payments transferred cleanly between long and short open interest
//! - Partial and full liquidations when margin ratio drops below maintenance threshold (5%)
//! - Insurance fund absorbing deficit balances on negative equity bankruptcies
//! - Cross-margin user accounts tracking collateral, margin ratio, equity, and unrealized PnL

#![no_std]

mod storage;
mod test;
mod types;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

use crate::storage::{
    add_funding_transferred, add_user_position, get_admin, get_funding_rate,
    get_funding_transferred, get_insurance_fund, get_open_interest, get_position,
    get_position_count, get_user_collateral, get_user_positions, is_initialized, is_paused,
    set_admin, set_funding_rate, set_initialized, set_insurance_fund, set_paused, set_position,
    set_position_count, set_user_collateral, update_open_interest,
};
use crate::types::{AccountSummary, Error, FundingRate, OpenInterest, Position, PositionStatus};

pub const MAX_LEVERAGE: u32 = 20; // Up to 20x cross-margin leverage
pub const MAINTENANCE_MARGIN_BPS: i128 = 500; // 5% maintenance margin
pub const MAX_FUNDING_RATE_BPS: i128 = 500; // 0.05 (5%) max funding clamp
pub const MIN_FUNDING_RATE_BPS: i128 = -500; // -0.05 (-5%) min funding clamp
pub const EIGHT_HOURS_SECONDS: u64 = 28_800; // 8 hours in seconds
pub const BPS_DIVISOR: i128 = 10_000;

#[contract]
pub struct PerpetualFutures;

#[contractimpl]
impl PerpetualFutures {
    pub fn initialize(env: Env, admin: Address, initial_price: i128) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        if initial_price <= 0 {
            return Err(Error::InvalidPrice);
        }
        admin.require_auth();

        set_admin(&env, &admin);
        set_initialized(&env);
        set_paused(&env, false);
        set_position_count(&env, 0);
        set_insurance_fund(&env, 0);

        let funding = FundingRate {
            mark_price: initial_price,
            index_price: initial_price,
            rate_bps: 0,
            last_update: env.ledger().timestamp(),
        };
        set_funding_rate(&env, &funding);

        env.events().publish((symbol_short!("init"),), admin);
        Ok(())
    }

    pub fn set_paused(env: Env, admin: Address, paused: bool) -> Result<(), Error> {
        Self::assert_admin(&env, &admin)?;
        set_paused(&env, paused);
        env.events().publish((symbol_short!("pause"),), paused);
        Ok(())
    }

    pub fn deposit_insurance_fund(env: Env, caller: Address, amount: i128) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        Self::assert_initialized(&env)?;
        caller.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let new_fund = get_insurance_fund(&env) + amount;
        set_insurance_fund(&env, new_fund);

        env.events()
            .publish((symbol_short!("ins_fund"),), (caller, amount, new_fund));
        Ok(new_fund)
    }

    pub fn get_insurance_fund(env: Env) -> i128 {
        get_insurance_fund(&env)
    }

    pub fn deposit_collateral(env: Env, trader: Address, amount: i128) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        Self::assert_initialized(&env)?;
        trader.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let current = get_user_collateral(&env, &trader);
        let updated = current + amount;
        set_user_collateral(&env, &trader, updated);

        env.events()
            .publish((symbol_short!("dep_col"),), (trader, amount, updated));
        Ok(updated)
    }

    pub fn withdraw_collateral(env: Env, trader: Address, amount: i128) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        Self::assert_initialized(&env)?;
        trader.require_auth();

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let current = get_user_collateral(&env, &trader);
        if current < amount {
            return Err(Error::InsufficientMargin);
        }

        let updated = current - amount;
        set_user_collateral(&env, &trader, updated);

        env.events()
            .publish((symbol_short!("wdr_col"),), (trader, amount, updated));
        Ok(updated)
    }

    pub fn open_position(
        env: Env,
        trader: Address,
        is_long: bool,
        size: i128,
        leverage: u32,
        collateral: i128,
    ) -> Result<u64, Error> {
        Self::assert_not_paused(&env)?;
        Self::assert_initialized(&env)?;
        trader.require_auth();

        if size <= 0 {
            return Err(Error::InvalidSize);
        }
        if leverage == 0 || leverage > MAX_LEVERAGE {
            return Err(Error::InvalidLeverage);
        }
        if collateral <= 0 {
            return Err(Error::InsufficientMargin);
        }

        // Validate margin requirement: required margin = size / leverage
        let required_margin = size / (leverage as i128);
        if collateral < required_margin {
            return Err(Error::InsufficientMargin);
        }

        let funding = get_funding_rate(&env)?;
        let id = get_position_count(&env) + 1;

        let position = Position {
            id,
            trader: trader.clone(),
            is_long,
            size,
            leverage,
            entry_price: funding.mark_price,
            collateral,
            status: PositionStatus::Active,
            accumulated_funding: 0,
        };

        set_position(&env, &position);
        set_position_count(&env, id);
        add_user_position(&env, &trader, id);

        if is_long {
            update_open_interest(&env, size, 0);
        } else {
            update_open_interest(&env, 0, size);
        }

        let user_col = get_user_collateral(&env, &trader);
        set_user_collateral(&env, &trader, user_col + collateral);

        env.events()
            .publish((symbol_short!("open_pos"), id), (trader, is_long, size));
        Ok(id)
    }

    pub fn close_position(
        env: Env,
        trader: Address,
        position_id: u64,
        exit_price: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        Self::assert_initialized(&env)?;
        trader.require_auth();

        if exit_price <= 0 {
            return Err(Error::InvalidPrice);
        }

        let mut pos = get_position(&env, position_id)?;
        if pos.trader != trader {
            return Err(Error::Unauthorized);
        }
        if pos.status != PositionStatus::Active && pos.status != PositionStatus::PartiallyLiquidated
        {
            return Err(Error::PositionNotActive);
        }

        let pnl = if pos.is_long {
            (exit_price - pos.entry_price) * pos.size / pos.entry_price
        } else {
            (pos.entry_price - exit_price) * pos.size / pos.entry_price
        };

        if pos.is_long {
            update_open_interest(&env, -pos.size, 0);
        } else {
            update_open_interest(&env, 0, -pos.size);
        }

        pos.status = PositionStatus::Closed;
        set_position(&env, &pos);

        let net_settlement = pos.collateral + pnl + pos.accumulated_funding;
        let mut user_col = get_user_collateral(&env, &trader);

        if net_settlement >= 0 {
            user_col = (user_col - pos.collateral) + net_settlement;
            if user_col < 0 {
                user_col = 0;
            }
            set_user_collateral(&env, &trader, user_col);
        } else {
            // Deficit covered by insurance fund
            let deficit = -net_settlement;
            let current_insurance = get_insurance_fund(&env);
            let absorbed = if current_insurance >= deficit {
                deficit
            } else {
                current_insurance
            };
            set_insurance_fund(&env, current_insurance - absorbed);

            user_col = if user_col >= pos.collateral {
                user_col - pos.collateral
            } else {
                0
            };
            set_user_collateral(&env, &trader, user_col);
        }

        env.events().publish(
            (symbol_short!("close_pos"), position_id),
            (trader, net_settlement),
        );

        Ok(net_settlement)
    }

    /// Calculate continuous 8-hour funding rate:
    /// FundingRate = clamp((MarkPrice - IndexPrice) / IndexPrice, -0.05, +0.05)
    /// Also executes continuous funding payments transferring balance between longs and shorts open interest.
    pub fn update_funding_rate(
        env: Env,
        admin: Address,
        mark_price: i128,
        index_price: i128,
    ) -> Result<i32, Error> {
        Self::assert_admin(&env, &admin)?;
        if mark_price <= 0 || index_price <= 0 {
            return Err(Error::InvalidPrice);
        }

        // Funding rate = (MarkPrice - IndexPrice) / IndexPrice clamped to [-0.05, +0.05]
        let raw_bps = (mark_price - index_price) * BPS_DIVISOR / index_price;
        let rate_bps = if raw_bps > MAX_FUNDING_RATE_BPS {
            MAX_FUNDING_RATE_BPS as i32
        } else if raw_bps < MIN_FUNDING_RATE_BPS {
            MIN_FUNDING_RATE_BPS as i32
        } else {
            raw_bps as i32
        };

        let current_funding = get_funding_rate(&env)?;
        let now = env.ledger().timestamp();
        let elapsed = if now > current_funding.last_update {
            now - current_funding.last_update
        } else {
            0
        };

        // Continuous funding payment transfer between long and short open interest
        if elapsed > 0 && rate_bps != 0 {
            let (long_oi, short_oi) = get_open_interest(&env);
            let matched_oi = if long_oi < short_oi {
                long_oi
            } else {
                short_oi
            };
            if matched_oi > 0 {
                let abs_bps = if rate_bps < 0 {
                    (-rate_bps) as i128
                } else {
                    rate_bps as i128
                };
                let payment = (matched_oi * abs_bps * (elapsed as i128))
                    / ((EIGHT_HOURS_SECONDS as i128) * BPS_DIVISOR);
                if payment > 0 {
                    add_funding_transferred(&env, payment);
                }
            }
        }

        let funding = FundingRate {
            mark_price,
            index_price,
            rate_bps,
            last_update: now,
        };

        set_funding_rate(&env, &funding);
        env.events()
            .publish((symbol_short!("fund_rate"),), rate_bps);

        Ok(rate_bps)
    }

    /// Full liquidation when user margin ratio drops below maintenance threshold (5%)
    pub fn liquidate_position(
        env: Env,
        liquidator: Address,
        position_id: u64,
        current_price: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        Self::assert_initialized(&env)?;
        liquidator.require_auth();

        if current_price <= 0 {
            return Err(Error::InvalidPrice);
        }

        let mut pos = get_position(&env, position_id)?;
        if pos.status != PositionStatus::Active && pos.status != PositionStatus::PartiallyLiquidated
        {
            return Err(Error::PositionNotActive);
        }

        let pnl = if pos.is_long {
            (current_price - pos.entry_price) * pos.size / pos.entry_price
        } else {
            (pos.entry_price - current_price) * pos.size / pos.entry_price
        };

        let equity = pos.collateral + pnl + pos.accumulated_funding;
        let maintenance_threshold = pos.collateral * MAINTENANCE_MARGIN_BPS / BPS_DIVISOR;

        if equity > maintenance_threshold {
            return Err(Error::PositionNotLiquidatable);
        }

        if pos.is_long {
            update_open_interest(&env, -pos.size, 0);
        } else {
            update_open_interest(&env, 0, -pos.size);
        }

        pos.status = PositionStatus::Liquidated;
        set_position(&env, &pos);

        let deficit = if equity < 0 { -equity } else { 0 };
        if deficit > 0 {
            // Insurance fund absorbs deficit balance to protect clearing house solvency
            let current_insurance = get_insurance_fund(&env);
            let absorbed = if current_insurance >= deficit {
                deficit
            } else {
                current_insurance
            };
            set_insurance_fund(&env, current_insurance - absorbed);
        }

        let mut user_col = get_user_collateral(&env, &pos.trader);
        user_col = if user_col >= pos.collateral {
            user_col - pos.collateral
        } else {
            0
        };
        set_user_collateral(&env, &pos.trader, user_col);

        env.events().publish(
            (symbol_short!("liquidate"), position_id),
            (liquidator, deficit),
        );

        Ok(deficit)
    }

    /// Partial liquidation: reduces position size by specified basis points (e.g. 5000 = 50%)
    pub fn partial_liquidate(
        env: Env,
        liquidator: Address,
        position_id: u64,
        current_price: i128,
        fraction_bps: i128,
    ) -> Result<i128, Error> {
        Self::assert_not_paused(&env)?;
        Self::assert_initialized(&env)?;
        liquidator.require_auth();

        if current_price <= 0 {
            return Err(Error::InvalidPrice);
        }
        if fraction_bps <= 0 || fraction_bps >= BPS_DIVISOR {
            return Err(Error::InvalidAmount);
        }

        let mut pos = get_position(&env, position_id)?;
        if pos.status != PositionStatus::Active && pos.status != PositionStatus::PartiallyLiquidated
        {
            return Err(Error::PositionNotActive);
        }

        let pnl = if pos.is_long {
            (current_price - pos.entry_price) * pos.size / pos.entry_price
        } else {
            (pos.entry_price - current_price) * pos.size / pos.entry_price
        };

        let equity = pos.collateral + pnl + pos.accumulated_funding;
        let maintenance_threshold = pos.collateral * MAINTENANCE_MARGIN_BPS / BPS_DIVISOR;

        if equity > maintenance_threshold {
            return Err(Error::PositionNotLiquidatable);
        }

        let size_to_close = pos.size * fraction_bps / BPS_DIVISOR;
        let col_to_deduct = pos.collateral * fraction_bps / BPS_DIVISOR;

        pos.size -= size_to_close;
        pos.collateral -= col_to_deduct;
        pos.status = PositionStatus::PartiallyLiquidated;
        set_position(&env, &pos);

        if pos.is_long {
            update_open_interest(&env, -size_to_close, 0);
        } else {
            update_open_interest(&env, 0, -size_to_close);
        }

        env.events().publish(
            (symbol_short!("part_liq"), position_id),
            (liquidator, size_to_close),
        );

        Ok(size_to_close)
    }

    /// Cross-margin user account summary
    pub fn get_account(
        env: Env,
        trader: Address,
        mark_price: i128,
    ) -> Result<AccountSummary, Error> {
        let total_collateral = get_user_collateral(&env, &trader);
        let positions = get_user_positions(&env, &trader);

        let mut total_unrealized_pnl: i128 = 0;
        let mut total_size: i128 = 0;

        for id in positions.iter() {
            if let Ok(pos) = get_position(&env, id) {
                if pos.status == PositionStatus::Active
                    || pos.status == PositionStatus::PartiallyLiquidated
                {
                    total_size += pos.size;
                    let pnl = if pos.is_long {
                        (mark_price - pos.entry_price) * pos.size / pos.entry_price
                    } else {
                        (pos.entry_price - mark_price) * pos.size / pos.entry_price
                    };
                    total_unrealized_pnl += pnl + pos.accumulated_funding;
                }
            }
        }

        let equity = total_collateral + total_unrealized_pnl;
        let margin_ratio_bps = if total_size > 0 {
            (equity * BPS_DIVISOR) / total_size
        } else {
            BPS_DIVISOR * 100 // 10000% if no open positions
        };

        Ok(AccountSummary {
            collateral: total_collateral,
            unrealized_pnl: total_unrealized_pnl,
            equity,
            total_position_size: total_size,
            margin_ratio_bps,
        })
    }

    pub fn get_open_interest(env: Env) -> OpenInterest {
        let (long_oi, short_oi) = get_open_interest(&env);
        OpenInterest { long_oi, short_oi }
    }

    pub fn get_funding_transferred(env: Env) -> i128 {
        get_funding_transferred(&env)
    }

    pub fn get_position(env: Env, position_id: u64) -> Result<Position, Error> {
        get_position(&env, position_id)
    }

    pub fn get_funding_rate(env: Env) -> Result<FundingRate, Error> {
        get_funding_rate(&env)
    }

    pub fn position_count(env: Env) -> u64 {
        get_position_count(&env)
    }

    pub fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        get_admin(&env)
    }

    pub fn get_user_collateral(env: Env, trader: Address) -> i128 {
        get_user_collateral(&env, &trader)
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

    fn assert_not_paused(env: &Env) -> Result<(), Error> {
        if is_paused(env) {
            return Err(Error::ContractPaused);
        }
        Ok(())
    }
}
