import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gatewayDirectory = resolve(root, 'services/dspy-gateway');
let web;
let gateway;
let gatewayFailure;
let stopping = false;
let gatewayReady = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (gateway?.pid && gateway.exitCode === null) {
    // Own the whole reload process tree; never stop a gateway we reused.
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(gateway.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-gateway.pid, 'SIGTERM'); } catch { /* already stopped */ }
    }
  }
  await web?.close();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

async function availablePort(port) {
  const probe = createTcpServer();
  return new Promise((resolvePort, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePort()));
  });
}

async function isGateway(url) {
  try {
    const response = await fetch(`${url}/openapi.json`, { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json()).info?.title === 'SPC DSPy Gateway';
  } catch {
    return false;
  }
}

async function start() {
  const args = process.argv.slice(2).flatMap((arg, i, all) =>
    arg === '--host' && (!all[i + 1] || all[i + 1].startsWith('-')) ? ['--host', '0.0.0.0'] : [arg]);
  const { values } = parseArgs({ args, options: {
    port: { type: 'string' }, host: { type: 'string' }, strictPort: { type: 'boolean' },
    open: { type: 'boolean' }, mode: { type: 'string', default: 'development' },
    force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('npm run dev -- [--port 5173] [--host [address]] [--strictPort] [--open] [--mode development] [--force]');
    console.log('Starts the DSPy gateway and Vite together. Use npm run dev:web for frontend only.');
    return;
  }
  const envPath = resolve(root, process.env.SPC_ENV_FILE || '.env');
  // Match the gateway: the selected .env is authoritative, and credentials stay server-side.
  const fileEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const env = { ...process.env, ...fileEnv };
  const portValue = env.AI_GATEWAY_PORT?.trim() || env.DSPY_GATEWAY_PORT?.trim() || '8001';
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue) || port < 1 || port > 65535) {
    throw new Error('AI_GATEWAY_PORT must be an integer from 1 to 65535.');
  }
  if (values.port && (!/^\d+$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535)) {
    throw new Error('--port must be an integer from 1 to 65535.');
  }
  if (Number(values.port || 5173) === port) {
    throw new Error('The Vite port and AI_GATEWAY_PORT must be different.');
  }
  // Vite reads this same port, including when SPC_ENV_FILE selects a separate config file.
  process.env.AI_GATEWAY_PORT = String(port);
  const url = `http://127.0.0.1:${port}`;
  try {
    await availablePort(port);
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || !await isGateway(url)) {
      throw new Error(`Gateway port ${port} is occupied. Stop its service or choose another AI_GATEWAY_PORT in .env.`);
    }
    console.log(`[SPC] Using the already-running gateway at ${url}.`);
    gatewayReady = true;
  }
  if (!gatewayReady) {
    const uv = spawnSync('uv', ['--version'], { windowsHide: true, stdio: 'ignore' });
    if (uv.error || uv.status !== 0) {
      throw new Error('uv is required to run the AI gateway. On Windows: winget install --id astral-sh.uv -e; then reopen the terminal. On macOS: brew install uv. See SETUP.md for Linux. For frontend only: npm run dev:web.');
    }
    console.log(`[SPC] Starting the AI gateway at ${url}. First start may download Python and its packages.`);
    gateway = spawn('uv', [
      'run', '--frozen', '--project', gatewayDirectory, '--python', '3.12',
      'python', '-B', '-m', 'uvicorn', 'main:app', '--app-dir', gatewayDirectory,
      '--host', '127.0.0.1', '--port', String(port), '--reload', '--reload-dir', gatewayDirectory,
    ], {
      cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: 'inherit',
      env: { ...env, SPC_ENV_FILE: envPath, PYTHONDONTWRITEBYTECODE: '1', SPC_GATEWAY_BIND_PORT: String(port) },
    });
    gateway.on('error', () => { gatewayFailure = new Error('Could not start uv. Check that it is installed and available in PATH.'); });
    gateway.on('exit', (code) => {
      gatewayFailure = new Error(`Gateway stopped (exit ${code}). Review the Python installation or configuration error above.`);
      if (gatewayReady && !stopping) {
        console.error(`[SPC] ${gatewayFailure.message}`);
        void shutdown(1);
      }
    });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (gatewayFailure) throw gatewayFailure;
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).status === 'ok') {
          gatewayReady = true;
          break;
        }
      } catch { /* Installing or starting; do not send a model request. */ }
      await delay(250);
    }
    if (!gatewayReady) throw new Error('The gateway did not start within 3 minutes. Run npm run dev:gateway to inspect its startup.');
    console.log('[SPC] Gateway ready. Starting Vite. Ctrl+C stops both services.');
  }
  const inline = {
    root, mode: values.mode,
    server: {
      ...(values.port && { port: Number(values.port) }),
      ...(values.host && { host: values.host }),
      ...(values.strictPort && { strictPort: true }),
      ...(values.open && { open: true }),
    },
    ...(values.force && { optimizeDeps: { force: true } }),
  };
  web = await createServer(inline);
  await web.listen();
  web.printUrls();
  web.bindCLIShortcuts({ print: true, customShortcuts: [{
    key: 'q', description: 'quit both services', action: () => shutdown(),
  }] });
}

try {
  await start();
} catch (error) {
  console.error(`[SPC] ${error.message}`);
  await shutdown(1);
}
