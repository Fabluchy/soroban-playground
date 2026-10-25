#![no_std]

use soroban_sdk::{Address, Env, String};
use crate::types::{
    AggregatedPrice, DataKey, Error, InstanceKey, OracleNode, TwapAccumulator,
};

// ── Constants ─────────────────────────────────────────────────────────────────

pub const DEFAULT_MAX_PRICE_AGE: u64 = 3_600;   // 1 hour
pub const DEFAULT_OUTLIER_BPS: u32 = 2_000;      // 20%
pub const DEFAULT_CB_BPS: u32 = 2_000;           // 20%
pub const DEFAULT_TWAP_WINDOW: u64 = 3_600;      // 1 hour
pub const MIN_NODES: u32 = 1;

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

pub fn get_max_price_age(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&InstanceKey::MaxPriceAge)
        .unwrap_or(DEFAULT_MAX_PRICE_AGE)
}

pub fn set_max_price_age(env: &Env, age: u64) {
    env.storage().instance().set(&InstanceKey::MaxPriceAge, &age);
}

pub fn get_outlier_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&InstanceKey::OutlierThresholdBps)
        .unwrap_or(DEFAULT_OUTLIER_BPS)
}

pub fn set_outlier_bps(env: &Env, bps: u32) {
    env.storage()
        .instance()
        .set(&InstanceKey::OutlierThresholdBps, &bps);
}

pub fn get_circuit_breaker_bps(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&InstanceKey::CircuitBreakerBps)
        .unwrap_or(DEFAULT_CB_BPS)
}

pub fn set_circuit_breaker_bps(env: &Env, bps: u32) {
    env.storage()
        .instance()
        .set(&InstanceKey::CircuitBreakerBps, &bps);
}

pub fn get_twap_window(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&InstanceKey::TwapWindowSeconds)
        .unwrap_or(DEFAULT_TWAP_WINDOW)
}

pub fn set_twap_window(env: &Env, window: u64) {
    env.storage()
        .instance()
        .set(&InstanceKey::TwapWindowSeconds, &window);
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

pub fn is_circuit_breaker_tripped(env: &Env) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::CircuitBreaker)
        .unwrap_or(false)
}

pub fn set_circuit_breaker(env: &Env, tripped: bool) {
    env.storage()
        .persistent()
        .set(&DataKey::CircuitBreaker, &tripped);
}

// ── Nodes ─────────────────────────────────────────────────────────────────────

pub fn get_node_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&InstanceKey::NodeCount)
        .unwrap_or(0)
}

fn inc_node_count(env: &Env) -> u32 {
    let c = get_node_count(env);
    env.storage()
        .instance()
        .set(&InstanceKey::NodeCount, &(c + 1));
    c
}

pub fn is_node(env: &Env, addr: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::IsNode(addr.clone()))
        .unwrap_or(false)
}

pub fn get_node_id(env: &Env, addr: &Address) -> Option<u32> {
    env.storage()
        .persistent()
        .get(&DataKey::NodeId(addr.clone()))
}

pub fn add_node(env: &Env, node: &OracleNode) -> u32 {
    let id = inc_node_count(env);
    env.storage()
        .persistent()
        .set(&DataKey::Node(id), node);
    env.storage()
        .persistent()
        .set(&DataKey::IsNode(node.address.clone()), &true);
    env.storage()
        .persistent()
        .set(&DataKey::NodeId(node.address.clone()), &id);
    id
}

pub fn get_node(env: &Env, id: u32) -> Result<OracleNode, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Node(id))
        .ok_or(Error::NodeNotFound)
}

pub fn save_node(env: &Env, id: u32, node: &OracleNode) {
    env.storage().persistent().set(&DataKey::Node(id), node);
}

// ── Aggregated prices ─────────────────────────────────────────────────────────

pub fn get_aggregated_price(env: &Env, asset: &String) -> Option<AggregatedPrice> {
    env.storage()
        .persistent()
        .get(&DataKey::AggregatedPrice(asset.clone()))
}

pub fn save_aggregated_price(env: &Env, price: &AggregatedPrice) {
    env.storage()
        .persistent()
        .set(&DataKey::AggregatedPrice(price.asset.clone()), price);
}

pub fn get_prev_median(env: &Env, asset: &String) -> Option<i128> {
    env.storage()
        .persistent()
        .get(&DataKey::PrevMedian(asset.clone()))
}

pub fn save_prev_median(env: &Env, asset: &String, median: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::PrevMedian(asset.clone()), &median);
}

// ── TWAP accumulator ──────────────────────────────────────────────────────────

pub fn get_twap_accum(env: &Env, asset: &String) -> Option<TwapAccumulator> {
    env.storage()
        .persistent()
        .get(&DataKey::TwapAccum(asset.clone()))
}

pub fn save_twap_accum(env: &Env, asset: &String, accum: &TwapAccumulator) {
    env.storage()
        .persistent()
        .set(&DataKey::TwapAccum(asset.clone()), accum);
}
