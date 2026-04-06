/**
 * E2E tests for McpServer — tests MCP tool invocations with real managers
 * operating on real temp directories. No vscode UI mocking for the tool logic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
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
      onDidCreate: vi.fn(),
      onDidDelete: vi.fn(),
      dispose: vi.fn(),
    }),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    withProgress: vi.fn(),
  },
  EventEmitter: class {
    fire = vi.fn();
    dispose = vi.fn();
    event = vi.fn();
  },
  TreeItem: class {},
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(public id: string) {} },
  MarkdownString: class { constructor(public value: string = '') {} },
  RelativePattern: class { constructor(public base: string, public pattern: string) {} },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  ProgressLocation: { Notification: 15 },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

import * as vscode from 'vscode';
import { McpServer } from '../../mcpServer';
import { ConfigManager } from '../../configManager';
import { CacheViewProvider } from '../../cacheViewProvider';
import { StorageAnalyticsProvider } from '../../storageAnalyticsProvider';
import { IServerManager } from '../../serverManager';
import { INpmrcManager } from '../../npmrcManager';
import { IPublishManager } from '../../publishManager';
import { IWorkspacePackageProvider } from '../../workspacePackageProvider';

function createMockServerManager(): IServerManager {
  return {
    state: 'running', port: 4873, startTime: new Date(), pid: 1234,
    onDidChangeState: vi.fn() as any,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as any;
}

function createMockNpmrcManager(): INpmrcManager {
  return {
    setRegistry: vi.fn().mockResolvedValue(undefined),
    resetRegistry: vi.fn().mockResolvedValue(undefined),
    addScopedRegistry: vi.fn().mockResolvedValue(undefined),
    editScopedRegistry: vi.fn(),
    removeScopedRegistry: vi.fn(),
    listScopedRegistries: vi.fn().mockResolvedValue([]),
    addAuthToken: vi.fn(),
    rotateAuthToken: vi.fn(),
    removeAuthToken: vi.fn(),
    listAuthTokens: vi.fn().mockResolvedValue([]),
    revealToken: vi.fn(),
  };
}

function createMockPublishManager(): IPublishManager {
  return {
    publishToVerdaccio: vi.fn().mockResolvedValue({ success: true, packageName: 'test', version: '1.0.0' }),
    promotePackage: vi.fn(),
    bumpVersion: vi.fn(),
    checkDuplicate: vi.fn().mockResolvedValue(false),
  };
}

function createMockWorkspacePackageProvider(): IWorkspacePackageProvider {
  return {
    refresh: vi.fn(),
    detectPackages: vi.fn().mockResolvedValue([]),
    getPackagesInDependencyOrder: vi.fn().mockResolvedValue([]),
    publishAll: vi.fn().mockResolvedValue({ successes: [], failures: [] }),
    unpublishAll: vi.fn(),
    onDidChangeTreeData: vi.fn() as any,
    getTreeItem: vi.fn() as any,
    getChildren: vi.fn() as any,
  } as any;
}

describe('McpServer E2E', () => {
  let tmpDir: string;
  let configManager: ConfigManager;
  let cacheViewProvider: CacheViewProvider;
  let storageAnalyticsProvider: StorageAnalyticsProvider;
  let mcpServer: McpServer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdaccio-e2e-mcp-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];

    configManager = new ConfigManager();
    await configManager.generateDefaultConfig();

    cacheViewProvider = new CacheViewProvider(configManager);
    storageAnalyticsProvider = new StorageAnalyticsProvider(configManager);

    mcpServer = new McpServer({
      serverManager: createMockServerManager(),
      configManager,
      npmrcManager: createMockNpmrcManager(),
      publishManager: createMockPublishManager(),
      workspacePackageProvider: createMockWorkspacePackageProvider(),
      storageAnalyticsProvider,
      cacheViewProvider,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('verdaccio_get_config returns real config from disk', async () => {
    const result = await mcpServer.callTool('verdaccio_get_config');
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty('config');
    expect((result.data as any).config.listen).toBe('0.0.0.0:4873');
    expect((result.data as any).config.storage).toBe('./storage');
  });

  it('verdaccio_update_config patches real config on disk', async () => {
    await mcpServer.callTool('verdaccio_update_config', { patch: { listen: '0.0.0.0:9999' } });

    const result = await mcpServer.callTool('verdaccio_get_config');
    expect((result.data as any).config.listen).toBe('0.0.0.0:9999');

    // Verify on disk
    const configPath = configManager.getConfigPath();
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = yaml.load(raw) as any;
    expect(parsed.listen).toBe('0.0.0.0:9999');
  });

  it('verdaccio_status returns server state', async () => {
    const result = await mcpServer.callTool('verdaccio_status');
    expect(result.success).toBe(true);
    expect((result.data as any).state).toBe('running');
    expect((result.data as any).port).toBe(4873);
  });

  it('verdaccio_set_offline_mode enable/disable round-trips config', async () => {
    const enableResult = await mcpServer.callTool('verdaccio_set_offline_mode', { enable: true });
    expect(enableResult.success).toBe(true);

    const configAfterEnable = await configManager.readConfig();
    expect(configAfterEnable.uplinks.npmjs.max_fails).toBe(0);
    expect(configAfterEnable.uplinks.npmjs.fail_timeout).toBe('0');

    const disableResult = await mcpServer.callTool('verdaccio_set_offline_mode', { enable: false });
    expect(disableResult.success).toBe(true);
  });

  it('verdaccio_storage_analytics returns metrics from real storage', async () => {
    // Create a fake storage directory with a package
    const storagePath = path.join(tmpDir, 'storage');
    const pkgDir = path.join(storagePath, 'lodash');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
      versions: {
        '4.17.21': { description: 'Lodash', _size: 1024 },
      },
    }), 'utf-8');

    const result = await mcpServer.callTool('verdaccio_storage_analytics');
    expect(result.success).toBe(true);
    expect((result.data as any).packageCount).toBeGreaterThanOrEqual(1);
  });

  it('verdaccio_list_packages returns packages from real storage', async () => {
    const storagePath = path.join(tmpDir, 'storage');
    const pkgDir = path.join(storagePath, 'express');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
      versions: { '4.18.0': { _size: 512 }, '4.19.0': { _size: 768 } },
    }), 'utf-8');

    const result = await mcpServer.callTool('verdaccio_list_packages');
    expect(result.success).toBe(true);
    const packages = (result.data as any).packages;
    expect(packages.length).toBeGreaterThanOrEqual(1);
    const express = packages.find((p: any) => p.name === 'express');
    expect(express).toBeDefined();
    expect(express.versions).toContain('4.18.0');
    expect(express.versions).toContain('4.19.0');
  });

  it('verdaccio_search filters packages by pattern', async () => {
    const storagePath = path.join(tmpDir, 'storage');
    for (const name of ['lodash', 'express', 'lodash-es']) {
      const dir = path.join(storagePath, name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
        versions: { '1.0.0': { _size: 100 } },
      }), 'utf-8');
    }

    const result = await mcpServer.callTool('verdaccio_search', { pattern: 'lodash' });
    expect(result.success).toBe(true);
    const packages = (result.data as any).packages;
    expect(packages.length).toBe(2);
    expect(packages.every((p: any) => p.name.includes('lodash'))).toBe(true);
  });

  it('verdaccio_cache_stats returns summary from real storage', async () => {
    const storagePath = path.join(tmpDir, 'storage');
    const pkgDir = path.join(storagePath, 'react');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
      versions: { '18.0.0': { _size: 2048 }, '18.1.0': { _size: 3072 } },
    }), 'utf-8');

    const result = await mcpServer.callTool('verdaccio_cache_stats');
    expect(result.success).toBe(true);
    expect((result.data as any).totalPackages).toBeGreaterThanOrEqual(1);
    expect((result.data as any).totalVersions).toBeGreaterThanOrEqual(2);
  });

  it('verdaccio_walk_cache with scope filter on real scoped packages', async () => {
    const storagePath = path.join(tmpDir, 'storage');
    const scopeDir = path.join(storagePath, '@myorg');
    const pkgDir = path.join(scopeDir, 'utils');
    await fs.mkdir(pkgDir, { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({
      versions: { '1.0.0': { _size: 256, description: 'Utils' } },
    }), 'utf-8');

    // Also add an unscoped package
    const unscopedDir = path.join(storagePath, 'lodash');
    await fs.mkdir(unscopedDir, { recursive: true });
    await fs.writeFile(path.join(unscopedDir, 'package.json'), JSON.stringify({
      versions: { '4.17.21': { _size: 1024 } },
    }), 'utf-8');

    const result = await mcpServer.callTool('verdaccio_walk_cache', { scope: '@myorg' });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.packages.length).toBe(1);
    expect(data.packages[0].scope).toBe('@myorg');
  });

  it('generates mcp.json discovery file', async () => {
    await mcpServer.generateMcpJson();

    const mcpJsonPath = path.join(tmpDir, '.kiro', 'settings', 'mcp.json');
    const content = await fs.readFile(mcpJsonPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.name).toBe('verdaccio-mcp');
    expect(parsed.tools).toHaveLength(22);
  });

  it('unknown tool returns structured error', async () => {
    const result = await mcpServer.callTool('nonexistent_tool');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  it('all 22 tools are registered', () => {
    const tools = mcpServer.getRegisteredTools();
    expect(tools).toHaveLength(22);
  });
});
