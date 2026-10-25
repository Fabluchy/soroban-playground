#![no_std]

use soroban_sdk::{contracterror, contracttype, Address, Bytes, String, Vec};

// ── Proposal lifecycle ────────────────────────────────────────────────────────

/// Full lifecycle: Proposed → Approved (threshold met) → Queued (time-lock
/// started) → Executed.  Guardian can pause at any point before execution.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProposalStatus {
    Proposed = 0,
    Approved = 1,
    Queued = 2,
    Executed = 3,
    Cancelled = 4,
}

// ── Action types ─────────────────────────────────────────────────────────────

/// Discriminates the payload carried by a proposal.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ActionType {
    /// Transfer one or more assets to `target`.
    BatchTransfer = 0,
    /// Replace the contract WASM with a new hash.
    ContractUpgrade = 1,
    /// Modify a treasury configuration parameter.
    ConfigUpdate = 2,
}

// ── Core structs ──────────────────────────────────────────────────────────────

/// A single asset transfer within a batch.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AssetTransfer {
    /// Token contract address (address of the SAC / SEP-41 token).
    pub token: Address,
    /// Recipient.
    pub to: Address,
    /// Amount in the token's base unit.
    pub amount: i128,
}

/// On-chain proposal record.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Proposal {
    pub id: u32,
    pub proposer: Address,
    pub action: ActionType,
    /// Human-readable description / calldata hash.
    pub description: String,
    /// Serialised action payload (ABI-encoded with XDR).
    pub payload: Bytes,
    pub status: ProposalStatus,
    /// Number of distinct valid signatures collected so far.
    pub sig_count: u32,
    /// Ledger timestamp when the proposal was created.
    pub created_at: u64,
    /// Ledger timestamp after which execution is allowed (0 until queued).
    pub execute_after: u64,
    /// Required execution delay in seconds (copied from config at proposal
    /// creation time for immutability).
    pub time_lock: u64,
}

/// Off-chain Ed25519 signature bundle.  The signer provides their registered
/// Soroban `Address` so the contract can look up the corresponding public key.
#[contracttype]
#[derive(Clone, Debug)]
pub struct SignatureBundle {
    pub signer: Address,
    /// 64-byte raw Ed25519 signature over `keccak256(proposal_id || nonce ||
    /// domain_separator)`.  In practice we use Soroban's crypto primitives.
    pub signature: Bytes,
    /// Per-signer monotonic nonce (replay protection).
    pub nonce: u64,
}

// ── Storage keys ──────────────────────────────────────────────────────────────

#[contracttype]
pub enum InstanceKey {
    Initialized,
    /// M (threshold) – number of signatures required.
    Threshold,
    /// Total N signers registered.
    SignerCount,
    /// Number of proposals created (monotonic counter).
    ProposalCount,
    /// Seconds that must elapse after approval before execution.
    TimeLock,
    /// High-value transfer threshold in stroops (u128 encoded as i128).
    HighValueThreshold,
    /// Guardian address that can pause the contract.
    Guardian,
    /// Paused flag.
    Paused,
}

#[contracttype]
pub enum DataKey {
    /// Signer at slot `u32` (dense list).
    SignerAt(u32),
    /// Whether `Address` is a registered signer.
    IsSigner(Address),
    /// 32-byte Ed25519 public key of `Address`.
    SignerPubkey(Address),
    /// Per-signer monotonic nonce.
    SignerNonce(Address),
    /// Proposal by id.
    Proposal(u32),
    /// Whether signer `Address` has submitted a valid sig for proposal `u32`.
    HasSigned(u32, Address),
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidThreshold = 4,
    InvalidTimeLock = 5,
    SignerExists = 6,
    SignerNotFound = 7,
    ProposalNotFound = 8,
    AlreadySigned = 9,
    WrongStatus = 10,
    TimeLockActive = 11,
    ContractPaused = 12,
    InvalidSignature = 13,
    InvalidNonce = 14,
    InvalidAmount = 15,
    EmptyPayload = 16,
    MissingPubkey = 17,
    HighValueTimeLockRequired = 18,
}
