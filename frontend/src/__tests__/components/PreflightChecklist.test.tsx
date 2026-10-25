import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PreflightChecklist } from "@/components/Deploy/PreflightChecklist";

const report = {
  ready: true,
  sourceAccount: "deployer",
  deployer: "GDEPLOYER",
  contractId: "CPREVIEW",
  wasmHash: "ab".repeat(32),
  codeStatus: "live",
  checkedAt: 0,
  elapsedMs: 120,
  funding: {
    reserveStroops: "10000000",
    availableStroops: "50000000",
    feeStroops: "1000",
  },
  checks: [{ id: "balance", label: "XLM balance", passed: true }],
  warnings: [],
};
function mount() {
  const onPlanChange = jest.fn();
  const view = render(
    <PreflightChecklist
      apiBaseUrl="http://localhost"
      wasmPath="contract.wasm"
      enabled
      onPlanChange={onPlanChange}
    />,
  );
  return { ...view, onPlanChange };
}
async function check() {
  fireEvent.change(screen.getByLabelText(/Deployment salt/), {
    target: { value: "aa".repeat(32) },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Run pre-flight checks" }),
  );
  await waitFor(() => expect(screen.getByText("CPREVIEW")).toBeInTheDocument());
}
beforeEach(() => {
  jest.clearAllMocks();
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ ...report, checkedAt: Date.now() }),
  });
});
test("starts blocked and rejects invalid salts without sending requests", () => {
  const { onPlanChange } = mount();
  expect(onPlanChange).toHaveBeenLastCalledWith(null);
  fireEvent.click(
    screen.getByRole("button", { name: "Run pre-flight checks" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("64 hexadecimal");
  expect(fetch).not.toHaveBeenCalled();
});
test("publishes only the checked network, salt, source and hash and invalidates on change", async () => {
  const { onPlanChange } = mount();
  await check();
  await waitFor(() =>
    expect(onPlanChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: "testnet",
        sourceAccount: "deployer",
        preflight: expect.objectContaining({
          expectedWasmHash: report.wasmHash,
        }),
      }),
    ),
  );
  fireEvent.change(screen.getByLabelText("Deployment network"), {
    target: { value: "local" },
  });
  expect(onPlanChange).toHaveBeenLastCalledWith(null);
  expect(screen.queryByText("CPREVIEW")).not.toBeInTheDocument();
});
test("Mainnet requires explicit confirmation after checks pass", async () => {
  const { onPlanChange } = mount();
  fireEvent.change(screen.getByLabelText("Deployment network"), {
    target: { value: "mainnet" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("real XLM");
  await check();
  expect(onPlanChange).toHaveBeenLastCalledWith(null);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /I confirm deployment to Mainnet/ }),
  );
  await waitFor(() =>
    expect(onPlanChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: "mainnet",
        preflight: expect.objectContaining({ mainnetConfirmed: true }),
      }),
    ),
  );
});
test("insufficient balance never enables deployment", async () => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({
      ...report,
      ready: false,
      checkedAt: Date.now(),
      checks: [{ id: "balance", label: "XLM balance", passed: false }],
    }),
  });
  const { onPlanChange } = mount();
  await check();
  expect(onPlanChange).toHaveBeenLastCalledWith(null);
  expect(screen.getByText("Blocked: XLM balance")).toBeInTheDocument();
});
test("network failures remain blocked with a visible explanation", async () => {
  (global.fetch as jest.Mock).mockRejectedValue(new Error("RPC unavailable"));
  const { onPlanChange } = mount();
  fireEvent.change(screen.getByLabelText(/Deployment salt/), {
    target: { value: "aa".repeat(32) },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Run pre-flight checks" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("RPC unavailable"),
  );
  expect(onPlanChange).toHaveBeenLastCalledWith(null);
});
test("expires the authorization after 30 seconds", async () => {
  const { onPlanChange } = mount();
  await check();
  jest.useFakeTimers();
  // Re-run with fake timers so the expiry timer is registered on that clock.
  fireEvent.click(
    screen.getByRole("button", { name: "Run pre-flight checks" }),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => jest.advanceTimersByTime(30001));
  expect(onPlanChange).toHaveBeenLastCalledWith(null);
  jest.useRealTimers();
});
