import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this regression with npm run test:dev');
const fixture = await mkdtemp(join(tmpdir(), 'spc-dev-test-'));
const upstreamKey = 'spc-offline-upstream-key-canary';
let child;
let output = '';

async function freePort() {
  const server = createServer();
  await new Promise((resolvePort, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePort); });
  const port = server.address().port;
  await new Promise(resolvePort => server.close(resolvePort));
  return port;
}
async function portIsClosed(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return !response.ok;
  } catch { return true; }
}
const gatewayPort = await freePort();
let webPort = await freePort();
while (webPort === gatewayPort) webPort = await freePort();
try {
  const envPath = join(fixture, '.env');
  await writeFile(envPath, `AI_API_KEY=${upstreamKey}\nAI_API_URL=http://127.0.0.1:1/v1\nAI_MODEL=spc-offline-test\nAI_GATEWAY_PORT=${gatewayPort}\nAI_GATEWAY_API_KEY=spc-test-browser-token\n`);
  child = spawn(process.execPath, [npmCli, 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    cwd: root, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, SPC_ENV_FILE: envPath }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`npm run dev exited ${child.exitCode}`);
    try { ready = (await fetch(`http://127.0.0.1:${webPort}`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await delay(250);
  }
  assert(ready, 'npm run dev must start the frontend after the gateway');
  const base = `http://127.0.0.1:${webPort}`;
  const config = await fetch(`${base}/config/runtime-config.js`);
  assert.equal(config.status, 200, 'Runtime config must not produce ECONNREFUSED / HTTP 500');
  assert.match(config.headers.get('content-type'), /javascript/);
  const javascript = await config.text();
  assert(!javascript.includes(upstreamKey), 'The upstream key must not enter browser config');
  const sandbox = { window: {} };
  vm.runInNewContext(javascript, sandbox, { timeout: 1000 });
  assert.equal(sandbox.window.APP_CONFIG.AI.API_URL, '/');
  assert.equal(sandbox.window.APP_CONFIG.AI.API_KEY, 'spc-test-browser-token');
  assert.equal(sandbox.window.APP_CONFIG.AI.MODEL, 'spc-offline-test');
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200, 'The gateway must be reachable through the Vite proxy');
  assert.equal((await health.json()).status, 'ok');
  assert(!output.includes('ECONNREFUSED'), 'Startup must not generate the reported proxy error');
  console.log('PASS: npm run dev starts both services, uses the configured gateway port, and serves browser-safe runtime config.');
} catch (error) {
  // Only dummy credentials are used; still redact the canary if an error prints it.
  console.error(output.replaceAll(upstreamKey, '<REDACTED>'));
  console.error(error);
  process.exitCode = 1;
} finally {
  if (child?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  }
  assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
  assert(basename(fixture).startsWith('spc-dev-test-'));
  await rm(fixture, { recursive: true, force: true });
}
for (let i = 0; i < 20; i++) {
  if (await portIsClosed(webPort) && await portIsClosed(gatewayPort)) break;
  await delay(250);
}
assert(await portIsClosed(webPort) && await portIsClosed(gatewayPort), 'Test services must not be left running');
