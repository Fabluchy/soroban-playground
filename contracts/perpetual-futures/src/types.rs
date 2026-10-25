// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

use soroban_sdk::{contracterror, contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PositionStatus {
    Active,
    Closed,
    Liquidated,
    PartiallyLiquidated,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub id: u64,
    pub trader: Address,
    pub is_long: bool,
    pub size: i128,
    pub leverage: u32,
    pub entry_price: i128,
    pub collateral: i128,
    pub status: PositionStatus,
    pub accumulated_funding: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundingRate {
    pub mark_price: i128,
    pub index_price: i128,
    pub rate_bps: i32,
    pub last_update: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountSummary {
    pub collateral: i128,
    pub unrealized_pnl: i128,
    pub equity: i128,
    pub total_position_size: i128,
    pub margin_ratio_bps: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenInterest {
    pub long_oi: i128,
    pub short_oi: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ContractPaused = 4,
    InvalidLeverage = 5,
    InvalidSize = 6,
    InvalidPrice = 7,
    PositionNotFound = 8,
    PositionNotActive = 9,
    InsufficientMargin = 10,
    InvalidAmount = 11,
    PositionNotLiquidatable = 12,
}
