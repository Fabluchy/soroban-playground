//! # Teleport Bridge (Issue #1809)
//!
//! A cross-chain asset bridge with:
//! - Merkle inclusion proof verification for source-chain burn events.
//! - Nullifier set preventing double-spend / replay attacks.
//! - Multi-sig validator federation with configurable M-of-N threshold.
//! - Emergency pause and daily transfer volume limits.
//! - `TeleportCompleted` events on successful cross-chain mints.
//!
//! ## Trust model
//! Validators are known Stellar addresses stored on-chain.  Before a teleport
//! request can be executed, at least `threshold` distinct validators must have
//! called `attest(validator, tx_id)`, each authenticated with
//! `require_auth()`.  This is the "pre-attest" multisig model; a future
//! upgrade can replace it with on-chain secp256k1 signature recovery over the
//! packed fields stored in `TeleportRequest::attestations`.
//!
//! ## Merkle proof
//! The leaf hash is `sha256(tx_id_bytes)`.  Each sibling in `merkle_proof` is
//! combined with the running hash according to bit `depth` of `leaf_index`:
//! - bit = 0  →  `sha256(running ++ sibling)`   (current is left child)
//! - bit = 1  →  `sha256(sibling ++ running)`   (current is right child)
//!
//! The final hash must equal `merkle_root`.  An empty proof means the leaf
//! hash itself is the root (single-leaf tree).

#![no_std]

mod test;
mod types;

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Vec,
};

use crate::types::{BridgeConfig, Error, TeleportRequest};

// ── Constants ────────────────────────────────────────────────────────────────

/// Approximate ledgers per 24-hour day (5 s/ledger → 17 280 ledgers/day).
const LEDGERS_PER_DAY: u32 = 17_280;

/// Nullifier entries live in persistent storage for 90 days.
const NULLIFIER_TTL_LEDGERS: u32 = LEDGERS_PER_DAY * 90;

/// Daily-volume entries live in temporary storage for 2 days (rolling window).
const DAILY_VOL_TTL_LEDGERS: u32 = LEDGERS_PER_DAY * 2;

/// Attestation entries live for 7 days (relay latency headroom).
const ATTESTATION_TTL_LEDGERS: u32 = LEDGERS_PER_DAY * 7;

// ── Storage keys ─────────────────────────────────────────────────────────────

/// Discriminated union of all storage keys used by the contract.
#[contracttype]
enum DataKey {
    /// Bridge configuration (instance storage).
    Config,
    /// `true` if `Address` is an active validator (persistent).
    Validator(Address),
    /// Total number of active validators (persistent).
    ValidatorCount,
    /// `true` if `BytesN<32>` tx_id has been consumed (persistent, TTL-managed).
    Nullifier(BytesN<32>),
    /// `true` if (`tx_id`, `validator`) attestation has been recorded (persistent).
    Attestation(BytesN<32>, Address),
    /// Cumulative attestation count for `tx_id` (persistent).
    AttestCount(BytesN<32>),
    /// Cumulative transfer volume for day bucket `u32` (temporary).
    DailyVolume(u32),
    /// Wrapped-token contract address on Stellar (instance).
    MintedToken,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct TeleportBridgeContract;

#[contractimpl]
impl TeleportBridgeContract {
    // ── Initialisation ────────────────────────────────────────────────────

    /// One-time setup.  Stores config and registers the initial validator set.
    ///
    /// # Errors
    /// - [`Error::AlreadyInitialized`] if the contract has already been set up.
    /// - [`Error::InvalidAmount`] if `threshold` is zero, exceeds validator count,
    ///   or `daily_limit` is non-positive.
    pub fn initialize(
        env: Env,
        admin: Address,
        threshold: u32,
        daily_limit: i128,
        validators: Vec<Address>,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        let n = validators.len();
        if threshold == 0 || threshold > n {
            return Err(Error::InvalidAmount);
        }
        if daily_limit <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Register each validator.
        for v in validators.iter() {
            env.storage()
                .persistent()
                .set(&DataKey::Validator(v.clone()), &true);
        }
        env.storage()
            .persistent()
            .set(&DataKey::ValidatorCount, &n);

        let cfg = BridgeConfig {
            admin,
            threshold,
            daily_limit,
            paused: false,
        };
        env.storage().instance().set(&DataKey::Config, &cfg);
        Ok(())
    }

    // ── Validator management ──────────────────────────────────────────────

    /// Add a new validator to the federation.
    pub fn add_validator(env: Env, admin: Address, validator: Address) -> Result<(), Error> {
        let cfg = Self::load_config(&env)?;
        Self::assert_admin(&env, &admin, &cfg)?;

        let key = DataKey::Validator(validator.clone());
        let already: bool = env.storage().persistent().get(&key).unwrap_or(false);
        if !already {
            env.storage().persistent().set(&key, &true);
            let count: u32 = env
                .storage()
                .persistent()
                .get(&DataKey::ValidatorCount)
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&DataKey::ValidatorCount, &(count + 1));
        }
        Ok(())
    }

    /// Remove a validator from the federation.
    ///
    /// The threshold is automatically clamped if it would exceed the new count.
    ///
    /// # Errors
    /// - [`Error::ValidatorNotFound`] if the address was never registered.
    pub fn remove_validator(env: Env, admin: Address, validator: Address) -> Result<(), Error> {
        let mut cfg = Self::load_config(&env)?;
        Self::assert_admin(&env, &admin, &cfg)?;

        let key = DataKey::Validator(validator.clone());
        let exists: bool = env.storage().persistent().get(&key).unwrap_or(false);
        if !exists {
            return Err(Error::ValidatorNotFound);
        }
        env.storage().persistent().set(&key, &false);

        let count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ValidatorCount)
            .unwrap_or(1);
        let new_count = count.saturating_sub(1);
        env.storage()
            .persistent()
            .set(&DataKey::ValidatorCount, &new_count);

        // Clamp threshold so it stays satisfiable.
        if new_count > 0 && cfg.threshold > new_count {
            cfg.threshold = new_count;
            env.storage().instance().set(&DataKey::Config, &cfg);
        }
        Ok(())
    }

    /// Set the wrapped-token contract address (Stellar side mint target).
    pub fn set_minted_token(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        let cfg = Self::load_config(&env)?;
        Self::assert_admin(&env, &admin, &cfg)?;
        env.storage().instance().set(&DataKey::MintedToken, &token);
        Ok(())
    }

    // ── Attestation ───────────────────────────────────────────────────────

    /// Validator pre-submits approval for a source-chain `tx_id`.
    ///
    /// Increments a per-`tx_id` attestation counter.  Each validator may
    /// attest at most once per `tx_id`.
    ///
    /// # Errors
    /// - [`Error::NotInitialized`] – contract not set up.
    /// - [`Error::Unauthorized`] – caller is not a registered validator.
    /// - [`Error::AlreadyAttested`] – this validator has already attested.
    pub fn attest(env: Env, validator: Address, tx_id: BytesN<32>) -> Result<(), Error> {
        Self::load_config(&env)?; // ensure initialized
        validator.require_auth();

        // Ensure caller is an active validator.
        let v_key = DataKey::Validator(validator.clone());
        let is_validator: bool = env.storage().persistent().get(&v_key).unwrap_or(false);
        if !is_validator {
            return Err(Error::Unauthorized);
        }

        // Guard against duplicate attestation.
        let att_key = DataKey::Attestation(tx_id.clone(), validator.clone());
        let already: bool = env.storage().persistent().get(&att_key).unwrap_or(false);
        if already {
            return Err(Error::AlreadyAttested);
        }

        // Record this validator's attestation.
        env.storage().persistent().set(&att_key, &true);
        env.storage().persistent().extend_ttl(
            &att_key,
            ATTESTATION_TTL_LEDGERS,
            ATTESTATION_TTL_LEDGERS,
        );

        // Increment aggregate counter for this tx_id.
        let count_key = DataKey::AttestCount(tx_id.clone());
        let prev_count: u32 = env
            .storage()
            .persistent()
            .get(&count_key)
            .unwrap_or(0u32);
        let new_count = prev_count + 1;
        env.storage().persistent().set(&count_key, &new_count);
        env.storage().persistent().extend_ttl(
            &count_key,
            ATTESTATION_TTL_LEDGERS,
            ATTESTATION_TTL_LEDGERS,
        );

        env.events()
            .publish((symbol_short!("attested"),), (tx_id, validator));
        Ok(())
    }

    // ── Core bridge function ──────────────────────────────────────────────

    /// Execute a cross-chain teleport (mint) on the Stellar side.
    ///
    /// Steps:
    /// 1. Assert not paused.
    /// 2. Assert nullifier not yet used.
    /// 3. Verify Merkle inclusion proof.
    /// 4. Require attestation count ≥ threshold.
    /// 5. Assert daily volume headroom.
    /// 6. Mark nullifier used.
    /// 7. Update daily volume.
    /// 8. Emit `TeleportCompleted` event.
    pub fn teleport(env: Env, request: TeleportRequest) -> Result<bool, Error> {
        let cfg = Self::load_config(&env)?;

        // 1. Pause guard.
        if cfg.paused {
            return Err(Error::Paused);
        }

        // 2. Replay guard.
        let null_key = DataKey::Nullifier(request.tx_id.clone());
        let used: bool = env.storage().persistent().get(&null_key).unwrap_or(false);
        if used {
            return Err(Error::NullifierAlreadyUsed);
        }

        // 3. Merkle inclusion proof.
        let proof_valid = Self::verify_merkle_proof(
            env.clone(),
            request.tx_id.clone(),
            request.merkle_proof.clone(),
            request.leaf_index,
            request.merkle_root.clone(),
        );
        if !proof_valid {
            return Err(Error::InvalidMerkleProof);
        }

        // 4. Threshold check.
        let attest_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::AttestCount(request.tx_id.clone()))
            .unwrap_or(0u32);
        if attest_count < cfg.threshold {
            return Err(Error::InsufficientAttestations);
        }

        // 5. Amount and daily volume.
        if request.amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let day_key = Self::current_day_key(&env);
        let dv_key = DataKey::DailyVolume(day_key);
        let current_vol: i128 = env
            .storage()
            .temporary()
            .get(&dv_key)
            .unwrap_or(0i128);
        let new_vol = current_vol
            .checked_add(request.amount)
            .ok_or(Error::DailyLimitExceeded)?;
        if new_vol > cfg.daily_limit {
            return Err(Error::DailyLimitExceeded);
        }

        // 6. Mark nullifier used.
        env.storage().persistent().set(&null_key, &true);
        env.storage().persistent().extend_ttl(
            &null_key,
            NULLIFIER_TTL_LEDGERS,
            NULLIFIER_TTL_LEDGERS,
        );

        // 7. Persist updated daily volume.
        env.storage().temporary().set(&dv_key, &new_vol);
        env.storage().temporary().extend_ttl(
            &dv_key,
            DAILY_VOL_TTL_LEDGERS,
            DAILY_VOL_TTL_LEDGERS,
        );

        // 8. TeleportCompleted event.
        env.events().publish(
            (symbol_short!("teleport"),),
            (
                request.tx_id.clone(),
                request.recipient.clone(),
                request.amount,
            ),
        );

        Ok(true)
    }

    // ── Emergency pause ───────────────────────────────────────────────────

    /// Halt all teleport operations.  Only callable by admin.
    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        let mut cfg = Self::load_config(&env)?;
        Self::assert_admin(&env, &admin, &cfg)?;
        cfg.paused = true;
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.events().publish((symbol_short!("paused"),), ());
        Ok(())
    }

    /// Resume teleport operations.  Only callable by admin.
    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        let mut cfg = Self::load_config(&env)?;
        Self::assert_admin(&env, &admin, &cfg)?;
        cfg.paused = false;
        env.storage().instance().set(&DataKey::Config, &cfg);
        env.events().publish((symbol_short!("unpaused"),), ());
        Ok(())
    }

    // ── Read-only helpers ─────────────────────────────────────────────────

    /// Returns `true` if `tx_id` has already been used as a nullifier.
    pub fn is_nullifier_used(env: Env, tx_id: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Nullifier(tx_id))
            .unwrap_or(false)
    }

    /// Returns the cumulative transferred amount for the current day window.
    pub fn get_daily_volume(env: Env) -> i128 {
        let day_key = Self::current_day_key(&env);
        env.storage()
            .temporary()
            .get(&DataKey::DailyVolume(day_key))
            .unwrap_or(0i128)
    }

    /// Returns a copy of the current bridge configuration.
    pub fn get_config(env: Env) -> Result<BridgeConfig, Error> {
        Self::load_config(&env)
    }

    /// Verify a Merkle inclusion proof for `leaf` against `root`.
    ///
    /// The leaf is hashed first (`sha256(leaf_bytes)`).  Then at each level
    /// `d` the sibling at `proof[d]` is concatenated in the order determined
    /// by bit `d` of `leaf_index`, and the result is hashed again.  The final
    /// hash must equal `root`.
    ///
    /// An empty `proof` is valid iff `sha256(leaf) == root`.
    pub fn verify_merkle_proof(
        env: Env,
        leaf: BytesN<32>,
        proof: Vec<BytesN<32>>,
        leaf_index: u32,
        root: BytesN<32>,
    ) -> bool {
        // Compute leaf hash = sha256(leaf_bytes).
        let leaf_bytes = Bytes::from_slice(&env, &leaf.to_array());
        let mut current: [u8; 32] = env.crypto().sha256(&leaf_bytes).to_array();

        for (depth, sibling) in proof.iter().enumerate() {
            let sib: [u8; 32] = sibling.to_array();
            let bit = (leaf_index >> depth) & 1;

            let mut combined = Bytes::new(&env);
            if bit == 0 {
                // current is the left child
                combined.extend_from_slice(&current);
                combined.extend_from_slice(&sib);
            } else {
                // current is the right child
                combined.extend_from_slice(&sib);
                combined.extend_from_slice(&current);
            }
            current = env.crypto().sha256(&combined).to_array();
        }

        BytesN::<32>::from_array(&env, &current) == root
    }

    // ── Private helpers ───────────────────────────────────────────────────

    fn load_config(env: &Env) -> Result<BridgeConfig, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }

    /// Verifies that `caller` is the admin and calls `require_auth()`.
    fn assert_admin(env: &Env, caller: &Address, cfg: &BridgeConfig) -> Result<(), Error> {
        if *caller != cfg.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();
        Ok(())
    }

    /// Returns the 0-based day bucket index for the current ledger sequence.
    fn current_day_key(env: &Env) -> u32 {
        env.ledger().sequence() / LEDGERS_PER_DAY
    }
}
