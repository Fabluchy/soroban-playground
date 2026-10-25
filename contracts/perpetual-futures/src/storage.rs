// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

use crate::types::{Error, FundingRate, Position};
use soroban_sdk::{contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Initialized,
    Paused,
    PositionCount,
    Position(u64),
    FundingRate,
    InsuranceFund,
    UserCollateral(Address),
    UserPositions(Address),
    LongOpenInterest,
    ShortOpenInterest,
    FundingTransferred,
}

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Initialized)
}

pub fn set_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Initialized, &true);
}

pub fn get_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(Error::NotInitialized)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn get_position_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::PositionCount)
        .unwrap_or(0)
}

pub fn set_position_count(env: &Env, count: u64) {
    env.storage()
        .instance()
        .set(&DataKey::PositionCount, &count);
}

pub fn get_position(env: &Env, id: u64) -> Result<Position, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Position(id))
        .ok_or(Error::PositionNotFound)
}

pub fn set_position(env: &Env, position: &Position) {
    env.storage()
        .persistent()
        .set(&DataKey::Position(position.id), position);
}

pub fn get_funding_rate(env: &Env) -> Result<FundingRate, Error> {
    env.storage()
        .instance()
        .get(&DataKey::FundingRate)
        .ok_or(Error::NotInitialized)
}

pub fn set_funding_rate(env: &Env, rate: &FundingRate) {
    env.storage().instance().set(&DataKey::FundingRate, rate);
}

pub fn get_insurance_fund(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::InsuranceFund)
        .unwrap_or(0)
}

pub fn set_insurance_fund(env: &Env, amount: i128) {
    env.storage()
        .instance()
        .set(&DataKey::InsuranceFund, &amount);
}

pub fn get_user_collateral(env: &Env, trader: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::UserCollateral(trader.clone()))
        .unwrap_or(0)
}

pub fn set_user_collateral(env: &Env, trader: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::UserCollateral(trader.clone()), &amount);
}

pub fn get_user_positions(env: &Env, trader: &Address) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&DataKey::UserPositions(trader.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn add_user_position(env: &Env, trader: &Address, position_id: u64) {
    let mut list = get_user_positions(env, trader);
    list.push_back(position_id);
    env.storage()
        .persistent()
        .set(&DataKey::UserPositions(trader.clone()), &list);
}

pub fn get_open_interest(env: &Env) -> (i128, i128) {
    let long_oi: i128 = env
        .storage()
        .instance()
        .get(&DataKey::LongOpenInterest)
        .unwrap_or(0);
    let short_oi: i128 = env
        .storage()
        .instance()
        .get(&DataKey::ShortOpenInterest)
        .unwrap_or(0);
    (long_oi, short_oi)
}

pub fn update_open_interest(env: &Env, delta_long: i128, delta_short: i128) {
    let (mut long_oi, mut short_oi) = get_open_interest(env);
    long_oi += delta_long;
    short_oi += delta_short;
    if long_oi < 0 {
        long_oi = 0;
    }
    if short_oi < 0 {
        short_oi = 0;
    }
    env.storage()
        .instance()
        .set(&DataKey::LongOpenInterest, &long_oi);
    env.storage()
        .instance()
        .set(&DataKey::ShortOpenInterest, &short_oi);
}

pub fn get_funding_transferred(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::FundingTransferred)
        .unwrap_or(0)
}

pub fn add_funding_transferred(env: &Env, delta: i128) {
    let current = get_funding_transferred(env);
    env.storage()
        .instance()
        .set(&DataKey::FundingTransferred, &(current + delta));
}
