#![no_std]

use soroban_sdk::{contracterror, contracttype, Address, String};

// ── Oracle node record ────────────────────────────────────────────────────────

/// A registered price-reporting oracle node.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OracleNode {
    pub address: Address,
    /// Human-readable label.
    pub description: String,
    /// Whether this node is currently active.
    pub active: bool,
    /// Total number of price submissions accepted.
    pub submissions: u64,
    /// Last accepted price for this node (0 if never submitted).
    pub last_price: i128,
    /// Ledger timestamp of last accepted submission.
    pub last_timestamp: u64,
}

/// Single price submission from a node.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceReport {
    pub node_id: u32,
    pub price: i128,
    /// Ledger timestamp supplied by the reporter.
    pub timestamp: u64,
}

/// Aggregated price result returned to consumers.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AggregatedPrice {
    pub asset: String,
    /// Median of all valid (non-stale, non-outlier) submissions.
    pub median: i128,
    /// Current TWAP value.
    pub twap: i128,
    /// Ledger timestamp of the last aggregation.
    pub last_updated: u64,
    /// Number of valid nodes that contributed to this result.
    pub contributing_nodes: u32,
    /// Whether the circuit-breaker is currently tripped.
    pub circuit_breaker_tripped: bool,
}

/// Accumulated TWAP state for an asset.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TwapAccumulator {
    /// Sum of (price × elapsed_seconds) over the rolling window.
    pub price_time_sum: i128,
    /// Total time elapsed in the rolling window (seconds).
    pub total_time: u64,
    /// Timestamp when the rolling window opened.
    pub window_start: u64,
    /// Last price used to update the accumulator.
    pub last_price: i128,
    /// Timestamp of last update.
    pub last_update: u64,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum InstanceKey {
    Initialized,
    Admin,
    /// Maximum accepted age of a price report in ledger-seconds.
    MaxPriceAge,
    /// MAD outlier threshold in basis points (e.g. 2000 = 20%).
    OutlierThresholdBps,
    /// Circuit-breaker deviation threshold bps (e.g. 2000 = 20%).
    CircuitBreakerBps,
    /// Total registered node count.
    NodeCount,
    /// TWAP rolling window length in seconds.
    TwapWindowSeconds,
}

#[contracttype]
pub enum DataKey {
    /// Oracle node at slot `u32`.
    Node(u32),
    /// Is the address registered as an oracle node?
    IsNode(Address),
    /// Node id of an address.
    NodeId(Address),
    /// Latest aggregated price for an asset.
    AggregatedPrice(String),
    /// TWAP accumulator for an asset.
    TwapAccum(String),
    /// Previous aggregated median for circuit-breaker comparison.
    PrevMedian(String),
    /// Global circuit-breaker halt flag.
    CircuitBreaker,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    NodeExists = 4,
    NodeNotFound = 5,
    NodeInactive = 6,
    StalePrice = 7,
    InvalidPrice = 8,
    InsufficientNodes = 9,
    /// Circuit breaker is tripped – consumers halted.
    CircuitBreakerTripped = 10,
    ArithmeticOverflow = 11,
    AssetNotFound = 12,
}
