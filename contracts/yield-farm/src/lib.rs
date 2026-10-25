#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[contracttype]
#[derive(Clone)]
pub struct Stake {
    pub amount: i128,
    pub lock_days: u32,
    pub multiplier: u32,
    pub reward_debt: i128,
    pub start_ledger: u32,
}

#[contract]
pub struct YieldFarm;

const ACC: &str = "acc";
const TOTAL: &str = "total";
const RATE: &str = "rate";

#[contractimpl]
impl YieldFarm {
    pub fn init(env: Env, admin: Address, reward_rate: i128) {
        env.storage().instance().set(&"admin", &admin);
        env.storage().instance().set(&RATE, &reward_rate);
        env.storage().instance().set(&TOTAL, &0i128);
        env.storage().instance().set(&ACC, &0i128);
        env.storage().instance().set(&"last", &env.ledger().sequence());
    }

    fn update_pool(env: &Env) {
        let total: i128 = env.storage().instance().get(&TOTAL).unwrap_or(0);
        if total == 0 { return; }
        let last: u32 = env.storage().instance().get(&"last").unwrap_or(0);
        let now = env.ledger().sequence();
        let elapsed = (now - last) as i128;
        let rate: i128 = env.storage().instance().get(&RATE).unwrap_or(0);
        let acc: i128 = env.storage().instance().get(&ACC).unwrap_or(0);
        let add = rate * elapsed / total;
        env.storage().instance().set(&ACC, &(acc + add));
        env.storage().instance().set(&"last", &now);
    }

    pub fn stake(env: Env, user: Address, amount: i128, lock_days: u32) {
        user.require_auth();
        Self::update_pool(&env);
        let mult = match lock_days { 30 => 1u32, 90 => 15u32, 365 => 30u32, _ => 1u32 };
        // store as scaled (mult/10 for 1.5)
        let acc: i128 = env.storage().instance().get(&ACC).unwrap_or(0);
        let s = Stake { amount, lock_days, multiplier: mult, reward_debt: amount * acc / 1_000_000, start_ledger: env.ledger().sequence() };
        env.storage().persistent().set(&("stake", user.clone()), &s);
        let total: i128 = env.storage().instance().get(&TOTAL).unwrap_or(0);
        env.storage().instance().set(&TOTAL, &(total + amount));
    }

    pub fn pending(env: Env, user: Address) -> i128 {
        let s: Stake = env.storage().persistent().get(&("stake", user)).unwrap();
        let acc: i128 = env.storage().instance().get(&ACC).unwrap_or(0);
        let pending = s.amount * s.multiplier as i128 * acc / 1_000_000 - s.reward_debt;
        pending
    }

    pub fn emergency_withdraw(env: Env, user: Address) {
        user.require_auth();
        let s: Stake = env.storage().persistent().get(&("stake", user.clone())).unwrap();
        env.storage().persistent().remove(&("stake", user));
        let total: i128 = env.storage().instance().get(&TOTAL).unwrap_or(0);
        env.storage().instance().set(&TOTAL, &(total - s.amount));
    }
}
