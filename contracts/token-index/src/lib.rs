// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

//! # On-Chain Token Benchmark Index Contract
//!
//! Tracks aggregate capitalization and performance of top ecosystem tokens using
//! Laspeyres indexing formula:
//! Index_t = (sum(P_i,t * Q_i,0) / D_t) * 1000
//! Supports continuous oracle ingestion, automatic divisor adjustments during token
//! rebalancing or supply changes, and historical daily/weekly snapshots.

#![no_std]

mod storage;
mod test;
mod types;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol, Vec};

use crate::storage::{
    get_admin, get_daily_snapshot, get_daily_snapshot_count, get_divisor, get_latest_snapshot_time,
    get_oracle, get_token_info, get_token_list, get_weekly_snapshot, get_weekly_snapshot_count,
    is_initialized, remove_token_info, set_admin, set_daily_snapshot, set_daily_snapshot_count,
    set_divisor, set_initialized, set_latest_snapshot_time, set_oracle, set_token_info,
    set_token_list, set_weekly_snapshot, set_weekly_snapshot_count,
};
use crate::types::{Error, IndexSnapshot, IndexSummary, TokenInfo};

pub const MAX_TOKENS: u32 = 10;
pub const BASE_INDEX_MULTIPLIER: i128 = 1_000;
pub const SECONDS_PER_DAY: u64 = 86_400;
pub const SECONDS_PER_WEEK: u64 = 604_800;

#[contract]
pub struct TokenIndex;

#[contractimpl]
impl TokenIndex {
    pub fn initialize(env: Env, admin: Address, oracle: Address) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        set_admin(&env, &admin);
        set_oracle(&env, &oracle);
        set_initialized(&env);
        set_divisor(&env, 0);
        set_daily_snapshot_count(&env, 0);
        set_weekly_snapshot_count(&env, 0);
        set_latest_snapshot_time(&env, env.ledger().timestamp());

        env.events().publish((symbol_short!("init"),), admin);
        Ok(())
    }

    pub fn set_oracle(env: Env, admin: Address, new_oracle: Address) -> Result<(), Error> {
        Self::assert_admin(&env, &admin)?;
        set_oracle(&env, &new_oracle);
        env.events().publish((symbol_short!("oracle"),), new_oracle);
        Ok(())
    }

    /// Add a new token into the benchmark index with divisor adjustment to preserve continuity
    pub fn add_token(
        env: Env,
        admin: Address,
        token: Address,
        symbol: Symbol,
        initial_price: i128,
        initial_supply: i128,
    ) -> Result<i128, Error> {
        Self::assert_admin(&env, &admin)?;
        if initial_price <= 0 {
            return Err(Error::InvalidPrice);
        }
        if initial_supply <= 0 {
            return Err(Error::InvalidSupply);
        }

        let mut token_list = get_token_list(&env);
        if token_list.len() >= MAX_TOKENS {
            return Err(Error::MaxTokensExceeded);
        }
        for t in token_list.iter() {
            if t == token {
                return Err(Error::TokenAlreadyExists);
            }
        }

        let added_cap = initial_price * initial_supply;
        let old_divisor = get_divisor(&env);

        let new_divisor = if token_list.is_empty() || old_divisor == 0 {
            added_cap
        } else {
            let cap_before = Self::calculate_market_cap(&env);
            if cap_before <= 0 {
                return Err(Error::ZeroMarketCap);
            }
            let cap_after = cap_before + added_cap;
            // Divisor adjustment: D_new = D_old * (Cap_after / Cap_before)
            (old_divisor * cap_after) / cap_before
        };

        set_divisor(&env, new_divisor);

        let token_info = TokenInfo {
            token: token.clone(),
            symbol,
            base_price: initial_price,
            base_supply: initial_supply,
            current_price: initial_price,
            current_supply: initial_supply,
            last_update: env.ledger().timestamp(),
        };

        set_token_info(&env, &token_info);
        token_list.push_back(token.clone());
        set_token_list(&env, &token_list);

        env.events()
            .publish((symbol_short!("add_tok"),), (token, new_divisor));
        Ok(new_divisor)
    }

    /// Remove a token from the benchmark index with divisor adjustment to preserve continuity
    pub fn remove_token(env: Env, admin: Address, token: Address) -> Result<i128, Error> {
        Self::assert_admin(&env, &admin)?;

        let token_info = get_token_info(&env, &token)?;
        let mut token_list = get_token_list(&env);
        let mut index_to_remove: Option<u32> = None;

        for i in 0..token_list.len() {
            if token_list.get(i).unwrap() == token {
                index_to_remove = Some(i);
                break;
            }
        }

        let idx = index_to_remove.ok_or(Error::TokenNotFound)?;
        token_list.remove(idx);
        set_token_list(&env, &token_list);
        remove_token_info(&env, &token);

        let cap_before =
            Self::calculate_market_cap(&env) + (token_info.current_price * token_info.base_supply);
        let old_divisor = get_divisor(&env);

        let new_divisor = if token_list.is_empty() {
            0
        } else {
            let cap_after = cap_before - (token_info.current_price * token_info.base_supply);
            if cap_before <= 0 {
                return Err(Error::ZeroMarketCap);
            }
            (old_divisor * cap_after) / cap_before
        };

        set_divisor(&env, new_divisor);

        env.events()
            .publish((symbol_short!("rem_tok"),), (token, new_divisor));
        Ok(new_divisor)
    }

    /// Adjust supply with divisor adjustment
    pub fn update_token_supply(
        env: Env,
        admin: Address,
        token: Address,
        new_supply: i128,
    ) -> Result<i128, Error> {
        Self::assert_admin(&env, &admin)?;
        if new_supply <= 0 {
            return Err(Error::InvalidSupply);
        }

        let mut token_info = get_token_info(&env, &token)?;
        let cap_before = Self::calculate_market_cap(&env);
        let old_divisor = get_divisor(&env);

        let delta_cap = token_info.current_price * (new_supply - token_info.base_supply);
        let cap_after = cap_before + delta_cap;

        if cap_before <= 0 {
            return Err(Error::ZeroMarketCap);
        }

        let new_divisor = (old_divisor * cap_after) / cap_before;
        set_divisor(&env, new_divisor);

        token_info.base_supply = new_supply;
        token_info.current_supply = new_supply;
        token_info.last_update = env.ledger().timestamp();
        set_token_info(&env, &token_info);

        env.events()
            .publish((symbol_short!("upd_sup"),), (token, new_divisor));
        Ok(new_divisor)
    }

    /// Oracle ingests real-time prices for top tokens
    pub fn update_prices(
        env: Env,
        caller: Address,
        tokens: Vec<Address>,
        prices: Vec<i128>,
    ) -> Result<(), Error> {
        Self::assert_oracle_or_admin(&env, &caller)?;
        if tokens.len() != prices.len() {
            return Err(Error::ArrayMismatch);
        }

        let now = env.ledger().timestamp();
        for i in 0..tokens.len() {
            let tok = tokens.get(i).unwrap();
            let price = prices.get(i).unwrap();
            if price <= 0 {
                return Err(Error::InvalidPrice);
            }

            if let Ok(mut info) = get_token_info(&env, &tok) {
                info.current_price = price;
                info.last_update = now;
                set_token_info(&env, &info);
            }
        }

        env.events()
            .publish((symbol_short!("upd_prc"),), tokens.len());
        Ok(())
    }

    /// Calculate Laspeyres benchmark index value:
    /// Index_t = (sum(P_i,t * Q_i,0) / D_t) * 1000
    pub fn calculate_index(env: Env) -> i128 {
        let divisor = get_divisor(&env);
        if divisor <= 0 {
            return 0;
        }

        let market_cap = Self::calculate_market_cap(&env);
        (market_cap * BASE_INDEX_MULTIPLIER) / divisor
    }

    /// Public read interface for external DApps and derivative contracts
    pub fn get_index(env: Env) -> i128 {
        Self::calculate_index(env)
    }

    /// Record historical snapshot (daily or weekly if intervals have elapsed)
    pub fn record_snapshot(env: Env, caller: Address) -> Result<IndexSnapshot, Error> {
        Self::assert_initialized(&env)?;
        caller.require_auth();

        let index_val = Self::calculate_index(env.clone());
        let cap = Self::calculate_market_cap(&env);
        let divisor = get_divisor(&env);
        let now = env.ledger().timestamp();

        let snapshot = IndexSnapshot {
            timestamp: now,
            index_value: index_val,
            market_cap: cap,
            divisor,
        };

        let last_time = get_latest_snapshot_time(&env);
        if now >= last_time + SECONDS_PER_DAY {
            let d_count = get_daily_snapshot_count(&env) + 1;
            set_daily_snapshot(&env, d_count, &snapshot);
            set_daily_snapshot_count(&env, d_count);
        }

        if now >= last_time + SECONDS_PER_WEEK {
            let w_count = get_weekly_snapshot_count(&env) + 1;
            set_weekly_snapshot(&env, w_count, &snapshot);
            set_weekly_snapshot_count(&env, w_count);
        }

        set_latest_snapshot_time(&env, now);

        env.events()
            .publish((symbol_short!("snapshot"),), (now, index_val));
        Ok(snapshot)
    }

    pub fn get_daily_snapshot(env: Env, snapshot_id: u64) -> Result<IndexSnapshot, Error> {
        get_daily_snapshot(&env, snapshot_id)
    }

    pub fn get_weekly_snapshot(env: Env, snapshot_id: u64) -> Result<IndexSnapshot, Error> {
        get_weekly_snapshot(&env, snapshot_id)
    }

    pub fn get_index_summary(env: Env) -> IndexSummary {
        let current_index = Self::calculate_index(env.clone());
        let divisor = get_divisor(&env);
        let market_cap = Self::calculate_market_cap(&env);
        let token_count = get_token_list(&env).len();
        let last_snapshot = get_latest_snapshot_time(&env);

        IndexSummary {
            index_value: current_index,
            divisor,
            market_cap,
            token_count,
            last_snapshot_timestamp: last_snapshot,
        }
    }

    pub fn get_token(env: Env, token: Address) -> Result<TokenInfo, Error> {
        get_token_info(&env, &token)
    }

    pub fn get_tokens(env: Env) -> Vec<Address> {
        get_token_list(&env)
    }

    pub fn get_divisor(env: Env) -> i128 {
        get_divisor(&env)
    }

    pub fn get_oracle(env: Env) -> Result<Address, Error> {
        get_oracle(&env)
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        get_admin(&env)
    }

    fn calculate_market_cap(env: &Env) -> i128 {
        let tokens = get_token_list(env);
        let mut total: i128 = 0;
        for t in tokens.iter() {
            if let Ok(info) = get_token_info(env, &t) {
                total += info.current_price * info.base_supply;
            }
        }
        total
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

    fn assert_oracle_or_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        Self::assert_initialized(env)?;
        caller.require_auth();
        let oracle = get_oracle(env)?;
        let admin = get_admin(env)?;
        if *caller != oracle && *caller != admin {
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
