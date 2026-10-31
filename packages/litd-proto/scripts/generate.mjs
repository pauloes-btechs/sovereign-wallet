#!/usr/bin/env node
/**
 * Regenerates src/generated from the vendored protos.
 *
 * The generated output is COMMITTED — CI and consumers never need protoc.
 * Run this only when re-pinning to a new LND tag (see protos/README.md).
 *
 * protoc binary: @protobuf-ts/protoc's wrapper script (runs on node).
 * TS plugin:     @protobuf-ts/plugin's protoc-gen-ts.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const protosDir = path.join(pkgRoot, 'protos');
const outDir = path.join(pkgRoot, 'src', 'generated');
const protocWrapper = path.join(pkgRoot, 'node_modules/@protobuf-ts/protoc/protoc.js');
const plugin = path.join(pkgRoot, 'node_modules/.bin/protoc-gen-ts');

mkdirSync(outDir, { recursive: true });

const protoFiles = ['lightning.proto', 'walletunlocker.proto', 'router.proto', 'faraday.proto'];
const res = spawnSync(
  process.execPath,
  [
    protocWrapper,
    `--plugin=protoc-gen-ts=${plugin}`,
    `--ts_out=${outDir}`,
    `--proto_path=${protosDir}`,
    ...protoFiles.map((f) => path.join(protosDir, f)),
  ],
  { stdio: 'inherit' },
);
if (res.error ?? res.status !== 0) {
  throw new Error(`protoc generation failed (status ${res.status}): ${res.stderr}`);
}
console.log(`generated into ${outDir}`);
