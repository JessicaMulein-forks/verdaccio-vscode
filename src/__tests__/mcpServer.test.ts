import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───

const { mockMkdir, mockWriteFile, mockReadFile, mockReaddir, mockAccess } = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockAccess: vi.fn(),
}));

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    getConfiguration: () => ({
      get: (key: string, def: any) => def,
    }),
  },
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
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
  RelativePattern: class { constructor(public base: string, public pattern: string) {} },
  ProgressLocation: { Notification: 15 },
}));

vi.mock('fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  readdir: mockReaddir,
  access: mockAccess,
}));

import {
  McpServer,
  MCP_TOOL_NAMES,
  wrapSuccess,
  wrapError,
  filterPackagesByPattern,
  walkCache,
  checkCachedPackages,
  computeCacheDiff,
  buildDepTree,
} from '../mcpServer';
import type { McpServerDeps } from '../mcpServer';
import type { IServerManager } from '../serverManager';
import type { IConfigManager } from '../configManager';
import type { INpmrcManager } from '../npmrcManager';
import type { IPublishManager } from '../publishManager';
import type { IWorkspacePackageProvider } from '../workspacePackageProvider';
import type { IStorageAnalyticsProvider } from '../storageAnalyticsProvider';
import type { ICacheViewProvider } from '../cacheViewProvider';

// ─── Mock factories ───

function createMockServerManager(): IServerManager {
  return {
    state: 'running',
    port: 4873,
    startTime: new Date('2024-01-01T00:00:00Z'),
    pid: 1234,
    onDidChangeState: vi.fn() as any,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as any;
}

function createMockConfigManager(): IConfigManager {
  return {
    getConfigPath: vi.fn().mockReturnValue('/workspace/.verdaccio/config.yaml'),
    readConfig: vi.fn().mockResolvedValue({
      storage: './storage',
      listen: '0.0.0.0:4873',
      max_body_size: '10mb',
      log: { level: 'warn' },
      uplinks: { npmjs: { url: 'https://registry.npmjs.org/', timeout: '30s', maxage: '2m', max_fails: 5, fail_timeout: '5m' } },
      packages: {},
    }),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    generateDefaultConfig: vi.fn().mockResolvedValue(undefined),
    configExists: vi.fn().mockResolvedValue(true),
    openRawConfig: vi.fn().mockResolvedValue(undefined),
    setCacheStrategy: vi.fn().mockResolvedValue(undefined),
    setUplinkCacheSettings: vi.fn().mockResolvedValue(undefined),
    enableOfflineMode: vi.fn().mockResolvedValue(undefined),
    disableOfflineMode: vi.fn().mockResolvedValue(undefined),
    setGlobalProxy: vi.fn().mockResolvedValue(undefined),
    setUplinkProxy: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as any;
}

function createMockNpmrcManager(): INpmrcManager {
  return {
    setRegistry: vi.fn().mockResolvedValue(undefined),
    resetRegistry: vi.fn().mockResolvedValue(undefined),
    addScopedRegistry: vi.fn().mockResolvedValue(undefined),
    editScopedRegistry: vi.fn().mockResolvedValue(undefined),
    removeScopedRegistry: vi.fn().mockResolvedValue(undefined),
    listScopedRegistries: vi.fn().mockResolvedValue([]),
    addAuthToken: vi.fn().mockResolvedValue(undefined),
    rotateAuthToken: vi.fn().mockResolvedValue(undefined),
    removeAuthToken: vi.fn().mockResolvedValue(undefined),
    listAuthTokens: vi.fn().mockResolvedValue([]),
    revealToken: vi.fn().mockResolvedValue(''),
  };
}

function createMockPublishManager(): IPublishManager {
  return {
    publishToVerdaccio: vi.fn().mockResolvedValue({ success: true, packageName: 'test-pkg', version: '1.0.0' }),
    promotePackage: vi.fn().mockResolvedValue({ success: true, packageName: 'test-pkg', version: '1.0.0' }),
    bumpVersion: vi.fn().mockResolvedValue('1.0.1'),
    checkDuplicate: vi.fn().mockResolvedValue(false),
  };
}

function createMockWorkspacePackageProvider(): IWorkspacePackageProvider {
  return {
    refresh: vi.fn(),
    detectPackages: vi.fn().mockResolvedValue([]),
    getPackagesInDependencyOrder: vi.fn().mockResolvedValue([]),
    publishAll: vi.fn().mockResolvedValue({ successes: [], failures: [] }),
    unpublishAll: vi.fn().mockResolvedValue(undefined),
    onDidChangeTreeData: vi.fn() as any,
    getTreeItem: vi.fn() as any,
    getChildren: vi.fn() as any,
  } as any;
}

function createMockStorageAnalyticsProvider(): IStorageAnalyticsProvider {
  return {
    refresh: vi.fn(),
    computeAnalytics: vi.fn().mockResolvedValue({
      totalDiskUsageBytes: 1024,
      packageCount: 2,
      versionCount: 5,
      largestPackages: [],
      stalePackageCount: 0,
    }),
    checkThreshold: vi.fn().mockResolvedValue(undefined),
    pruneOldVersions: vi.fn().mockResolvedValue({ deletedCount: 1, freedBytes: 512 }),
    pruneOldVersionsWithConfirmation: vi.fn().mockResolvedValue({ deletedCount: 0, freedBytes: 0 }),
    bulkCleanup: vi.fn().mockResolvedValue({ deletedCount: 0, freedBytes: 0 }),
    bulkCleanupWithConfirmation: vi.fn().mockResolvedValue({ deletedCount: 0, freedBytes: 0 }),
    getStalePackages: vi.fn().mockResolvedValue([]),
    onDidChangeTreeData: vi.fn() as any,
    getTreeItem: vi.fn() as any,
    getChildren: vi.fn() as any,
  } as any;
}

function createMockCacheViewProvider(): ICacheViewProvider {
  return {
    refresh: vi.fn(),
    deletePackage: vi.fn().mockResolvedValue(undefined),
    onDidChangeTreeData: vi.fn() as any,
    getTreeItem: vi.fn() as any,
    getChildren: vi.fn() as any,
  } as any;
}

function createDeps(): McpServerDeps {
  return {
    serverManager: createMockServerManager(),
    configManager: createMockConfigManager(),
    npmrcManager: createMockNpmrcManager(),
    publishManager: createMockPublishManager(),
    workspacePackageProvider: createMockWorkspacePackageProvider(),
    storageAnalyticsProvider: createMockStorageAnalyticsProvider(),
    cacheViewProvider: createMockCacheViewProvider(),
  };
}


// ─── Tests ───

describe('McpServer', () => {
  let deps: McpServerDeps;
  let server: McpServer;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
    // Make storage reads return empty to avoid fs errors in tool handlers
    mockReaddir.mockRejectedValue(new Error('ENOENT'));
    server = new McpServer(deps);
  });

  // ─── Tool registration ───

  describe('tool registration', () => {
    it('should register all 22 MCP tools', () => {
      const registered = server.getRegisteredTools();
      expect(registered.length).toBe(22);
      for (const name of MCP_TOOL_NAMES) {
        expect(registered).toContain(name);
      }
    });
  });

  // ─── Lifecycle ───

  describe('lifecycle', () => {
    it('start() sets isRunning to true', async () => {
      expect(server.isRunning).toBe(false);
      await server.start();
      expect(server.isRunning).toBe(true);
    });

    it('stop() sets isRunning to false', async () => {
      await server.start();
      await server.stop();
      expect(server.isRunning).toBe(false);
    });

    it('getServerCommand returns node command', () => {
      const cmd = server.getServerCommand();
      expect(cmd.command).toBe('node');
      expect(cmd.args.length).toBeGreaterThan(0);
    });

    it('getServerEnv returns production env', () => {
      const env = server.getServerEnv();
      expect(env.NODE_ENV).toBe('production');
    });

    it('onServerReady resolves without error', async () => {
      await expect(server.onServerReady()).resolves.toBeUndefined();
    });

    it('dispose sets isRunning to false', () => {
      (server as any)._running = true;
      server.dispose();
      expect(server.isRunning).toBe(false);
    });
  });

  // ─── Tool delegation ───

  describe('tool delegation', () => {
    it('verdaccio_start delegates to serverManager.start()', async () => {
      const result = await server.callTool('verdaccio_start');
      expect(deps.serverManager.start).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('port');
      expect(result.data).toHaveProperty('pid');
    });

    it('verdaccio_stop delegates to serverManager.stop()', async () => {
      const result = await server.callTool('verdaccio_stop');
      expect(deps.serverManager.stop).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ stopped: true });
    });

    it('verdaccio_status returns server state', async () => {
      const result = await server.callTool('verdaccio_status');
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('state', 'running');
      expect(result.data).toHaveProperty('port', 4873);
      expect(result.data).toHaveProperty('uptimeSeconds');
    });

    it('verdaccio_publish delegates to publishManager', async () => {
      const result = await server.callTool('verdaccio_publish', { directory: '/my/pkg' });
      expect(deps.publishManager.publishToVerdaccio).toHaveBeenCalledWith('/my/pkg');
      expect(result.success).toBe(true);
    });

    it('verdaccio_publish returns error when directory missing', async () => {
      const result = await server.callTool('verdaccio_publish', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('directory');
    });

    it('verdaccio_publish_all delegates to workspacePackageProvider', async () => {
      const result = await server.callTool('verdaccio_publish_all');
      expect(deps.workspacePackageProvider.publishAll).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('verdaccio_set_registry delegates to npmrcManager', async () => {
      const result = await server.callTool('verdaccio_set_registry');
      expect(deps.npmrcManager.setRegistry).toHaveBeenCalledWith('http://localhost:4873');
      expect(result.success).toBe(true);
    });

    it('verdaccio_reset_registry delegates to npmrcManager', async () => {
      const result = await server.callTool('verdaccio_reset_registry');
      expect(deps.npmrcManager.resetRegistry).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('verdaccio_add_scoped_registry delegates to npmrcManager', async () => {
      const result = await server.callTool('verdaccio_add_scoped_registry', {
        scope: '@myorg',
        url: 'https://npm.myorg.com/',
      });
      expect(deps.npmrcManager.addScopedRegistry).toHaveBeenCalledWith('@myorg', 'https://npm.myorg.com/');
      expect(result.success).toBe(true);
    });

    it('verdaccio_add_scoped_registry returns error when params missing', async () => {
      const result = await server.callTool('verdaccio_add_scoped_registry', {});
      expect(result.success).toBe(false);
    });

    it('verdaccio_set_offline_mode enable delegates to configManager', async () => {
      const result = await server.callTool('verdaccio_set_offline_mode', { enable: true });
      expect(deps.configManager.enableOfflineMode).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ offlineMode: true });
    });

    it('verdaccio_set_offline_mode disable delegates to configManager', async () => {
      const result = await server.callTool('verdaccio_set_offline_mode', { enable: false });
      expect(deps.configManager.disableOfflineMode).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('verdaccio_get_config delegates to configManager', async () => {
      const result = await server.callTool('verdaccio_get_config');
      expect(deps.configManager.readConfig).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('config');
    });

    it('verdaccio_update_config delegates to configManager', async () => {
      const result = await server.callTool('verdaccio_update_config', {
        patch: { listen: '0.0.0.0:5000' },
      });
      expect(deps.configManager.updateConfig).toHaveBeenCalledWith({ listen: '0.0.0.0:5000' });
      expect(result.success).toBe(true);
    });

    it('verdaccio_update_config returns error when patch missing', async () => {
      const result = await server.callTool('verdaccio_update_config', {});
      expect(result.success).toBe(false);
    });

    it('verdaccio_storage_analytics delegates to storageAnalyticsProvider', async () => {
      const result = await server.callTool('verdaccio_storage_analytics');
      expect(deps.storageAnalyticsProvider.computeAnalytics).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('totalDiskUsageBytes');
    });

    it('verdaccio_cleanup delegates to storageAnalyticsProvider', async () => {
      const result = await server.callTool('verdaccio_cleanup');
      expect(deps.storageAnalyticsProvider.getStalePackages).toHaveBeenCalled();
      expect(deps.storageAnalyticsProvider.bulkCleanup).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('verdaccio_cleanup with packageNames prunes specific packages', async () => {
      const result = await server.callTool('verdaccio_cleanup', {
        packageNames: ['lodash'],
      });
      expect(deps.storageAnalyticsProvider.pruneOldVersions).toHaveBeenCalledWith('lodash', 0);
      expect(result.success).toBe(true);
    });

    it('verdaccio_cache_stats returns analytics summary', async () => {
      const result = await server.callTool('verdaccio_cache_stats');
      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('totalPackages', 2);
      expect(result.data).toHaveProperty('totalVersions', 5);
    });

    it('unknown tool returns error', async () => {
      const result = await server.callTool('nonexistent_tool');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });
  });

  // ─── Response envelope format ───

  describe('response envelope format', () => {
    it('successful responses have success=true and data', async () => {
      const result = await server.callTool('verdaccio_stop');
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('error responses have success=false and error', async () => {
      const result = await server.callTool('verdaccio_publish', {});
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.data).toBeUndefined();
    });

    it('handler exceptions are caught and wrapped as errors', async () => {
      (deps.serverManager.start as any).mockRejectedValue(new Error('spawn failed'));
      const result = await server.callTool('verdaccio_start');
      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn failed');
    });
  });

  // ─── mcp.json generation ───

  describe('mcp.json generation', () => {
    it('generates .kiro/settings/mcp.json', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await server.generateMcpJson();

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      const writtenContent = JSON.parse(mockWriteFile.mock.calls[0][1]);
      expect(writtenContent.name).toBe('verdaccio-mcp');
      expect(writtenContent.tools).toEqual(MCP_TOOL_NAMES);
    });
  });
});

// ─── Pure function unit tests ───

describe('wrapSuccess', () => {
  it('wraps data with success=true', () => {
    const result = wrapSuccess({ foo: 'bar' });
    expect(result).toEqual({ success: true, data: { foo: 'bar' } });
  });
});

describe('wrapError', () => {
  it('wraps error with success=false', () => {
    const result = wrapError('something broke');
    expect(result).toEqual({ success: false, error: 'something broke' });
  });
});

describe('filterPackagesByPattern', () => {
  it('filters by case-insensitive substring', () => {
    const packages = [
      { name: 'lodash', versions: ['4.17.21'], totalSizeBytes: 100 },
      { name: 'express', versions: ['4.18.0'], totalSizeBytes: 200 },
      { name: 'lodash-es', versions: ['4.17.21'], totalSizeBytes: 150 },
    ];
    const result = filterPackagesByPattern(packages, 'lodash');
    expect(result.length).toBe(2);
    expect(result.map((p) => p.name)).toEqual(['lodash', 'lodash-es']);
  });

  it('returns empty for no matches', () => {
    const packages = [{ name: 'express', versions: [], totalSizeBytes: 0 }];
    expect(filterPackagesByPattern(packages, 'react')).toEqual([]);
  });
});

describe('walkCache', () => {
  const packages: import('../types').CacheWalkerPackage[] = [
    { name: '@org/alpha', scope: '@org', versionCount: 3, totalSizeBytes: 300, origin: 'uplink' },
    { name: 'beta', versionCount: 1, totalSizeBytes: 100, origin: 'published' },
    { name: '@org/gamma', scope: '@org', versionCount: 2, totalSizeBytes: 200, origin: 'uplink' },
    { name: 'delta', versionCount: 5, totalSizeBytes: 500, origin: 'unknown' },
  ];

  it('filters by scope', () => {
    const result = walkCache(packages, { scope: '@org' });
    expect(result.packages.length).toBe(2);
    expect(result.summary.totalPackages).toBe(2);
  });

  it('filters by pattern', () => {
    const result = walkCache(packages, { pattern: 'alpha' });
    expect(result.packages.length).toBe(1);
  });

  it('paginates with offset and limit', () => {
    const result = walkCache(packages, { offset: 1, limit: 2 });
    expect(result.packages.length).toBe(2);
    expect(result.summary.totalPackages).toBe(4); // pre-pagination total
  });

  it('sorts by size descending', () => {
    const result = walkCache(packages, { sortBy: 'size' });
    expect(result.packages[0].totalSizeBytes).toBe(500);
  });
});

describe('checkCachedPackages', () => {
  it('classifies name-only and name@version entries', () => {
    const storageMap = new Map<string, Set<string>>([
      ['lodash', new Set(['4.17.21'])],
      ['express', new Set(['4.18.0'])],
    ]);

    const result = checkCachedPackages(
      ['lodash', 'react', 'express@4.18.0', 'express@5.0.0'],
      storageMap,
    );

    expect(result.cached).toEqual(['lodash', 'express@4.18.0']);
    expect(result.notCached).toEqual(['react', 'express@5.0.0']);
  });
});

describe('computeCacheDiff', () => {
  it('classifies deps into upToDate, outdated, missing', () => {
    const storageMap = new Map<string, Set<string>>([
      ['lodash', new Set(['4.17.21'])],
      ['express', new Set(['4.17.0'])],
    ]);

    const deps = [
      { name: 'lodash', version: '4.17.21' },
      { name: 'express', version: '4.18.0' },
      { name: 'react', version: '18.0.0' },
    ];

    const result = computeCacheDiff(deps, storageMap);
    expect(result.upToDate.length).toBe(1);
    expect(result.upToDate[0].name).toBe('lodash');
    expect(result.outdated.length).toBe(1);
    expect(result.outdated[0].name).toBe('express');
    expect(result.missing.length).toBe(1);
    expect(result.missing[0].name).toBe('react');
  });
});

describe('buildDepTree', () => {
  it('builds tree with correct cached flags', () => {
    const storageMap = new Map<string, Set<string>>([
      ['a', new Set(['1.0.0'])],
      ['b', new Set(['2.0.0'])],
    ]);

    const depMap = new Map<string, Record<string, string>>([
      ['a@1.0.0', { b: '2.0.0', c: '3.0.0' }],
      ['b@2.0.0', {}],
    ]);

    const tree = buildDepTree('a', '1.0.0', storageMap, depMap, 2);
    expect(tree.name).toBe('a');
    expect(tree.cached).toBe(true);
    expect(tree.dependencies.length).toBe(2);

    const bNode = tree.dependencies.find((d) => d.name === 'b');
    expect(bNode?.cached).toBe(true);

    const cNode = tree.dependencies.find((d) => d.name === 'c');
    expect(cNode?.cached).toBe(false);
  });

  it('respects depth limit', () => {
    const storageMap = new Map<string, Set<string>>([
      ['a', new Set(['1.0.0'])],
      ['b', new Set(['1.0.0'])],
      ['c', new Set(['1.0.0'])],
    ]);

    const depMap = new Map<string, Record<string, string>>([
      ['a@1.0.0', { b: '1.0.0' }],
      ['b@1.0.0', { c: '1.0.0' }],
      ['c@1.0.0', { a: '1.0.0' }],
    ]);

    const tree = buildDepTree('a', '1.0.0', storageMap, depMap, 1);
    expect(tree.dependencies.length).toBe(1);
    expect(tree.dependencies[0].dependencies.length).toBe(0); // depth exhausted
  });
});
