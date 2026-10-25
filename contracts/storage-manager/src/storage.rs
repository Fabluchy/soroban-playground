#![no_std]

use soroban_sdk::{Address, Env};
use crate::types::{DataKey, Error, InstanceKey, ManagedKey, TempKey};

// ── Init ──────────────────────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&InstanceKey::Initialized)
}

pub fn set_initialized(env: &Env) {
    env.storage()
        .instance()
        .set(&InstanceKey::Initialized, &true);
}

// ── Admin ─────────────────────────────────────────────────────────────────────

pub fn get_admin(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&InstanceKey::Admin)
        .ok_or(Error::NotInitialized)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&InstanceKey::Admin, admin);
}

// ── Config ────────────────────────────────────────────────────────────────────

pub fn get_crank_reward(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&InstanceKey::CrankRewardStroops)
        .unwrap_or(0)
}

pub fn set_crank_reward(env: &Env, stroops: i128) {
    env.storage()
        .instance()
        .set(&InstanceKey::CrankRewardStroops, &stroops);
}

pub fn get_max_extension(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&InstanceKey::MaxExtensionLedgers)
        .unwrap_or(535_680) // ~1 year at ~5s/ledger
}

pub fn set_max_extension(env: &Env, ledgers: u32) {
    env.storage()
        .instance()
        .set(&InstanceKey::MaxExtensionLedgers, &ledgers);
}

// ── Managed keys ──────────────────────────────────────────────────────────────

pub fn get_key_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&InstanceKey::KeyCount)
        .unwrap_or(0)
}

pub fn inc_key_count(env: &Env) -> u32 {
    let c = get_key_count(env);
    env.storage()
        .instance()
        .set(&InstanceKey::KeyCount, &(c + 1));
    c
}

pub fn get_managed_key(env: &Env, id: u32) -> Result<ManagedKey, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::ManagedKey(id))
        .ok_or(Error::KeyNotFound)
}

pub fn save_managed_key(env: &Env, key: &ManagedKey) {
    env.storage()
        .persistent()
        .set(&DataKey::ManagedKey(key.id), key);
}

// ── Crank balance ─────────────────────────────────────────────────────────────

pub fn get_crank_balance(env: &Env, crank: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::CrankBalance(crank.clone()))
        .unwrap_or(0)
}

pub fn add_crank_balance(env: &Env, crank: &Address, amount: i128) {
    let current = get_crank_balance(env, crank);
    let new_bal = current.saturating_add(amount);
    env.storage()
        .persistent()
        .set(&DataKey::CrankBalance(crank.clone()), &new_bal);
}

pub fn reset_crank_balance(env: &Env, crank: &Address) {
    env.storage()
        .persistent()
        .set(&DataKey::CrankBalance(crank.clone()), &0i128);
}

// ── Temporary nonces ──────────────────────────────────────────────────────────

pub fn get_nonce(env: &Env, user: &Address) -> u64 {
    env.storage()
        .temporary()
        .get(&TempKey::Nonce(user.clone()))
        .unwrap_or(0)
}

pub fn set_nonce(env: &Env, user: &Address, nonce: u64, ttl_ledgers: u32) {
    env.storage()
        .temporary()
        .set(&TempKey::Nonce(user.clone()), &nonce);
    env.storage()
        .temporary()
        .extend_ttl(&TempKey::Nonce(user.clone()), ttl_ledgers, ttl_ledgers);
}

// ── Flash-loan locks ──────────────────────────────────────────────────────────

pub fn is_flash_locked(env: &Env, user: &Address) -> bool {
    env.storage()
        .temporary()
        .get(&TempKey::FlashLock(user.clone()))
        .unwrap_or(false)
}

pub fn set_flash_lock(env: &Env, user: &Address, locked: bool, ttl_ledgers: u32) {
    env.storage()
        .temporary()
        .set(&TempKey::FlashLock(user.clone()), &locked);
    if locked {
        env.storage()
            .temporary()
            .extend_ttl(&TempKey::FlashLock(user.clone()), ttl_ledgers, ttl_ledgers);
    }
}
