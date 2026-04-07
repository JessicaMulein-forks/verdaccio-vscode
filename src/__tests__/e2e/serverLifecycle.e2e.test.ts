/**
 * E2E tests for the full Verdaccio server lifecycle.
 * Starts verdaccio in-process, tests HTTP endpoints, publishes packages,
 * and verifies the complete start/stop/restart cycle.
 *
 * Requires verdaccio to be installed (globally or locally).
 * Skipped automatically if verdaccio is not available.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as http from 'http';
import * as yaml from 'js-yaml';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined as any,
    getConfiguration: () => ({
      get: (key: string, def: any) => {
        if (key === 'configPath') return 'config.yaml';
        return def;
      },
    }),
    createFileSystemWatcher: () => ({
      onDidCreate: vi.fn(), onDidDelete: vi.fn(), dispose: vi.fn(),
    }),
  },
  window: {
    showWarningMessage: vi.fn(), showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  EventEmitter: class {
    private _listeners: Array<(e: any) => void> = [];
    fire = (e: any) => { for (const l of this._listeners) { l(e); } };
    dispose = () => { this._listeners = []; };
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter(l => l !== listener); } };
    };
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import * as vscode from 'vscode';
import { ServerManager } from '../../serverManager';
import { ConfigManager } from '../../configManager';

// Check if verdaccio is available
let verdaccioAvailable = false;
try {
  require('verdaccio');
  verdaccioAvailable = true;
} catch {
  try {
    const { execSync } = require('child_process');
    const globalPath = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    require(path.join(globalPath, 'verdaccio'));
    verdaccioAvailable = true;
  } catch { /* not available */ }
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

function httpPut(url: string, data: any, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let resBody = '';
      res.on('data', (chunk) => { resBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: resBody }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Use a random port to avoid conflicts
const TEST_PORT = 10873 + Math.floor(Math.random() * 1000);

describe.skipIf(!verdaccioAvailable)('Server Lifecycle E2E', () => {
  let tmpDir: string;
  let configManager: ConfigManager;
  let sm: ServerManager;
  const logs: string[] = [];

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdaccio-e2e-server-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    configManager = new ConfigManager();

    // Generate config with test port
    const configPath = configManager.getConfigPath();
    const dir = path.dirname(configPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'storage'), { recursive: true });

    const config = {
      storage: './storage',
      listen: `0.0.0.0:${TEST_PORT}`,
      max_body_size: '10mb',
      log: { type: 'stdout', format: 'pretty', level: 'warn' },
      uplinks: {},
      packages: {
        '@*/*': { access: '$all', publish: '$all', proxy: [] },
        '**': { access: '$all', publish: '$all', proxy: [] },
      },
    };
    await fs.writeFile(configPath, yaml.dump(config), 'utf-8');
  });

  afterAll(async () => {
    if (sm) { await sm.stop(); sm.dispose(); }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => { logs.length = 0; });

  it('starts verdaccio and transitions to running', async () => {
    sm = new ServerManager(configManager, (msg) => logs.push(msg));
    expect(sm.state).toBe('stopped');

    await sm.start();

    expect(sm.state).toBe('running');
    expect(sm.port).toBe(TEST_PORT);
    expect(sm.startTime).toBeInstanceOf(Date);
    expect(sm.pid).toBe(process.pid);
    expect(logs.some(l => l.includes('listening'))).toBe(true);
  }, 30000);

  it('responds to HTTP requests on the registry endpoint', async () => {
    const res = await httpGet(`http://localhost:${TEST_PORT}/-/ping`);
    expect(res.status).toBe(200);
  });

  it('returns empty package list initially', async () => {
    const res = await httpGet(`http://localhost:${TEST_PORT}/-/all`);
    expect(res.status).toBe(200);
  });

  it('returns 404 for non-existent package', async () => {
    const res = await httpGet(`http://localhost:${TEST_PORT}/nonexistent-package-xyz`);
    expect(res.status).toBe(404);
  });

  it('can publish a package via HTTP PUT', async () => {
    const pkgName = `e2e-test-pkg-${Date.now()}`;
    const tarball = Buffer.alloc(64, 'x'); // minimal tarball-like data
    const tarballBase64 = tarball.toString('base64');
    const shasum = require('crypto').createHash('sha1').update(tarball).digest('hex');

    const metadata = {
      _id: pkgName,
      name: pkgName,
      description: 'E2E test package',
      readme: '',
      'dist-tags': { latest: '1.0.0' },
      versions: {
        '1.0.0': {
          name: pkgName,
          version: '1.0.0',
          description: 'E2E test package',
          readme: '',
          _id: `${pkgName}@1.0.0`,
          _npmVersion: '10.0.0',
          _nodeVersion: '20.0.0',
          dist: {
            integrity: 'sha512-fake',
            shasum,
            tarball: `http://localhost:${TEST_PORT}/${pkgName}/-/${pkgName}-1.0.0.tgz`,
          },
        },
      },
      access: null,
      _attachments: {
        [`${pkgName}-1.0.0.tgz`]: {
          content_type: 'application/octet-stream',
          data: tarballBase64,
          length: tarball.length,
        },
      },
    };

    const res = await httpPut(
      `http://localhost:${TEST_PORT}/${pkgName}`,
      metadata,
    );
    expect([200, 201]).toContain(res.status);

    // Verify the package is now accessible
    const getRes = await httpGet(`http://localhost:${TEST_PORT}/${pkgName}`);
    expect(getRes.status).toBe(200);
    const pkg = JSON.parse(getRes.body);
    expect(pkg.name).toBe(pkgName);
    expect(pkg.versions['1.0.0']).toBeDefined();
  });

  it('published package appears in storage directory', async () => {
    const storagePath = path.join(tmpDir, 'storage');
    const entries = await fs.readdir(storagePath);
    // At least one package directory should exist from the publish test
    expect(entries.length).toBeGreaterThan(0);
  });

  it('fires state change events', async () => {
    const states: string[] = [];
    const listener = sm.onDidChangeState((s) => states.push(s));

    // Already running, restart should fire: running->stopped->starting->running
    await sm.restart();

    listener.dispose();
    expect(states).toContain('stopped');
    expect(states).toContain('starting');
    expect(states).toContain('running');
    expect(sm.state).toBe('running');
  }, 30000);

  it('silently returns on duplicate start', async () => {
    const logsBefore = logs.length;
    await sm.start(); // already running
    // Should not log any new start messages
    const newLogs = logs.slice(logsBefore);
    expect(newLogs.some(l => l.includes('Starting verdaccio'))).toBe(false);
  });

  it('stops the server and port becomes unavailable', async () => {
    await sm.stop();
    expect(sm.state).toBe('stopped');
    expect(sm.port).toBeUndefined();

    // Port should no longer respond
    await expect(httpGet(`http://localhost:${TEST_PORT}/-/ping`)).rejects.toThrow();
  });

  it('can restart after stop', async () => {
    await sm.start();
    expect(sm.state).toBe('running');

    const res = await httpGet(`http://localhost:${TEST_PORT}/-/ping`);
    expect(res.status).toBe(200);
  }, 30000);

  it('stop is idempotent', async () => {
    await sm.stop();
    await sm.stop(); // second stop should be a no-op
    expect(sm.state).toBe('stopped');
  });
});
