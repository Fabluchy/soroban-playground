//! # Multi-Oracle Aggregator — #1805 [SC-09]
//!
//! Resilient decentralised price aggregator featuring:
//! - N whitelisted independent oracle nodes per asset
//! - Stale price filtering (configurable max age in ledger-seconds)
//! - Median Absolute Deviation (MAD) based outlier trimming
//! - Time-Weighted Average Price (TWAP) over a rolling window
//! - Circuit-breaker halt on > threshold% consecutive-block deviation

#![no_std]

mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, String, Vec};
use storage::{
    add_node, get_admin, get_aggregated_price, get_circuit_breaker_bps, get_max_price_age,
    get_node, get_node_count, get_node_id, get_outlier_bps, get_prev_median, get_twap_accum,
    get_twap_window, is_circuit_breaker_tripped, is_initialized, is_node, save_aggregated_price,
    save_node, save_prev_median, save_twap_accum, set_admin, set_circuit_breaker,
    set_circuit_breaker_bps, set_initialized, set_max_price_age, set_outlier_bps, set_twap_window,
    MIN_NODES,
};
use types::{AggregatedPrice, Error, OracleNode, TwapAccumulator};

/// Basis-point denominator.
const BPS: i128 = 10_000;

#[contract]
pub struct OracleAggregator;

#[contractimpl]
impl OracleAggregator {
    // ── Initialisation ────────────────────────────────────────────────────────

    pub fn initialize(
        env: Env,
        admin: Address,
        max_price_age: Option<u64>,
        outlier_bps: Option<u32>,
        circuit_breaker_bps: Option<u32>,
        twap_window_seconds: Option<u64>,
    ) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        set_admin(&env, &admin);
        if let Some(age) = max_price_age {
            set_max_price_age(&env, age);
        }
        if let Some(bps) = outlier_bps {
            set_outlier_bps(&env, bps);
        }
        if let Some(bps) = circuit_breaker_bps {
            set_circuit_breaker_bps(&env, bps);
        }
        if let Some(w) = twap_window_seconds {
            set_twap_window(&env, w);
        }
        set_initialized(&env);
        env.events().publish((symbol_short!("init"),), &admin);
        Ok(())
    }

    // ── Node management ───────────────────────────────────────────────────────

    /// Admin-only: register a new oracle node.
    pub fn add_node(
        env: Env,
        admin: Address,
        reporter: Address,
        description: String,
    ) -> Result<u32, Error> {
        admin.require_auth();
        let stored_admin = get_admin(&env)?;
        if stored_admin != admin {
            return Err(Error::Unauthorized);
        }
        if is_node(&env, &reporter) {
            return Err(Error::NodeExists);
        }

        let node = OracleNode {
            address: reporter.clone(),
            description,
            active: true,
            submissions: 0,
            last_price: 0,
            last_timestamp: 0,
        };
        let id = add_node(&env, &node);
        env.events()
            .publish((symbol_short!("addNode"),), (&reporter, id));
        Ok(id)
    }

    /// Admin-only: deactivate a node (does not delete – preserves history).
    pub fn deactivate_node(env: Env, admin: Address, node_id: u32) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = get_admin(&env)?;
        if stored_admin != admin {
            return Err(Error::Unauthorized);
        }
        let mut node = get_node(&env, node_id)?;
        node.active = false;
        save_node(&env, node_id, &node);
        env.events()
            .publish((symbol_short!("deactNode"),), node_id);
        Ok(())
    }

    // ── Price submission ──────────────────────────────────────────────────────

    /// Submit a price for an asset.  Only registered active nodes may submit.
    ///
    /// After each submission the contract re-aggregates:
    /// 1. Discards stale prices (age > max_price_age)
    /// 2. Computes median across valid submissions
    /// 3. Removes MAD outliers (> outlier_bps deviation from median)
    /// 4. Re-computes clean median for the aggregated result
    /// 5. Updates the TWAP accumulator
    /// 6. Checks circuit-breaker (> cb_bps change from previous median)
    pub fn submit_price(
        env: Env,
        reporter: Address,
        asset: String,
        price: i128,
    ) -> Result<(), Error> {
        reporter.require_auth();

        if is_circuit_breaker_tripped(&env) {
            return Err(Error::CircuitBreakerTripped);
        }

        if !is_node(&env, &reporter) {
            return Err(Error::NodeNotFound);
        }
        let node_id = get_node_id(&env, &reporter).ok_or(Error::NodeNotFound)?;
        let mut node = get_node(&env, node_id)?;
        if !node.active {
            return Err(Error::NodeInactive);
        }
        if price <= 0 {
            return Err(Error::InvalidPrice);
        }

        let now = env.ledger().timestamp();
        node.last_price = price;
        node.last_timestamp = now;
        node.submissions += 1;
        save_node(&env, node_id, &node);

        // Aggregate across all active, non-stale nodes for this asset
        let aggregated = Self::aggregate(&env, &asset, now)?;
        save_aggregated_price(&env, &aggregated);

        // Update TWAP
        Self::update_twap(&env, &asset, aggregated.median, now);

        env.events()
            .publish((symbol_short!("price"),), (&asset, price, &reporter));
        Ok(())
    }

    // ── Circuit-breaker management ────────────────────────────────────────────

    /// Admin-only: manually reset a tripped circuit breaker.
    pub fn reset_circuit_breaker(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = get_admin(&env)?;
        if stored_admin != admin {
            return Err(Error::Unauthorized);
        }
        set_circuit_breaker(&env, false);
        env.events().publish((symbol_short!("cbReset"),), &admin);
        Ok(())
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    pub fn get_aggregated_price(
        env: Env,
        asset: String,
    ) -> Result<AggregatedPrice, Error> {
        if is_circuit_breaker_tripped(&env) {
            return Err(Error::CircuitBreakerTripped);
        }
        get_aggregated_price(&env, &asset).ok_or(Error::AssetNotFound)
    }

    pub fn get_twap(env: Env, asset: String) -> Result<i128, Error> {
        if is_circuit_breaker_tripped(&env) {
            return Err(Error::CircuitBreakerTripped);
        }
        let accum = get_twap_accum(&env, &asset).ok_or(Error::AssetNotFound)?;
        if accum.total_time == 0 {
            return Ok(accum.last_price);
        }
        accum
            .price_time_sum
            .checked_div(accum.total_time as i128)
            .ok_or(Error::ArithmeticOverflow)
    }

    pub fn is_circuit_breaker_tripped(env: Env) -> bool {
        is_circuit_breaker_tripped(&env)
    }

    pub fn get_node(env: Env, node_id: u32) -> Result<OracleNode, Error> {
        get_node(&env, node_id)
    }

    pub fn get_node_count(env: Env) -> u32 {
        get_node_count(&env)
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        get_admin(&env)
    }

    pub fn get_max_price_age(env: Env) -> u64 {
        get_max_price_age(&env)
    }

    pub fn get_outlier_bps(env: Env) -> u32 {
        get_outlier_bps(&env)
    }

    pub fn get_circuit_breaker_bps(env: Env) -> u32 {
        get_circuit_breaker_bps(&env)
    }

    // ── Internal: aggregation ─────────────────────────────────────────────────

    /// Collect valid prices, compute MAD-trimmed median, check circuit-breaker.
    fn aggregate(
        env: &Env,
        asset: &String,
        now: u64,
    ) -> Result<AggregatedPrice, Error> {
        let max_age = get_max_price_age(env);
        let outlier_bps = get_outlier_bps(env);
        let cb_bps = get_circuit_breaker_bps(env);
        let node_count = get_node_count(env);

        // Step 1: collect all active, non-stale node prices
        let mut prices: Vec<i128> = Vec::new(env);
        for i in 0..node_count {
            if let Ok(node) = get_node(env, i) {
                if !node.active || node.last_price <= 0 || node.last_timestamp == 0 {
                    continue;
                }
                let age = now.saturating_sub(node.last_timestamp);
                if age > max_age {
                    continue;
                }
                prices.push_back(node.last_price);
            }
        }

        if prices.is_empty() {
            return Ok(AggregatedPrice {
                asset: asset.clone(),
                median: 0,
                twap: 0,
                last_updated: now,
                contributing_nodes: 0,
                circuit_breaker_tripped: false,
            });
        }

        // Step 2: sort prices
        let sorted = Self::insertion_sort(env, &prices);

        // Step 3: compute preliminary median
        let prelim_median = Self::median_of_sorted(env, &sorted);

        // Step 4: MAD outlier trimming
        let mut clean: Vec<i128> = Vec::new(env);
        for i in 0..sorted.len() {
            let p = sorted.get_unchecked(i);
            let deviation = (p - prelim_median).abs();
            let threshold = prelim_median
                .checked_mul(outlier_bps as i128)
                .unwrap_or(i128::MAX)
                .checked_div(BPS)
                .unwrap_or(i128::MAX);
            if deviation <= threshold {
                clean.push_back(p);
            }
        }

        // Step 5: final clean median
        let final_median = if clean.is_empty() {
            prelim_median
        } else {
            let clean_sorted = Self::insertion_sort(env, &clean);
            Self::median_of_sorted(env, &clean_sorted)
        };

        let contributing = clean.len() as u32;

        // Step 6: circuit-breaker check
        let prev_median = get_prev_median(env, asset);
        let cb_tripped = if let Some(prev) = prev_median {
            if prev > 0 {
                let change_bps = (final_median - prev).abs()
                    .checked_mul(BPS)
                    .unwrap_or(i128::MAX)
                    .checked_div(prev)
                    .unwrap_or(i128::MAX);
                change_bps > cb_bps as i128
            } else {
                false
            }
        } else {
            false
        };

        if cb_tripped {
            set_circuit_breaker(env, true);
            env.events()
                .publish((symbol_short!("cbTrip"),), (asset, final_median));
        }
        save_prev_median(env, asset, final_median);

        // Retrieve current TWAP (or use median if not yet initialised)
        let twap_val = get_twap_accum(env, asset)
            .and_then(|a| {
                if a.total_time == 0 {
                    None
                } else {
                    a.price_time_sum.checked_div(a.total_time as i128)
                }
            })
            .unwrap_or(final_median);

        Ok(AggregatedPrice {
            asset: asset.clone(),
            median: final_median,
            twap: twap_val,
            last_updated: now,
            contributing_nodes: contributing,
            circuit_breaker_tripped: cb_tripped,
        })
    }

    /// Update the TWAP rolling accumulator.
    fn update_twap(env: &Env, asset: &String, price: i128, now: u64) {
        let window = get_twap_window(env);
        let accum = get_twap_accum(env, asset);

        let new_accum = if let Some(mut a) = accum {
            let elapsed = now.saturating_sub(a.last_update);
            // Accumulate weighted price for elapsed time
            let contribution = a
                .last_price
                .saturating_mul(elapsed as i128);
            a.price_time_sum = a.price_time_sum.saturating_add(contribution);
            a.total_time = a.total_time.saturating_add(elapsed);

            // Evict oldest data outside the rolling window
            let window_start = now.saturating_sub(window);
            if a.window_start < window_start {
                let expired = window_start.saturating_sub(a.window_start);
                let expired_contribution = a
                    .last_price
                    .saturating_mul(expired.min(a.total_time) as i128);
                a.price_time_sum = a.price_time_sum.saturating_sub(expired_contribution);
                a.total_time = a.total_time.saturating_sub(expired.min(a.total_time));
                a.window_start = window_start;
            }

            a.last_price = price;
            a.last_update = now;
            a
        } else {
            TwapAccumulator {
                price_time_sum: 0,
                total_time: 0,
                window_start: now,
                last_price: price,
                last_update: now,
            }
        };
        save_twap_accum(env, asset, &new_accum);
    }

    // ── Math helpers ──────────────────────────────────────────────────────────

    /// Insertion sort – O(n²) but safe inside Soroban (n ≤ typical oracle count).
    fn insertion_sort(env: &Env, prices: &Vec<i128>) -> Vec<i128> {
        let mut sorted: Vec<i128> = Vec::new(env);
        for i in 0..prices.len() {
            sorted.push_back(prices.get_unchecked(i));
        }
        let n = sorted.len();
        for i in 1..n {
            let key = sorted.get_unchecked(i);
            let mut j = i;
            while j > 0 && sorted.get_unchecked(j - 1) > key {
                let prev = sorted.get_unchecked(j - 1);
                sorted.set(j, prev);
                j -= 1;
            }
            sorted.set(j, key);
        }
        sorted
    }

    /// Median of a **sorted** vector.
    fn median_of_sorted(_env: &Env, sorted: &Vec<i128>) -> i128 {
        let n = sorted.len();
        if n == 0 {
            return 0;
        }
        if n % 2 == 1 {
            sorted.get_unchecked(n / 2)
        } else {
            let lo = sorted.get_unchecked(n / 2 - 1);
            let hi = sorted.get_unchecked(n / 2);
            (lo + hi) / 2
        }
    }
}
