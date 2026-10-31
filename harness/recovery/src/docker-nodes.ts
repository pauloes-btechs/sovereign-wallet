/**
 * Docker node control for the recovery drills.
 *
 * The drills stop, WIPE, and restart compose nodes to simulate a lost node.
 * Container-created credential files (tls.cert, admin.macaroon) can be
 * root-owned on the host (the CI chown runs once at bootstrap, before the
 * drills create new files), so every credential read in this suite goes
 * through `docker compose exec ... cat` — the drills never depend on host
 * file ownership. REGTEST ONLY — every operation here is destructive by
 * design and guarded by the regtest assertion in the drill files.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  CallCredentials,
  ChannelCredentials,
  Metadata,
} from '@grpc/grpc-js';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import {
  ALICE,
  BOB,
  HARNESS_ROOT,
  LITD,
  type HarnessNode,
} from '@sovereign/harness-regtest';
import {
  GetInfoRequest,
  LightningClient,
  WalletUnlockerClient,
} from '@sovereign/litd-proto';

const execFileP = promisify(execFile);

const COMPOSE_FILE = join(HARNESS_ROOT, 'docker-compose.yml');

/** Compose service backing a harness node (bind-mounts /root/.lnd). */
function serviceFor(node: HarnessNode): string {
  if (node === ALICE) return 'lnd-alice';
  if (node === BOB) return 'lnd-bob';
  if (node === LITD) return 'litd';
  throw new Error(`no compose service maps to harness node ${node.name}`);
}

async function compose(...args: string[]): Promise<string> {
  return execFileP('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    timeout: 120_000,
  }).then((r) => r.stdout);
}

/** Stops or starts a compose service. */
export async function composeService(action: 'stop' | 'start', node: HarnessNode): Promise<void> {
  await compose(action, serviceFor(node));
}

/**
 * Wipes a node's entire LND data directory (wallet, channels, macaroons)
 * inside the container's bind mount, leaving the directory itself — the
 * exact on-disk effect of losing a node with no backups. The service must
 * be running afterwards for the drills to re-initialize it.
 */
export async function wipeNodeData(node: HarnessNode): Promise<void> {
  const service = serviceFor(node);
  await compose('stop', service);
  // A one-off container on the same bind mount does the deleting — no
  // dependency on host-side ownership of the wiped files. The mount point
  // itself cannot be removed from inside, so its CONTENTS are.
  await compose(
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    service,
    '-c',
    'rm -rf /root/.lnd/* /root/.lnd/.[!.]* 2>/dev/null; exit 0',
  );
  await compose('start', service);
}

/** `docker compose exec <service> cat <path>` — reads container-side files. */
async function execCat(node: HarnessNode, containerPath: string): Promise<Buffer> {
  const { stdout } = await execFileP(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'exec', '-T', serviceFor(node), 'cat', containerPath],
    { timeout: 30_000, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout as unknown as Buffer;
}

function macaroonCallCredentials(hex: string): CallCredentials {
  return CallCredentials.createFromMetadataGenerator((_options, callback) => {
    const metadata = new Metadata();
    metadata.add('macaroon', hex);
    callback(null, metadata);
  });
}

/** Chain guard for every destructive drill: refuses anything but regtest. */
export async function assertRegtestOnly(node: HarnessNode): Promise<void> {
  const transport = await nodeTransport(node, { macaroon: true });
  const client = new LightningClient(transport);
  try {
    const info = await client.getInfo(GetInfoRequest.create({})).response;
    const isRegtest = info.chains.some((c) => c.network === 'regtest');
    if (!isRegtest) {
      const seen = info.chains.map((c) => `${c.chain}/${c.network}`).join(', ') || 'none';
      throw new Error(`SAFETY: drill refused — ${node.name} reports chains [${seen}], not regtest`);
    }
  } finally {
    transport.close();
  }
}

async function nodeTransport(
  node: HarnessNode,
  opts: { macaroon: boolean },
): Promise<GrpcTransport> {
  const cert = await execCat(node, '/root/.lnd/tls.cert');
  let creds = ChannelCredentials.createSsl(cert);
  if (opts.macaroon) {
    const macaroon = await execCat(
      node,
      '/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon',
    );
    creds = creds.compose(macaroonCallCredentials(macaroon.toString('hex')));
  }
  return new GrpcTransport({ host: `${node.rpcHost}:${node.rpcPort}`, channelCredentials: creds });
}

/**
 * macaroon-authenticated transport over exec-read credentials — the drill
 * owns (and closes) it. Ownership-independent: safe against re-created,
 * root-owned credential files after a wipe.
 */
export function execTransport(node: HarnessNode): Promise<GrpcTransport> {
  return nodeTransport(node, { macaroon: true });
}

/** Waits until the node's freshly written TLS cert exists (container-side). */
export async function waitForContainerCert(node: HarnessNode, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await execCat(node, '/root/.lnd/tls.cert');
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`${node.name} TLS cert never appeared in the container within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Waits until the admin macaroon exists (wallet initialized) container-side. */
export async function waitForContainerMacaroon(node: HarnessNode, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await execCat(node, '/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon');
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`${node.name} admin macaroon never appeared within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** LightningClient over exec-read credentials — ownership-independent. */
export async function execLightningClient(node: HarnessNode): Promise<LightningClient> {
  return new LightningClient(await nodeTransport(node, { macaroon: true }));
}

/** WalletUnlockerClient over exec-read TLS (no macaroon pre-init). */
export async function execUnlockerClient(node: HarnessNode): Promise<WalletUnlockerClient> {
  return new WalletUnlockerClient(await nodeTransport(node, { macaroon: false }));
}
