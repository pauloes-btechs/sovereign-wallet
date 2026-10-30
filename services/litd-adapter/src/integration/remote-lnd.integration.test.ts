import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GetInfoRequest } from '@sovereign/litd-proto';
import {
  adminMacaroonPath,
  bootstrapHarness,
  getNodeInfo,
  tlsCertPath,
  ALICE,
} from '@sovereign/regtest-harness';

import {
  connectionOptionsFromConfig,
  createLightningClient,
  launchLitdSidecar,
  probeRpcReady,
  REMOTE_LND_REQUIREMENTS,
  type LaunchedLitd,
} from '../index.js';
import { sidecarBinaryPath } from './helpers.js';

// Remote-LND connection option: the sidecar runs `lnd-mode=remote` and
// proxies an existing, user-controlled LND. lnd-alice is that node
// (rpcmiddleware enabled per its harness config). Regtest only.

let launched: LaunchedLitd | undefined;
let dataDir: string | undefined;

beforeAll(async () => {
  await bootstrapHarness();
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'litd-remote-'));
  launched = await launchLitdSidecar({
    binaryPath: sidecarBinaryPath(),
    options: {
      network: 'regtest',
      dataDir,
      backend: {
        kind: 'remote-lnd',
        rpcServer: `127.0.0.1:${ALICE.rpcPort}`,
        tlsCertPath: tlsCertPath(ALICE),
        macaroonPath: adminMacaroonPath(ALICE),
      },
    },
  });
  await probeRpcReady(connectionOptionsFromConfig(launched.config), 60_000);
}, 240_000);

afterAll(async () => {
  await launched?.stop();
  if (dataDir !== undefined) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('remote-LND connection option', () => {
  it('discloses the remote-node requirements', () => {
    expect(REMOTE_LND_REQUIREMENTS.disclosure).toMatch(/v0\.19\.0/);
    expect(REMOTE_LND_REQUIREMENTS.disclosure).toMatch(/rpcmiddleware/i);
  });

  it('proxies lnd-alice through the sidecar (same node identity)', async () => {
    const conn = connectionOptionsFromConfig(launched!.config);
    const client = await createLightningClient(conn);
    const throughSidecar = (await client.getInfo(GetInfoRequest.create({})).response).identityPubkey;
    const direct = await getNodeInfo(ALICE);
    expect(throughSidecar).toBe(direct.identityPubkey);
  });
});
