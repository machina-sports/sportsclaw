/** Offline doctor regressions. All executables below are inert fixtures. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'sc-doctor-target-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
let serial = 0;
function doctor(args = [], flags = {}) {
  const home = join(scratch, String(serial++));
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(home, 'argv.jsonl');
  for (const name of ['openshell', 'docker', 'podman']) {
    writeFileSync(join(bin, name), `#!${process.execPath}\n` + `
const fs = require('node:fs');
const name = ${JSON.stringify(name)};
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify([name, ...args]) + '\\n');
if (name !== 'openshell') {
  if (process.env.NO_RUNTIME === '1' || (process.env.PODMAN_ONLY === '1' && name === 'docker')) process.exit(1);
  process.exit(0);
}
if (args[0] === '--version') console.log('openshell 0.1.5');
else if (args[0] === 'gateway') console.log('[{"name":"fixture"}]');
else if (args[0] === 'provider') {
  if (process.env.NO_PROVIDER === '1') process.exit(1);
  console.log('fixture-provider');
}
else if (args[0] === 'sandbox' && args[1] === 'create' && process.env.FAIL_CREATE === '1') {
  console.error('error: fixture create failure'); process.exit(1);
}
`, { mode: 0o755 });
  }
  const result = spawnSync(process.execPath, [entry, 'openshell', 'doctor', ...args], {
    encoding: 'utf8', timeout: 15000,
    env: { HOME: home, PATH: bin, TMPDIR: scratch, CI: '1', NO_COLOR: '1', SPORTSCLAW_MEMORY_BACKEND: 'file', ARGV_LOG: log, ...flags },
  });
  assert.ifError(result.error);
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { ...result, calls };
}
const custom = 'registry.example.invalid/team/sportsclaw-openshell:fixture';

test('remote doctor does not require or invoke local runtimes and labels omitted checks', () => {
  const r = doctor(['--remote', '--image', custom, '--json'], { NO_RUNTIME: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).allOk, true);
  assert.ok(r.calls.every(([name]) => name === 'openshell'), JSON.stringify(r.calls));
  assert.match(r.stdout, /skipped|not checked/i);
  assert.ok(!r.calls.some(([, a]) => a === 'sandbox'));
});

test('local doctor inspects the selected image without starting a sandbox', () => {
  const r = doctor(['--image', custom, '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.calls.find(([name, a]) => name === 'docker' && a === 'image'), ['docker', 'image', 'inspect', custom]);
  assert.match(r.stdout, /registry\.example\.invalid/);
  assert.ok(!r.calls.some(([, a]) => a === 'sandbox'));
});

test('explicit probe uses selected OpenShell image and cleans up the same fixture name', () => {
  const r = doctor(['--remote', '--image', custom, '--probe', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const create = r.calls.find(([, a, b]) => a === 'sandbox' && b === 'create');
  assert.equal(create[create.indexOf('--from') + 1], custom);
  const name = create[create.indexOf('--name') + 1];
  assert.deepEqual(r.calls.find(([, a, b]) => a === 'sandbox' && b === 'delete'), ['openshell', 'sandbox', 'delete', name]);
  assert.ok(r.calls.every(([name]) => name === 'openshell'));
});

test('default probe uses the OpenShell image, not the base image', () => {
  const r = doctor(['--probe', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const create = r.calls.find(([, a, b]) => a === 'sandbox' && b === 'create');
  assert.equal(create[create.indexOf('--from') + 1], 'sportsclaw-openshell:latest');
});

test('failed probe remediation names the selected image', () => {
  const r = doctor(['--remote', '--image', custom, '--probe', '--json'], { FAIL_CREATE: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const check = JSON.parse(r.stdout).results.find(r => r.id === 'compute-driver');
  assert.ok(check.hint.includes(custom), check.hint);
  assert.ok(!check.hint.includes('--from sportsclaw:latest'));
});

test('missing image argument is rejected before any probe', () => {
  const r = doctor(['--image', '--json']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual(r.calls, []);
});

test('local podman detection uses podman to inspect the selected image', () => {
  const r = doctor(['--image', custom, '--json'], { PODMAN_ONLY: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.calls.find(([name, a]) => name === 'podman' && a === 'image'), ['podman', 'image', 'inspect', custom]);
  assert.ok(!r.calls.some(([name, a]) => name === 'docker' && a === 'image'));
});

test('remote human output identifies unperformed local checks', () => {
  const r = doctor(['--remote'], { NO_RUNTIME: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All requested checks passed/);
  assert.match(r.stdout, /2 not checked/);
  assert.match(r.stdout, /NOT verified/);
});

test('remote mode cannot turn a missing provider into success', () => {
  const r = doctor(['--remote', '--json'], { NO_RUNTIME: '1', NO_PROVIDER: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).allOk, false);
  assert.equal(JSON.parse(r.stdout).results.find(r => r.id === 'provider').status, 'missing');
  assert.ok(r.calls.every(([name]) => name === 'openshell'));
});

test('local mode still reports absent local runtime', () => {
  const r = doctor(['--json'], { NO_RUNTIME: '1' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).results.find(r => r.id === 'container-runtime').status, 'missing');
});
