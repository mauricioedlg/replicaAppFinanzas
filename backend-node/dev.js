import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';

const args = process.argv.slice(2);
process.env.NODE_DEBUG_MODE = 'true';
const config = loadConfig({ args });
const vite = fileURLToPath(new URL('../frontend/node_modules/vite/bin/vite.js', import.meta.url));
const index = new URL('../frontend/dist/index.html', import.meta.url);
if (config.built && !existsSync(index)) throw new Error('Compila React con npm run build en frontend/.');
if (!config.built && !existsSync(vite)) throw new Error('Instala las dependencias con npm ci en frontend/.');

const env = { ...process.env };
const processes = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of processes) if (child.exitCode === null && !child.signalCode) child.kill();
}
function start(entry, argv, options = {}) {
  const child = spawn(process.execPath, [entry, ...argv], { stdio: 'inherit', env, ...options });
  processes.push(child);
  child.on('exit', (code) => stop(code ?? 1));
  child.on('error', (error) => { console.error(error.message); stop(1); });
}
start(fileURLToPath(new URL('./server.js', import.meta.url)), args);
if (!config.built) {
  start(vite, ['--host', '127.0.0.1', '--strictPort', '--configLoader', 'runner'], {
    cwd: fileURLToPath(new URL('../frontend/', import.meta.url)),
    env: { ...env, API_PROXY_TARGET: env.API_PROXY_TARGET || `http://127.0.0.1:${config.port}` },
  });
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
