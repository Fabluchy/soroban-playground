// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import {
  AnalysisInputError,
  analyzeFiles,
  buildSarif,
  normalizeFiles,
  RULES,
} from '../src/services/analyzer/staticAnalysisService.js';

const AUTH_BYPASS = `
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    pub fn withdraw(env: Env, user: Address, amount: i128) {
        let balance: i128 = env.storage().persistent().get(&user).unwrap_or(0);
        env.storage().persistent().set(&user, &(balance - amount));
    }
}
`;

const AUTH_SAFE = `
use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    pub fn withdraw(env: Env, user: Address, amount: i128) {
        user.require_auth();
        let balance: i128 = env.storage().persistent().get(&user).unwrap_or(0);
        env.storage().persistent().set(&user, &(balance - amount));
        env.storage().persistent().extend_ttl(&user, 100, 1000);
    }
}
`;

const MISSING_TTL = `
use soroban_sdk::{contract, contractimpl, symbol_short, Env, Symbol};

#[contract]
pub struct Registry;

#[contractimpl]
impl Registry {
    pub fn set_value(env: Env, key: Symbol, value: u64) {
        env.storage().persistent().set(&key, &value);
    }
}
`;

const TTL_SAFE = `
use soroban_sdk::{contract, contractimpl, Env, Symbol};

#[contract]
pub struct Registry;

#[contractimpl]
impl Registry {
    pub fn set_value(env: Env, key: Symbol, value: u64) {
        env.storage().persistent().set(&key, &value);
        env.storage().persistent().extend_ttl(&key, 100, 1000);
    }
}
`;

const INTEGER_TRUNCATION = `
use soroban_sdk::{contract, contractimpl, symbol_short, Env};

#[contract]
pub struct Payments;

#[contractimpl]
impl Payments {
    pub fn withdraw(env: Env, amount: i128) {
        let withdrawn = amount as i64;
        env.storage().instance().set(&symbol_short!("last"), &withdrawn);
    }
}
`;

const INTEGER_SAFE = `
use soroban_sdk::{contract, contractimpl, symbol_short, Env};

#[contract]
pub struct Payments;

#[contractimpl]
impl Payments {
    pub fn withdraw(env: Env, amount: i128) {
        let withdrawn = i64::try_from(amount).unwrap();
        env.storage().instance().set(&symbol_short!("last"), &withdrawn);
    }
}
`;

const REENTRANCY = `
use soroban_sdk::{contract, contractimpl, Address, Bytes, Env, Symbol, Vec};

#[contract]
pub struct Router;

#[contractimpl]
impl Router {
    pub fn call(env: Env, target: Address, data: Bytes) {
        let result: () = env.invoke_contract(
            &target,
            &Symbol::new(&env, "run"),
            Vec::new(&env),
        );
        env.storage().persistent().set(&data, &result);
    }
}
`;

const COMMENT_AND_STRING_SAFE = `
use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct FalsePositiveGuard;

#[contractimpl]
impl FalsePositiveGuard {
    pub fn read(env: Env, user: Address) -> i128 {
        // user.require_auth(); env.storage().persistent().set(&user, &1);
        let note = "env.storage().persistent().set(&user, &1)";
        let _ = note;
        env.storage().persistent().get(&user).unwrap_or(0)
    }
}
`;

function findingsFor(source, path = 'src/lib.rs') {
  return analyzeFiles({ files: [{ path, content: source }] });
}

describe('static analysis rules', () => {
  it('detects unverified address authorization', () => {
    const result = findingsFor(AUTH_BYPASS);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'soroban/unverified-address-auth',
          severity: 'high',
          level: 'error',
          file: 'src/lib.rs',
        }),
      ])
    );
  });

  it('does not flag an address that calls require_auth', () => {
    const result = findingsFor(AUTH_SAFE);

    expect(
      result.findings.find(
        (finding) => finding.ruleId === 'soroban/unverified-address-auth'
      )
    ).toBeUndefined();
  });

  it('detects persistent storage writes without TTL renewal', () => {
    const result = findingsFor(MISSING_TTL);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'soroban/missing-ttl-renewal',
          severity: 'medium',
          level: 'warning',
        }),
      ])
    );
  });

  it('does not flag storage writes when extend_ttl is present', () => {
    const result = findingsFor(TTL_SAFE);

    expect(
      result.findings.find(
        (finding) => finding.ruleId === 'soroban/missing-ttl-renewal'
      )
    ).toBeUndefined();
  });

  it('detects i128 to i64 truncation casts', () => {
    const result = findingsFor(INTEGER_TRUNCATION);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'soroban/integer-truncation',
          evidence: 'amount as i64',
        }),
      ])
    );
  });

  it('does not flag checked integer conversion', () => {
    const result = findingsFor(INTEGER_SAFE);

    expect(
      result.findings.find(
        (finding) => finding.ruleId === 'soroban/integer-truncation'
      )
    ).toBeUndefined();
  });

  it('detects cross-contract calls followed by storage writes', () => {
    const result = findingsFor(REENTRANCY);

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: 'soroban/reentrancy-risk',
        }),
      ])
    );
  });

  it('ignores findings that only appear in comments and strings', () => {
    const result = findingsFor(COMMENT_AND_STRING_SAFE);

    expect(result.findings).toEqual([]);
  });

  it('includes line numbers and code snippets', () => {
    const result = findingsFor(AUTH_BYPASS);
    const finding = result.findings.find(
      (entry) => entry.ruleId === 'soroban/unverified-address-auth'
    );

    expect(finding.line).toBeGreaterThan(0);
    expect(finding.column).toBeGreaterThan(0);
    expect(finding.snippet).toContain('withdraw');
    expect(finding.fingerprint).toMatch(/^[a-f0-9]+$/);
  });

  it('analyzes multiple files and summarizes findings', () => {
    const result = analyzeFiles({
      files: [
        { path: 'src/vault.rs', content: AUTH_BYPASS },
        { path: 'src/registry.rs', content: MISSING_TTL },
      ],
    });

    expect(result.filesAnalyzed).toBe(2);
    expect(result.summary.total).toBeGreaterThanOrEqual(2);
    expect(result.summary.bySeverity.high).toBeGreaterThanOrEqual(1);
    expect(result.summary.bySeverity.medium).toBeGreaterThanOrEqual(1);
    expect(result.summary.byRule['soroban/unverified-address-auth']).toBe(1);
  });

  it('rejects empty analysis input', () => {
    expect(() => normalizeFiles({})).toThrow(AnalysisInputError);
  });
});

describe('SARIF output', () => {
  it('produces SARIF 2.1.0 with GitHub Code Scanning locations', () => {
    const result = findingsFor(AUTH_BYPASS);
    const sarif = buildSarif(result);

    expect(sarif.version).toBe('2.1.0');
    expect(sarif.$schema).toContain('sarif-2.1.0');
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.rules.length).toBe(RULES.length);
    expect(sarif.runs[0].results.length).toBe(result.findings.length);

    const finding = sarif.runs[0].results.find(
      (entry) => entry.ruleId === 'soroban/unverified-address-auth'
    );
    expect(finding).toBeDefined();
    expect(finding.level).toBe('error');
    expect(finding.locations[0].physicalLocation.artifactLocation.uri).toBe(
      'src/lib.rs'
    );
    expect(
      finding.locations[0].physicalLocation.region.startLine
    ).toBeGreaterThan(0);
    expect(finding.partialFingerprints.primaryLocationLineHash).toBeDefined();
  });
});
