#![no_std]

use soroban_sdk::{contracterror, contracttype, Address, String};

// ── Storage class ─────────────────────────────────────────────────────────────

/// Soroban's three storage tiers.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum StorageClass {
    /// Instance storage – lives as long as the contract instance.
    Instance = 0,
    /// Persistent storage – survives archival with explicit TTL extension.
    Persistent = 1,
    /// Temporary storage – cheapest, expires automatically (short-lived nonces,
    /// flash-loan locks, etc.)
    Temporary = 2,
}

// ── Managed key registration ──────────────────────────────────────────────────

/// A critical protocol key registered for keeper-assisted TTL renewal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ManagedKey {
    /// Slot / index into the managed list.
    pub id: u32,
    /// Human-readable description.
    pub description: String,
    /// Which storage class the key lives in.
    pub class: StorageClass,
    /// Minimum remaining ledgers before a crank call is eligible to extend.
    pub renewal_threshold: u32,
    /// Ledgers by which to extend when renewing.
    pub extension_ledgers: u32,
    /// Whether this registration is active.
    pub active: bool,
    /// Last ledger at which TTL was extended (telemetry).
    pub last_renewed_at: u32,
    /// Total number of times renewed.
    pub renewals: u64,
}

/// Telemetry event payload.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TtlEvent {
    pub key_id: u32,
    pub class: StorageClass,
    /// Remaining ledgers after the extension.
    pub remaining_ledgers: u32,
    pub extended_by: u32,
    pub crank: Address,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum InstanceKey {
    Initialized,
    Admin,
    /// Total registered managed keys.
    KeyCount,
    /// Reward (in stroops) paid to crank callers per extension.
    CrankRewardStroops,
    /// Maximum extension ledgers allowed per call (rent cap).
    MaxExtensionLedgers,
}

#[contracttype]
pub enum DataKey {
    /// Managed key registration at slot `u32`.
    ManagedKey(u32),
    /// Per-crank balance accrued (for batch payment).
    CrankBalance(Address),
}

#[contracttype]
pub enum TempKey {
    /// Short-lived nonce for `Address` (temporary storage).
    Nonce(Address),
    /// Flash-loan active lock for `Address`.
    FlashLock(Address),
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    KeyNotFound = 4,
    KeyInactive = 5,
    /// TTL still well above threshold; too early to renew.
    TooEarlyToRenew = 6,
    InvalidExtension = 7,
    InsufficientFunds = 8,
    InvalidReward = 9,
    FlashLockActive = 10,
    FlashLockNotActive = 11,
    ArithmeticOverflow = 12,
}
