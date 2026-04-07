/**
 * E2E tests for MCP tools with a live in-process Verdaccio server.
 * Tests the full stack: MCP tool → ServerManager → Verdaccio → Storage.
 *
 * Requires verdaccio to be installed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
        if (key === 'storageWarningThresholdMb') return 500;
        if (key === 'stalenessThresholdDays') return 90;
        return def;
      },
    }),
    createFileSystemWatcher: () => ({
      onDidCreate: vi.fn(), onDidDelete: vi.fn(), dispose: vi.fn(),
    }),
  },
  window: {
    showWarningMessage: vi.fn(), showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(), withProgress: vi.fn(),
    createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }),
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
  TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string) {} },
  MarkdownString: class { constructor(public value: string = '') {} },
  RelativePattern: class { constructor(public base: string, public pattern: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  ProgressLocation: { Notification: 15 },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

import * as vscode from 'vscode';
import { ServerManager } from '../../serverManager';
import { ConfigManager } from '../../configManager';
import { McpServer } from '../../mcpServer';
import { CacheViewProvider } from '../../cacheViewProvider';
import { StorageAnalyticsProvider } from '../../storageAnalyticsProvider';
import { INpmrcManager } from '../../npmrcManager';
import { IPublishManager } from '../../publishManager';
import { IWorkspacePackageProvider } from '../../workspacePackageProvider';

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

function httpPut(url: string, data: any): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port, path: parsed.pathname,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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

async function publishTestPackage(port: number, name: string, version: string): Promise<void> {
  const tarball = Buffer.alloc(64, 'x');
  const shasum = require('crypto').createHash('sha1').update(tarball).digest('hex');
  const metadata = {
    _id: name, name, description: `Test package ${name}`, readme: '',
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        name, version, description: `Test ${name}@${version}`, readme: '',
        _id: `${name}@${version}`, _npmVersion: '10.0.0', _nodeVersion: '20.0.0',
        dist: { integrity: 'sha512-fake', shasum, tarball: `http://localhost:${port}/${name}/-/${name}-${version}.tgz` },
      },
    },
    access: null,
    _attachments: {
      [`${name}-${version}.tgz`]: {
        content_type: 'application/octet-stream',
        data: tarball.toString('base64'),
        length: tarball.length,
      },
    },
  };
  const res = await httpPut(`http://localhost:${port}/${name}`, metadata);
  if (![200, 201].includes(res.status)) {
    throw new Error(`Publish ${name}@${version} failed: ${res.status} ${res.body}`);
  }
}

const TEST_PORT = 11873 + Math.floor(Math.random() * 1000);

describe.skipIf(!verdaccioAvailable)('MCP Tools with Live Server E2E', () => {
  let tmpDir: string;
  let configManager: ConfigManager;
  let sm: ServerManager;
  let mcpServer: McpServer;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdaccio-e2e-mcp-live-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    configManager = new ConfigManager();

    const configPath = configManager.getConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'storage'), { recursive: true });

    await fs.writeFile(configPath, yaml.dump({
      storage: './storage',
      listen: `0.0.0.0:${TEST_PORT}`,
      max_body_size: '10mb',
      log: { type: 'stdout', format: 'pretty', level: 'error' },
      uplinks: {},
      packages: {
        '@*/*': { access: '$all', publish: '$all', proxy: [] },
        '**': { access: '$all', publish: '$all', proxy: [] },
      },
    }), 'utf-8');

    sm = new ServerManager(configManager);
    await sm.start();

    // Publish some test packages
    await publishTestPackage(TEST_PORT, 'test-lib-alpha', '1.0.0');
    await publishTestPackage(TEST_PORT, 'test-lib-alpha', '1.1.0');
    await publishTestPackage(TEST_PORT, 'test-lib-beta', '2.0.0');
    await publishTestPackage(TEST_PORT, '@myorg/utils', '0.1.0');

    const cacheViewProvider = new CacheViewProvider(configManager);
    const storageAnalyticsProvider = new StorageAnalyticsProvider(configManager);

    mcpServer = new McpServer({
      serverManager: sm, configManager,
      npmrcManager: { setRegistry: vi.fn(), resetRegistry: vi.fn(), addScopedRegistry: vi.fn(), editScopedRegistry: vi.fn(), removeScopedRegistry: vi.fn(), listScopedRegistries: vi.fn().mockResolvedValue([]), addAuthToken: vi.fn(), rotateAuthToken: vi.fn(), removeAuthToken: vi.fn(), listAuthTokens: vi.fn().mockResolvedValue([]), revealToken: vi.fn() } as unknown as INpmrcManager,
      publishManager: { publishToVerdaccio: vi.fn(), promotePackage: vi.fn(), bumpVersion: vi.fn(), checkDuplicate: vi.fn() } as unknown as IPublishManager,
      workspacePackageProvider: { refresh: vi.fn(), detectPackages: vi.fn().mockResolvedValue([]), getPackagesInDependencyOrder: vi.fn().mockResolvedValue([]), publishAll: vi.fn(), unpublishAll: vi.fn(), onDidChangeTreeData: vi.fn(), getTreeItem: vi.fn(), getChildren: vi.fn() } as unknown as IWorkspacePackageProvider,
      storageAnalyticsProvider, cacheViewProvider,
    });
  }, 60000);

  afterAll(async () => {
    if (sm) { await sm.stop(); sm.dispose(); }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('verdaccio_status shows running with correct port', async () => {
    const result = await mcpServer.callTool('verdaccio_status');
    expect(result.success).toBe(true);
    expect((result.data as any).state).toBe('running');
    expect((result.data as any).port).toBe(TEST_PORT);
  });

  it('verdaccio_list_packages returns published packages', async () => {
    const result = await mcpServer.callTool('verdaccio_list_packages');
    expect(result.success).toBe(true);
    const packages = (result.data as any).packages;
    expect(packages.length).toBeGreaterThanOrEqual(3);
    const alpha = packages.find((p: any) => p.name === 'test-lib-alpha');
    expect(alpha).toBeDefined();
    expect(alpha.versions).toContain('1.0.0');
    expect(alpha.versions).toContain('1.1.0');
  });

  it('verdaccio_search filters by pattern', async () => {
    const result = await mcpServer.callTool('verdaccio_search', { pattern: 'alpha' });
    expect(result.success).toBe(true);
    const packages = (result.data as any).packages;
    expect(packages.length).toBe(1);
    expect(packages[0].name).toBe('test-lib-alpha');
  });

  it('verdaccio_cache_stats reflects published packages', async () => {
    const result = await mcpServer.callTool('verdaccio_cache_stats');
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.totalPackages).toBeGreaterThanOrEqual(3);
    expect(data.totalVersions).toBeGreaterThanOrEqual(4);
  });

  it('verdaccio_walk_cache with scope filter', async () => {
    const result = await mcpServer.callTool('verdaccio_walk_cache', { scope: '@myorg' });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.packages.length).toBe(1);
    expect(data.packages[0].name).toBe('@myorg/utils');
  });

  it('verdaccio_walk_cache with pagination', async () => {
    const result = await mcpServer.callTool('verdaccio_walk_cache', { limit: 2, offset: 0 });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.packages.length).toBeLessThanOrEqual(2);
    expect(data.summary.totalPackages).toBeGreaterThanOrEqual(3);
  });

  it('verdaccio_check_cached identifies published packages', async () => {
    const result = await mcpServer.callTool('verdaccio_check_cached', {
      packages: ['test-lib-alpha', 'test-lib-beta', 'nonexistent-pkg'],
    });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.cached).toContain('test-lib-alpha');
    expect(data.cached).toContain('test-lib-beta');
    expect(data.notCached).toContain('nonexistent-pkg');
  });

  it('verdaccio_get_config returns live config', async () => {
    const result = await mcpServer.callTool('verdaccio_get_config');
    expect(result.success).toBe(true);
    expect((result.data as any).config.listen).toContain(String(TEST_PORT));
  });

  it('verdaccio_storage_analytics returns real metrics', async () => {
    const result = await mcpServer.callTool('verdaccio_storage_analytics');
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.packageCount).toBeGreaterThanOrEqual(3);
  });

  it('verdaccio_stop stops the server', async () => {
    const result = await mcpServer.callTool('verdaccio_stop');
    expect(result.success).toBe(true);
    expect(sm.state).toBe('stopped');
  });

  it('verdaccio_start restarts the server', async () => {
    const result = await mcpServer.callTool('verdaccio_start');
    expect(result.success).toBe(true);
    // Wait a moment for the server to be ready
    await new Promise(r => setTimeout(r, 2000));
    expect(sm.state).toBe('running');
  }, 30000);
});
