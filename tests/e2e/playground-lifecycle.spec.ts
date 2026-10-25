import { test, expect, type Page } from "@playwright/test";

/**
 * Full user lifecycle in the browser (issue #1538).
 *
 *   template -> edit -> compile -> deploy -> read state
 *
 * The backend compile/deploy/invoke calls are stubbed with `page.route` so the
 * suite asserts the *UI wiring* of the flow rather than a cargo build: the same
 * test runs in CI without a funded account, a warm registry cache, or a
 * network round trip. The API contract itself is covered by
 * `contract-lifecycle.spec.ts` against a real Standalone node.
 *
 * Requires `E2E_FRONTEND_URL` (set by `.github/workflows/e2e.yml`).
 */
const FRONTEND_URL = process.env.E2E_FRONTEND_URL ?? "http://localhost:3000";

const CONTRACT_ID = "C".repeat(56);
const WASM_PATH = "artifacts/hello.wasm";

/** Deterministic counter contract the test types into the editor. */
const EDITED_CONTRACT = `#![no_std]
use soroban_sdk::{contract, contractimpl, Env, Symbol, symbol_short};

#[contract]
pub struct CounterContract;

#[contractimpl]
impl CounterContract {
    pub fn increment(env: Env, count: u32) -> u32 {
        env.storage().instance().set(&Symbol::short("count"), &count);
        count
    }
}
`;

/**
 * Stub the playground's API surface.
 *
 * The IDE reads its base URL from `NEXT_PUBLIC_API_BASE_URL`, which defaults to
 * the hosted backend, so routes are matched on the path suffix rather than an
 * exact origin.
 */
async function stubApi(page: Page, options: { compileFails?: boolean } = {}) {
  const calls = {
    compile: 0,
    deploy: 0,
    preflight: 0,
    invoke: 0,
    lastCompileBody: null as { code?: string } | null,
  };

  await page.route("**/api/compile", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }

    calls.compile += 1;
    calls.lastCompileBody = route.request().postDataJSON() as { code?: string };

    if (options.compileFails) {
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ message: "expected `env` parameter" }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        status: "ok",
        message: "Compiled successfully",
        durationMs: 1234,
        hash: "a".repeat(64),
        artifact: {
          name: "soroban_contract.wasm",
          sizeBytes: 6144,
          createdAt: new Date().toISOString(),
        },
      }),
    });
  });

  await page.route("**/api/deploy/preflight", async (route) => {
    calls.preflight += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ready: true,
        sourceAccount: "deploy",
        deployer: "GTEST",
        contractId: CONTRACT_ID,
        wasmHash: "a".repeat(64),
        codeStatus: "live",
        checkedAt: Date.now(),
        elapsedMs: 10,
        funding: {
          reserveStroops: "10000000",
          availableStroops: "100000000",
          feeStroops: "100",
        },
        checks: [{ id: "network", label: "Network verified", passed: true }],
        warnings: [],
      }),
    });
  });

  await page.route("**/api/deploy", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }

    calls.deploy += 1;

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        status: "deployed",
        contractId: CONTRACT_ID,
        contractName: "hello_contract",
        network: "testnet",
        wasmPath: WASM_PATH,
        deployedAt: new Date().toISOString(),
        message: "Deployed to testnet",
        ledgerState: { count: 1, owner: CONTRACT_ID },
      }),
    });
  });

  await page.route("**/api/invoke", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fallback();
    }

    calls.invoke += 1;

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        status: "ok",
        contractId: CONTRACT_ID,
        functionName: "increment",
        args: { count: "1" },
        output: "1",
        message: "Invoked increment",
        invokedAt: new Date().toISOString(),
      }),
    });
  });

  // Compile metrics and health polling are noise for this flow.
  await page.route("**/api/compile/stats", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        stats: {
          activeWorkers: 1,
          maxWorkers: 4,
          queueLength: 0,
          estimatedWaitTimeMs: 0,
          cacheHitRate: 0.5,
          totalCompiles: 3,
          cacheHits: 1,
          slowCompiles: 0,
          memoryPeakBytes: 1024,
          cacheBytes: 2048,
          artifacts: [],
        },
      }),
    }),
  );

  return calls;
}

/** Wait for Monaco to finish its lazy load and the diff view to settle. */
async function waitForEditor(page: Page) {
  await expect(page.getByTestId("monaco-editor").first()).toBeVisible({
    timeout: 60_000,
  });
  await page
    .locator(".monaco-editor .view-lines")
    .first()
    .waitFor({ timeout: 60_000 });
}

/** Replace the whole editor buffer via the keyboard, which is the only path
 *  that does not depend on `window.monaco` being exposed. */
async function setEditorSource(page: Page, source: string) {
  await waitForEditor(page);
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(source);
}

test.describe("playground lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    // Monaco and the WASM toolchain both need a relaxed CSP; the shipped CSP is
    // asserted separately in the unit suite.
    await page.addInitScript(() => {
      (window as unknown as { __CSP_RELAXED__?: boolean }).__CSP_RELAXED__ =
        true;
      try {
        window.sessionStorage.setItem("render_warning_seen", "true");
        window.localStorage.setItem(
          "soroban.playground.onboarding.v1",
          JSON.stringify({ completed: true, dismissed: true, step: 0 }),
        );
      } catch {}
    });
  });

  test("loads a template from the gallery into the editor", async ({
    page,
  }) => {
    await stubApi(page);

    await page.goto(`${FRONTEND_URL}/template-library`);
    await expect(
      page.getByRole("heading", { name: "Template Library" }).first(),
    ).toBeVisible({
      timeout: 60_000,
    });

    const card = page.getByTestId("template-card-hello-world");
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: "Open in IDE" }).click();

    await expect(page).toHaveURL(/template=hello-world/);
    await expect(page.getByTestId("loaded-template").first()).toHaveText(
      /Loaded from template: hello-world/i,
    );

    // The template's own source, not the editor default.
    await waitForEditor(page);
    await expect(
      page.locator(".monaco-editor .view-lines").first(),
    ).toContainText("HelloContract");
  });

  test("ignores an unknown template id and keeps the default contract", async ({
    page,
  }) => {
    await stubApi(page);

    await page.goto(`${FRONTEND_URL}/playground?template=not-a-real-template`);
    await waitForEditor(page);

    await expect(page.getByTestId("loaded-template")).toHaveCount(0);
    await expect(
      page.locator(".monaco-editor .view-lines").first(),
    ).toContainText("HelloContract");
  });

  test("compiles, deploys and reads state end to end", async ({ page }) => {
    const calls = await stubApi(page);

    await page.goto(`${FRONTEND_URL}/playground`);
    await setEditorSource(page, EDITED_CONTRACT);

    // --- compile ---------------------------------------------------------
    const compileButton = page.getByRole("button", {
      name: "Compile",
      exact: true,
    });
    await expect(compileButton).toBeEnabled();
    await compileButton.click();

    await expect(page.getByText(/Compiled successfully/).first()).toBeVisible({
      timeout: 30_000,
    });
    expect(calls.compile).toBe(1);
    expect(calls.lastCompileBody?.code).toContain("CounterContract");

    // Deploy stays locked until a successful compile.
    const deployButton = page.getByRole("button", { name: /^Deploy to / });
    await expect(deployButton).toHaveAttribute("aria-disabled", "true");
    await page
      .getByRole("button", { name: "Generate salt", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Run pre-flight checks", exact: true })
      .click();
    await expect(deployButton).toHaveAttribute("aria-disabled", "false");
    expect(calls.preflight).toBe(1);

    // --- deploy ----------------------------------------------------------
    await deployButton.click();
    await expect(page.getByText("Active Contract ID").first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(CONTRACT_ID).first()).toBeVisible();
    expect(calls.deploy).toBe(1);

    // --- read state ------------------------------------------------------
    const storage = page.getByRole("heading", { name: "Contract Storage" });
    await expect(storage).toBeVisible();

    const storagePanel = page.locator("div").filter({ has: storage }).first();
    await expect(storagePanel).toContainText("count");
    await expect(storagePanel).toContainText("Contract Storage");
  });

  test("surfaces a compile failure and keeps deploy locked", async ({
    page,
  }) => {
    const calls = await stubApi(page, { compileFails: true });

    await page.goto(`${FRONTEND_URL}/playground`);
    await setEditorSource(page, EDITED_CONTRACT);

    await page.getByRole("button", { name: "Compile", exact: true }).click();

    await expect(
      page.getByText(/expected `env` parameter/).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    expect(calls.compile).toBe(1);

    // A failed build must not unlock deployment.
    await expect(
      page.getByRole("button", { name: /^Deploy to / }),
    ).toBeDisabled();
    expect(calls.deploy).toBe(0);
  });

  test("invokes a contract function after deploying", async ({ page }) => {
    const calls = await stubApi(page);

    await page.goto(`${FRONTEND_URL}/playground`);
    await setEditorSource(page, EDITED_CONTRACT);

    await page.getByRole("button", { name: "Compile", exact: true }).click();
    await expect(page.getByText(/Compiled successfully/).first()).toBeVisible({
      timeout: 30_000,
    });

    await page
      .getByRole("button", { name: "Generate salt", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Run pre-flight checks", exact: true })
      .click();
    await page.getByRole("button", { name: /^Deploy to / }).click();
    await expect(page.getByText(CONTRACT_ID).first()).toBeVisible({
      timeout: 30_000,
    });

    const invokeButton = page.getByRole("button", { name: "Invoke Function" });
    await expect(invokeButton).toBeEnabled({ timeout: 15_000 });
    await invokeButton.click();

    await expect.poll(() => calls.invoke, { timeout: 30_000 }).toBe(1);
  });
});
