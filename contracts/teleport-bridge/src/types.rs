#![no_std]
use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Bridge configuration stored in instance storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeConfig {
    pub admin: Address,
    pub threshold: u32,    // M of N validators required
    pub daily_limit: i128, // max tokens per 24h rolling window
    pub paused: bool,
}

/// A cross-chain teleport request submitted by a relayer/user.
///
/// The `merkle_proof` and `leaf_index` drive the on-chain Merkle inclusion
/// proof.  `attestations` is unused in the pre-attest flow but kept in the
/// struct so callers can pass raw signatures for future secp256k1 integration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeleportRequest {
    /// Source-chain transaction hash – doubles as the nullifier key.
    pub tx_id: BytesN<32>,
    /// Identifier of the origin chain (arbitrary u32 agreed upon off-chain).
    pub source_chain_id: u32,
    /// Merkle root of the source-chain burn-event batch.
    pub merkle_root: BytesN<32>,
    /// Destination address on Stellar.
    pub recipient: Address,
    /// Amount of wrapped tokens to mint (stroops / smallest unit).
    pub amount: i128,
    /// Wrapped token contract on Stellar (for future mint call).
    pub token: Address,
    /// Sibling hashes for the Merkle inclusion proof (leaf → root path).
    pub merkle_proof: Vec<BytesN<32>>,
    /// 0-based index of the leaf in the Merkle tree.
    pub leaf_index: u32,
    /// Raw validator signatures (reserved for secp256k1 path; unused here).
    pub attestations: Vec<BytesN<64>>,
}

/// Error codes returned by every fallible function.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    NullifierAlreadyUsed = 5,
    InsufficientAttestations = 6,
    DailyLimitExceeded = 7,
    InvalidMerkleProof = 8,
    ValidatorNotFound = 9,
    InvalidAmount = 10,
    AlreadyAttested = 11,
}
