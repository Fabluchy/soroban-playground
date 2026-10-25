import express from 'express';
import request from 'supertest';
import router from '../src/routes/v1/deploy.js';
import { runDeployPreflight } from '../src/services/deployPreflight.js';
import { deployContract } from '../src/services/deployService.js';

jest.mock('../src/middleware/rateLimiter.js', () => ({
  rateLimitMiddleware: () => (req, res, next) => next(),
}));
jest.mock('../src/services/deployPreflight.js', () => ({
  runDeployPreflight: jest.fn(),
}));
jest.mock('../src/services/deployService.js', () => ({
  deployContract: jest.fn(),
  deployBatchContracts: jest.fn(),
}));
const body = {
  wasmPath: 'contract.wasm',
  contractName: 'example',
  network: 'testnet',
  preflight: { salt: 'aa'.repeat(32), expectedWasmHash: 'bb'.repeat(32) },
};
const report = {
  ready: true,
  sourceAccount: 'server-signer',
  contractId: 'CPREVIEW',
  salt: body.preflight.salt,
};
let app;
beforeEach(() => {
  jest.clearAllMocks();
  runDeployPreflight.mockResolvedValue(report);
  deployContract.mockResolvedValue({ contractId: 'CPREVIEW' });
  app = express();
  app.use(express.json());
  app.use('/api/deploy', router);
  app.use((error, req, res, next) =>
    res
      .status(error.status || error.statusCode || 500)
      .json({ message: error.message })
  );
});
test('read-only pre-flight never broadcasts a deployment', async () => {
  const response = await request(app).post('/api/deploy/preflight').send(body);
  expect(response.status).toBe(200);
  expect(deployContract).not.toHaveBeenCalled();
  expect(response.body.contractId).toBe('CPREVIEW');
});
test('Mainnet cannot broadcast without explicit confirmation', async () => {
  const response = await request(app)
    .post('/api/deploy')
    .send({ ...body, network: 'mainnet' });
  expect(response.status).toBe(400);
  expect(runDeployPreflight).not.toHaveBeenCalled();
  expect(deployContract).not.toHaveBeenCalled();
});
test('failed fresh checks cannot broadcast even after a client previously passed', async () => {
  runDeployPreflight.mockResolvedValue({ ...report, ready: false });
  const response = await request(app).post('/api/deploy').send(body);
  expect(response.status).toBe(422);
  expect(deployContract).not.toHaveBeenCalled();
});
test('deployment rechecks the expected hash and binds source, salt and network report to CLI', async () => {
  const response = await request(app).post('/api/deploy').send(body);
  expect(response.status).toBe(200);
  expect(runDeployPreflight).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedWasmHash: body.preflight.expectedWasmHash,
      salt: body.preflight.salt,
      network: 'testnet',
    })
  );
  expect(deployContract).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceAccount: 'server-signer',
      preflight: report,
    })
  );
});
test('malformed salts fail schema validation before any network or broadcast call', async () => {
  const response = await request(app)
    .post('/api/deploy/preflight')
    .send({ ...body, preflight: { salt: 'bad' } });
  expect(response.status).toBe(400);
  expect(runDeployPreflight).not.toHaveBeenCalled();
  expect(deployContract).not.toHaveBeenCalled();
});
