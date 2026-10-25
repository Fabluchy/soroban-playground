#![no_std]

use soroban_sdk::{Address, Env};
use crate::types::{DataKey, Error, InstanceKey, PoolState, Position, TrancheClass};

// ── Init ──────────────────────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&InstanceKey::Initialized)
}

pub fn set_initialized(env: &Env) {
    env.storage().instance().set(&InstanceKey::Initialized, &true);
}

// ── Pool ──────────────────────────────────────────────────────────────────────

pub fn get_pool(env: &Env) -> Result<PoolState, Error> {
    env.storage()
        .instance()
        .get(&InstanceKey::Pool)
        .ok_or(Error::NotInitialized)
}

pub fn save_pool(env: &Env, pool: &PoolState) {
    env.storage().instance().set(&InstanceKey::Pool, pool);
}

// ── Whitelist ─────────────────────────────────────────────────────────────────

pub fn is_whitelisted(env: &Env, investor: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Whitelisted(investor.clone()))
        .unwrap_or(false)
}

pub fn set_whitelist(env: &Env, investor: &Address, allowed: bool) {
    env.storage()
        .persistent()
        .set(&DataKey::Whitelisted(investor.clone()), &allowed);
}

// ── Positions ─────────────────────────────────────────────────────────────────

pub fn get_position(
    env: &Env,
    investor: &Address,
    tranche: TrancheClass,
) -> Option<Position> {
    env.storage()
        .persistent()
        .get(&DataKey::Position(investor.clone(), tranche))
}

pub fn save_position(env: &Env, pos: &Position) {
    env.storage()
        .persistent()
        .set(&DataKey::Position(pos.investor.clone(), pos.tranche), pos);
}

pub fn remove_position(env: &Env, investor: &Address, tranche: TrancheClass) {
    env.storage()
        .persistent()
        .remove(&DataKey::Position(investor.clone(), tranche));
}

// ── Investor list ─────────────────────────────────────────────────────────────

pub fn get_investor_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&InstanceKey::InvestorCount)
        .unwrap_or(0)
}

pub fn add_investor_slot(env: &Env, investor: &Address) {
    let count = get_investor_count(env);
    env.storage()
        .persistent()
        .set(&DataKey::InvestorAt(count), investor);
    env.storage()
        .instance()
        .set(&InstanceKey::InvestorCount, &(count + 1));
}
