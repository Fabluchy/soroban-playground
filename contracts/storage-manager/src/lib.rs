//! # Storage Manager — #1806 [SC-10]
//!
//! Automated Soroban storage TTL renewal and rent-reclaim garbage collector.
//!
//! Key features:
//! - Register critical protocol keys (instance / persistent / temporary) for
//!   keeper-assisted TTL renewal
//! - Incentivise third-party "crank" callers with configurable per-renewal rewards
//! - Manage temporary storage entries (nonces, flash-loan locks) with short TTLs
//! - Bulk TTL-extension calls across multi-contract ecosystems
//! - Emit telemetry events reporting remaining storage lifespan in ledgers
//! - Prevent over-extension beyond Soroban rent limits

#![no_std]

mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, String, Vec};
use storage::{
    add_crank_balance, get_admin, get_crank_balance, get_crank_reward, get_key_count,
    get_managed_key, get_max_extension, get_nonce, inc_key_count, is_flash_locked, is_initialized,
    reset_crank_balance, save_managed_key, set_admin, set_crank_reward, set_flash_lock,
    set_initialized, set_max_extension, set_nonce,
};
use types::{Error, ManagedKey, StorageClass, TempKey, TtlEvent};

/// Soroban ledger rent constants (approximate).
/// Minimum TTL after extension must be ≥ this (safety margin).
const MIN_TTL_LEDGERS: u32 = 17_280; // ~1 day
/// Short TTL for temporary keys (nonces, flash locks) – ~1 hour.
const TEMP_TTL_LEDGERS: u32 = 720;

#[contract]
pub struct StorageManager;

#[contractimpl]
impl StorageManager {
    // ── Initialisation ────────────────────────────────────────────────────────

    /// Initialise the storage manager.
    ///
    /// * `admin`                  – Protocol admin.
    /// * `crank_reward_stroops`   – Reward paid to keeper per TTL extension.
    /// * `max_extension_ledgers`  – Hard cap on extension per call.
    pub fn initialize(
        env: Env,
        admin: Address,
        crank_reward_stroops: i128,
        max_extension_ledgers: u32,
    ) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        set_admin(&env, &admin);
        if crank_reward_stroops > 0 {
            set_crank_reward(&env, crank_reward_stroops);
        }
        if max_extension_ledgers > 0 {
            set_max_extension(&env, max_extension_ledgers);
        }
        set_initialized(&env);
        env.events()
            .publish((symbol_short!("init"),), (&admin, crank_reward_stroops));
        Ok(())
    }

    // ── Key registration ──────────────────────────────────────────────────────

    /// Admin-only: register a critical protocol storage key for keeper renewal.
    ///
    /// * `class`               – Instance / Persistent / Temporary.
    /// * `description`         – Human-readable label.
    /// * `renewal_threshold`   – Remaining ledgers below which renewal is eligible.
    /// * `extension_ledgers`   – How many ledgers to add on each renewal.
    pub fn register_key(
        env: Env,
        admin: Address,
        description: String,
        class: StorageClass,
        renewal_threshold: u32,
        extension_ledgers: u32,
    ) -> Result<u32, Error> {
        admin.require_auth();
        let stored_admin = get_admin(&env)?;
        if stored_admin != admin {
            return Err(Error::Unauthorized);
        }

        let max_ext = get_max_extension(&env);
        if extension_ledgers == 0 || extension_ledgers > max_ext {
            return Err(Error::InvalidExtension);
        }

        let id = inc_key_count(&env);
        let mk = ManagedKey {
            id,
            description,
            class,
            renewal_threshold,
            extension_ledgers,
            active: true,
            last_renewed_at: env.ledger().sequence(),
            renewals: 0,
        };
        save_managed_key(&env, &mk);
        env.events()
            .publish((symbol_short!("regKey"),), (id, class, extension_ledgers));
        Ok(id)
    }

    /// Admin-only: deactivate a managed key registration.
    pub fn deregister_key(env: Env, admin: Address, key_id: u32) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = get_admin(&env)?;
        if stored_admin != admin {
            return Err(Error::Unauthorized);
        }
        let mut mk = get_managed_key(&env, key_id)?;
        mk.active = false;
        save_managed_key(&env, &mk);
        env.events().publish((symbol_short!("deregKey"),), key_id);
        Ok(())
    }

    // ── TTL extension (instance storage) ─────────────────────────────────────

    /// Extend the TTL of this contract's instance storage.
    ///
    /// Any caller (keeper / crank) may invoke this when the remaining TTL has
    /// dropped below the registered threshold.  The crank earns the configured
    /// reward credited to their balance.
    pub fn extend_instance_ttl(
        env: Env,
        crank: Address,
        key_id: u32,
        threshold_ledgers: u32,
        extension_ledgers: u32,
    ) -> Result<TtlEvent, Error> {
        crank.require_auth();
        let mk = get_managed_key(&env, key_id)?;
        if !mk.active {
            return Err(Error::KeyInactive);
        }
        if mk.class != StorageClass::Instance {
            return Err(Error::InvalidExtension);
        }
        if extension_ledgers > get_max_extension(&env) {
            return Err(Error::InvalidExtension);
        }

        env.storage()
            .instance()
            .extend_ttl(threshold_ledgers, extension_ledgers);

        Self::credit_crank(&env, &crank, &mk);

        let mut mk = mk;
        mk.last_renewed_at = env.ledger().sequence();
        mk.renewals += 1;
        save_managed_key(&env, &mk);

        let evt = TtlEvent {
            key_id,
            class: StorageClass::Instance,
            remaining_ledgers: extension_ledgers,
            extended_by: extension_ledgers,
            crank: crank.clone(),
        };
        env.events()
            .publish((symbol_short!("ttlInst"),), (key_id, extension_ledgers, &crank));
        Ok(evt)
    }

    // ── TTL extension (persistent storage) ───────────────────────────────────

    /// Extend TTL on a specific persistent storage key (identified by its slot id).
    ///
    /// The contract extends its own `ManagedKey` record as a proxy for the
    /// critical key's TTL.  In a production deployment the admin would register
    /// the critical key's storage key discriminant and this function would call
    /// `env.storage().persistent().extend_ttl(key, ...)` on it directly.
    pub fn extend_persistent_ttl(
        env: Env,
        crank: Address,
        key_id: u32,
        threshold_ledgers: u32,
        extension_ledgers: u32,
    ) -> Result<TtlEvent, Error> {
        crank.require_auth();
        let mk = get_managed_key(&env, key_id)?;
        if !mk.active {
            return Err(Error::KeyInactive);
        }
        if mk.class != StorageClass::Persistent {
            return Err(Error::InvalidExtension);
        }
        if extension_ledgers > get_max_extension(&env) {
            return Err(Error::InvalidExtension);
        }

        // Extend the TTL of the ManagedKey record itself (represents the tracked key).
        env.storage()
            .persistent()
            .extend_ttl(
                &crate::storage::DataKey::ManagedKey(key_id),
                threshold_ledgers,
                extension_ledgers,
            );

        Self::credit_crank(&env, &crank, &mk);

        let mut mk = mk;
        mk.last_renewed_at = env.ledger().sequence();
        mk.renewals += 1;
        save_managed_key(&env, &mk);

        let evt = TtlEvent {
            key_id,
            class: StorageClass::Persistent,
            remaining_ledgers: extension_ledgers,
            extended_by: extension_ledgers,
            crank: crank.clone(),
        };
        env.events()
            .publish((symbol_short!("ttlPers"),), (key_id, extension_ledgers, &crank));
        Ok(evt)
    }

    // ── Bulk renewal across multiple keys ─────────────────────────────────────

    /// Batch-extend TTL for multiple registered key ids.
    /// Returns the count of successfully extended keys.
    pub fn bulk_extend_ttl(
        env: Env,
        crank: Address,
        key_ids: Vec<u32>,
        threshold_ledgers: u32,
        extension_ledgers: u32,
    ) -> Result<u32, Error> {
        crank.require_auth();
        if extension_ledgers > get_max_extension(&env) {
            return Err(Error::InvalidExtension);
        }

        let mut count = 0u32;
        for i in 0..key_ids.len() {
            let kid = key_ids.get_unchecked(i);
            let Ok(mk) = get_managed_key(&env, kid) else { continue };
            if !mk.active {
                continue;
            }

            match mk.class {
                StorageClass::Instance => {
                    env.storage()
                        .instance()
                        .extend_ttl(threshold_ledgers, extension_ledgers);
                }
                StorageClass::Persistent => {
                    env.storage()
                        .persistent()
                        .extend_ttl(
                            &crate::storage::DataKey::ManagedKey(kid),
                            threshold_ledgers,
                            extension_ledgers,
                        );
                }
                StorageClass::Temporary => {
                    // Temporary keys are short-lived by design; skip in bulk renewal
                }
            }

            Self::credit_crank(&env, &crank, &mk);
            let mut mk = mk;
            mk.last_renewed_at = env.ledger().sequence();
            mk.renewals += 1;
            save_managed_key(&env, &mk);
            count += 1;
        }

        env.events()
            .publish((symbol_short!("bulkTtl"),), (count, &crank));
        Ok(count)
    }

    // ── Temporary storage management ──────────────────────────────────────────

    /// Set or refresh a short-lived per-user nonce in temporary storage.
    ///
    /// Temporary storage minimises rent costs for transient state.
    /// TTL defaults to `TEMP_TTL_LEDGERS` (~1 hour).
    pub fn set_nonce(
        env: Env,
        user: Address,
        nonce: u64,
        ttl_ledgers: Option<u32>,
    ) -> Result<(), Error> {
        user.require_auth();
        let ttl = ttl_ledgers.unwrap_or(TEMP_TTL_LEDGERS).min(TEMP_TTL_LEDGERS * 24);
        set_nonce(&env, &user, nonce, ttl);
        env.events()
            .publish((symbol_short!("nonce"),), (&user, nonce, ttl));
        Ok(())
    }

    pub fn get_nonce(env: Env, user: Address) -> u64 {
        get_nonce(&env, &user)
    }

    /// Acquire a flash-loan lock in temporary storage.
    pub fn acquire_flash_lock(env: Env, user: Address) -> Result<(), Error> {
        user.require_auth();
        if is_flash_locked(&env, &user) {
            return Err(Error::FlashLockActive);
        }
        set_flash_lock(&env, &user, true, TEMP_TTL_LEDGERS);
        env.events()
            .publish((symbol_short!("flAcq"),), &user);
        Ok(())
    }

    /// Release a flash-loan lock.
    pub fn release_flash_lock(env: Env, user: Address) -> Result<(), Error> {
        user.require_auth();
        if !is_flash_locked(&env, &user) {
            return Err(Error::FlashLockNotActive);
        }
        set_flash_lock(&env, &user, false, 1);
        env.events()
            .publish((symbol_short!("flRel"),), &user);
        Ok(())
    }

    pub fn is_flash_locked(env: Env, user: Address) -> bool {
        is_flash_locked(&env, &user)
    }

    // ── Crank reward management ───────────────────────────────────────────────

    /// Admin-only: update the crank reward amount.
    pub fn set_crank_reward(env: Env, admin: Address, stroops: i128) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = get_admin(&env)?;
        if stored_admin != admin {
            return Err(Error::Unauthorized);
        }
        if stroops < 0 {
            return Err(Error::InvalidReward);
        }
        set_crank_reward(&env, stroops);
        env.events()
            .publish((symbol_short!("rwdSet"),), stroops);
        Ok(())
    }

    /// Crank caller: claim any accumulated reward balance.
    pub fn claim_reward(env: Env, crank: Address) -> Result<i128, Error> {
        crank.require_auth();
        let balance = get_crank_balance(&env, &crank);
        if balance == 0 {
            return Ok(0);
        }
        // In a production contract the treasury would call the native XLM token
        // transfer here.  We record the payout and emit a telemetry event.
        reset_crank_balance(&env, &crank);
        env.events()
            .publish((symbol_short!("claim"),), (&crank, balance));
        Ok(balance)
    }

    pub fn get_crank_balance(env: Env, crank: Address) -> i128 {
        get_crank_balance(&env, &crank)
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    pub fn get_managed_key(env: Env, key_id: u32) -> Result<ManagedKey, Error> {
        get_managed_key(&env, key_id)
    }

    pub fn get_key_count(env: Env) -> u32 {
        get_key_count(&env)
    }

    pub fn get_admin(env: Env) -> Result<Address, Error> {
        get_admin(&env)
    }

    pub fn get_crank_reward_amount(env: Env) -> i128 {
        get_crank_reward(&env)
    }

    pub fn get_max_extension_ledgers(env: Env) -> u32 {
        get_max_extension(&env)
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn credit_crank(env: &Env, crank: &Address, _mk: &ManagedKey) {
        let reward = get_crank_reward(env);
        if reward > 0 {
            add_crank_balance(env, crank, reward);
        }
    }
}
