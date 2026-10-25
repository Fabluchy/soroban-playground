#![no_std]

use soroban_sdk::{contracterror, contracttype, Address, String};

// ── Tranche class ─────────────────────────────────────────────────────────────

/// Senior = fixed yield, priority payout, last-loss.
/// Junior = variable/high yield, first-loss capital buffer.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TrancheClass {
    Senior = 0,
    Junior = 1,
}

// ── Pool & investor state ─────────────────────────────────────────────────────

/// Global pool configuration + accumulated state.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolState {
    /// Admin / issuer address.
    pub admin: Address,
    /// Optional auditor oracle for NAV updates.
    pub auditor: Address,
    /// Basis-point fixed yield for the senior tranche (e.g. 800 = 8%).
    pub senior_yield_bps: u32,
    /// Maximum junior subordination ratio in basis points (e.g. 2000 = 20%).
    /// Junior absorbs losses up to this fraction of total pool.
    pub junior_sub_ratio_bps: u32,
    /// Total principal deposited by senior investors (in base asset units).
    pub senior_principal: i128,
    /// Total principal deposited by junior investors.
    pub junior_principal: i128,
    /// Accumulated interest already distributed to senior tranche.
    pub senior_interest_paid: i128,
    /// Accumulated principal already returned to senior investors.
    pub senior_principal_paid: i128,
    /// Accumulated surplus already distributed to junior investors.
    pub junior_surplus_paid: i128,
    /// Total write-downs (defaults) absorbed by junior tranche so far.
    pub junior_write_down: i128,
    /// Net Asset Value per share (scaled by NAV_SCALE = 1_000_000).
    pub nav_per_share: i128,
    /// Whether the pool is paused.
    pub paused: bool,
}

/// Per-investor position record.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Position {
    pub investor: Address,
    pub tranche: TrancheClass,
    /// Vault shares minted at deposit time.
    pub shares: i128,
    /// Original principal amount.
    pub principal: i128,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum InstanceKey {
    Initialized,
    Pool,
    InvestorCount,
}

#[contracttype]
pub enum DataKey {
    /// Position of investor in a specific tranche.
    Position(Address, TrancheClass),
    /// Whether `Address` is on the accredited investor whitelist.
    Whitelisted(Address),
    /// Investor slot (dense list).
    InvestorAt(u32),
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    NotWhitelisted = 4,
    InvalidAmount = 5,
    InsufficientShares = 6,
    PoolPaused = 7,
    InvalidYield = 8,
    InvalidSubRatio = 9,
    /// Repayment amount is zero.
    ZeroRepayment = 10,
    /// Junior tranche is exhausted – senior suffers losses.
    JuniorExhausted = 11,
    /// NAV update from an unregistered auditor.
    UnauthorizedAuditor = 12,
    /// Attempted secondary transfer between non-whitelisted parties.
    TransferNotAllowed = 13,
    PositionNotFound = 14,
    ArithmeticOverflow = 15,
}
