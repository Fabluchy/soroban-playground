// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

use crate::types::{Error, IndexSnapshot, TokenInfo};
use soroban_sdk::{contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Initialized,
    Oracle,
    Divisor,
    TokenList,
    Token(Address),
    DailySnapshot(u64),
    WeeklySnapshot(u64),
    DailySnapshotCount,
    WeeklySnapshotCount,
    LatestSnapshotTime,
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

pub fn get_oracle(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&DataKey::Oracle)
        .ok_or(Error::NotInitialized)
}

pub fn set_oracle(env: &Env, oracle: &Address) {
    env.storage().instance().set(&DataKey::Oracle, oracle);
}

pub fn get_divisor(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::Divisor).unwrap_or(0)
}

pub fn set_divisor(env: &Env, divisor: i128) {
    env.storage().instance().set(&DataKey::Divisor, &divisor);
}

pub fn get_token_list(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::TokenList)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_token_list(env: &Env, list: &Vec<Address>) {
    env.storage().instance().set(&DataKey::TokenList, list);
}

pub fn get_token_info(env: &Env, token: &Address) -> Result<TokenInfo, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Token(token.clone()))
        .ok_or(Error::TokenNotFound)
}

pub fn set_token_info(env: &Env, info: &TokenInfo) {
    env.storage()
        .persistent()
        .set(&DataKey::Token(info.token.clone()), info);
}

pub fn remove_token_info(env: &Env, token: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Token(token.clone()));
}

pub fn get_daily_snapshot(env: &Env, id: u64) -> Result<IndexSnapshot, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::DailySnapshot(id))
        .ok_or(Error::SnapshotNotFound)
}

pub fn set_daily_snapshot(env: &Env, id: u64, snapshot: &IndexSnapshot) {
    env.storage()
        .persistent()
        .set(&DataKey::DailySnapshot(id), snapshot);
}

pub fn get_weekly_snapshot(env: &Env, id: u64) -> Result<IndexSnapshot, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::WeeklySnapshot(id))
        .ok_or(Error::SnapshotNotFound)
}

pub fn set_weekly_snapshot(env: &Env, id: u64, snapshot: &IndexSnapshot) {
    env.storage()
        .persistent()
        .set(&DataKey::WeeklySnapshot(id), snapshot);
}

pub fn get_daily_snapshot_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::DailySnapshotCount)
        .unwrap_or(0)
}

pub fn set_daily_snapshot_count(env: &Env, count: u64) {
    env.storage()
        .instance()
        .set(&DataKey::DailySnapshotCount, &count);
}

pub fn get_weekly_snapshot_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::WeeklySnapshotCount)
        .unwrap_or(0)
}

pub fn set_weekly_snapshot_count(env: &Env, count: u64) {
    env.storage()
        .instance()
        .set(&DataKey::WeeklySnapshotCount, &count);
}

pub fn get_latest_snapshot_time(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::LatestSnapshotTime)
        .unwrap_or(0)
}

pub fn set_latest_snapshot_time(env: &Env, time: u64) {
    env.storage()
        .instance()
        .set(&DataKey::LatestSnapshotTime, &time);
}
