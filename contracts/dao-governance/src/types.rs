#![no_std]
use soroban_sdk::{contracttype, Address, Bytes};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u32,
    pub proposer: Address,
    pub title: Bytes,
    pub description: Bytes,
    pub yes_votes: i128,
    pub no_votes: i128,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub execution_ledger: u32, // timelock: after end_ledger + TIMELOCK_DELAY
    pub executed: bool,
    pub cancelled: bool,
    pub deposit: i128,
    /// Encoded call: [target_address_bytes(32) || calldata]
    pub payload: Bytes,
    pub status: ProposalStatus,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Failed,
    Cancelled,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoteRecord {
    pub credits_spent: i128,
    pub vote_weight: i128, // sqrt(credits_spent)
    pub is_for: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DelegationRecord {
    pub delegate: Address,
}
