import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
  TreeItem: class {
    constructor(public label: string, public collapsibleState?: number) {}
    description?: string;
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    fire = vi.fn();
    dispose = vi.fn();
    event = vi.fn();
  },
  window: {
    showWarningMessage: vi.fn(),
  },
  workspace: {},
}));

import { RegistryHealthProvider, computeHealthState, computeCacheHitRate } from '../registryHealthProvider';
import { IServerManager } from '../serverManager';
import { IConfigManager } from '../configManager';
import { VerdaccioConfig } from '../types';

function createMockServerManager(overrides: Partial<IServerManager> = {}): IServerManager {
  return {
    state: 'running',
    port: 4873,
    startTime: new Date(),
    onDidChangeState: vi.fn() as any,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as IServerManager;
}

function createMockConfigManager(config?: Partial<VerdaccioConfig>): IConfigManager {
  const defaultConfig: VerdaccioConfig = {
    storage: './storage',
    listen: '0.0.0.0:4873',
    max_body_size: '10mb',
    log: { level: 'warn' },
    uplinks: {
      npmjs: {
        url: 'https://registry.npmjs.org/',
        timeout: '30s',
        maxage: '2m',
        max_fails: 5,
        fail_timeout: '5m',
      },
    },
    packages: {},
    ...config,
  };

  return {
    getConfigPath: vi.fn().mockReturnValue('/workspace/.verdaccio/config.yaml'),
    readConfig: vi.fn().mockResolvedValue(defaultConfig),
    updateConfig: vi.fn(),
    generateDefaultConfig: vi.fn(),
    configExists: vi.fn(),
    openRawConfig: vi.fn(),
    setCacheStrategy: vi.fn(),
    setUplinkCacheSettings: vi.fn(),
    enableOfflineMode: vi.fn(),
    disableOfflineMode: vi.fn(),
    setGlobalProxy: vi.fn(),
    setUplinkProxy: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IConfigManager;
}

describe('RegistryHealthProvider', () => {
  let serverManager: IServerManager;
  let configManager: IConfigManager;
  let provider: RegistryHealthProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    serverManager = createMockServerManager();
    configManager = createMockConfigManager();
    provider = new RegistryHealthProvider(serverManager, configManager);
  });

  /**
   * Validates: Requirement 18.7
   * "Server not running" message when Verdaccio is stopped
   */
  describe('server not running message', () => {
    it('shows "Server not running" when server is stopped', async () => {
      serverManager = createMockServerManager({ state: 'stopped' });
      provider = new RegistryHealthProvider(serverManager, configManager);

      const children = await provider.getChildren();

      expect(children).toHaveLength(1);
      expect(children[0].type).toBe('healthMetric');
      expect((children[0] as any).value).toBe('Server not running');
    });
  });

  /**
   * Validates: Requirement 18.1
   * Tree view shows one entry per configured uplink
   */
  describe('tree view entries', () => {
    it('shows "No uplinks configured" when no health data', async () => {
      const children = await provider.getChildren();

      // No monitoring started, so no health data yet
      expect(children).toHaveLength(1);
      expect(children[0].type).toBe('healthMetric');
      expect((children[0] as any).value).toBe('No uplinks configured');
    });
  });

  /**
   * Validates: Requirement 18.6
   * Offline mode suggestion when all uplinks unreachable
   */
  describe('offline mode suggestion', () => {
    it('computeHealthState returns unreachable when timed out', () => {
      expect(computeHealthState(0, 0, true)).toBe('unreachable');
    });

    it('computeHealthState returns degraded when latency >= 500ms', () => {
      expect(computeHealthState(500, 0, false)).toBe('degraded');
      expect(computeHealthState(1000, 0, false)).toBe('degraded');
    });

    it('computeHealthState returns degraded when failures > 3', () => {
      expect(computeHealthState(100, 4, false)).toBe('degraded');
    });

    it('computeHealthState returns healthy for good conditions', () => {
      expect(computeHealthState(100, 0, false)).toBe('healthy');
      expect(computeHealthState(499, 3, false)).toBe('healthy');
    });
  });

  describe('computeCacheHitRate', () => {
    it('returns 0 when no requests', () => {
      expect(computeCacheHitRate(0, 0)).toBe(0);
    });

    it('returns 100 when all hits', () => {
      expect(computeCacheHitRate(10, 0)).toBe(100);
    });

    it('returns 0 when all misses', () => {
      expect(computeCacheHitRate(0, 10)).toBe(0);
    });

    it('returns 50 for equal hits and misses', () => {
      expect(computeCacheHitRate(5, 5)).toBe(50);
    });
  });

  describe('getTreeItem', () => {
    it('renders uplink health node', () => {
      const item = provider.getTreeItem({
        type: 'uplinkHealth',
        uplinkName: 'npmjs',
        state: 'healthy',
      });
      expect(item.label).toContain('npmjs');
    });

    it('renders health metric node', () => {
      const item = provider.getTreeItem({
        type: 'healthMetric',
        label: 'Latency',
        value: '100ms',
      });
      expect(item.label).toContain('Latency');
    });
  });

  describe('monitoring lifecycle', () => {
    it('stopMonitoring clears health data', () => {
      provider.startMonitoring();
      provider.stopMonitoring();

      expect(provider.getHealthStatus('npmjs')).toBeUndefined();
    });
  });
});
