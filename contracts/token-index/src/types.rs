// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

use soroban_sdk::{contracterror, contracttype, Address, Symbol};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokenInfo {
    pub token: Address,
    pub symbol: Symbol,
    pub base_price: i128,
    pub base_supply: i128,
    pub current_price: i128,
    pub current_supply: i128,
    pub last_update: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexSnapshot {
    pub timestamp: u64,
    pub index_value: i128,
    pub market_cap: i128,
    pub divisor: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexSummary {
    pub index_value: i128,
    pub divisor: i128,
    pub market_cap: i128,
    pub token_count: u32,
    pub last_snapshot_timestamp: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ContractPaused = 4,
    TokenNotFound = 5,
    TokenAlreadyExists = 6,
    MaxTokensExceeded = 7,
    InvalidPrice = 8,
    InvalidSupply = 9,
    InvalidDivisor = 10,
    ZeroMarketCap = 11,
    ArrayMismatch = 12,
    SnapshotNotFound = 13,
}
