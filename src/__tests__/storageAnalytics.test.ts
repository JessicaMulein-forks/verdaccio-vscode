import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockFire,
  mockDispose,
  mockEvent,
  mockShowWarningMessage,
  mockShowInformationMessage,
  mockGetConfiguration,
} = vi.hoisted(() => ({
  mockFire: vi.fn(),
  mockDispose: vi.fn(),
  mockEvent: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockGetConfiguration: vi.fn(),
}));

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    contextValue?: string;
    iconPath?: any;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    fire = mockFire;
    dispose = mockDispose;
    event = mockEvent;
  },
  ThemeIcon: class {
    id: string;
    constructor(id: string) { this.id = id; }
  },
  workspace: {
    getConfiguration: mockGetConfiguration,
  },
  window: {
    showWarningMessage: mockShowWarningMessage,
    showInformationMessage: mockShowInformationMessage,
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn(),
  },
  readdir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

import { StorageAnalyticsProvider } from '../storageAnalyticsProvider';
import { IConfigManager } from '../configManager';

function createMockConfigManager(): IConfigManager {
  return {
    getConfigPath: vi.fn(() => '/mock/workspace/.verdaccio/config.yaml'),
    readConfig: vi.fn().mockResolvedValue({
      storage: './storage',
      listen: '0.0.0.0:4873',
      max_body_size: '10mb',
      log: { level: 'warn' },
      uplinks: {},
      packages: {},
    }),
    updateConfig: vi.fn(),
    generateDefaultConfig: vi.fn(),
    configExists: vi.fn(),
    openRawConfig: vi.fn(),
    dispose: vi.fn(),
    setCacheStrategy: vi.fn(),
    setUplinkCacheSettings: vi.fn(),
    enableOfflineMode: vi.fn(),
    disableOfflineMode: vi.fn(),
    setGlobalProxy: vi.fn(),
    setUplinkProxy: vi.fn(),
  };
}

function setupSettingsMock(overrides: Record<string, any> = {}) {
  const defaults: Record<string, any> = {
    configPath: '.verdaccio/config.yaml',
    autoSetRegistry: false,
    storageWarningThresholdMb: 500,
    stalenessThresholdDays: 90,
  };
  const merged = { ...defaults, ...overrides };
  mockGetConfiguration.mockReturnValue({
    get: vi.fn((key: string, defaultVal: any) => merged[key] ?? defaultVal),
  });
}

describe('StorageAnalyticsProvider', () => {
  let provider: StorageAnalyticsProvider;
  let configManager: IConfigManager;

  beforeEach(() => {
    vi.clearAllMocks();
    configManager = createMockConfigManager();
    setupSettingsMock();
    provider = new StorageAnalyticsProvider(configManager);
  });

  afterEach(() => {
    provider.dispose();
  });

  /**
   * Validates: Requirements 11.2, 11.3
   * Test threshold warning notification displays when usage exceeds threshold
   */
  describe('threshold warning notification', () => {
    it('shows warning when storage exceeds threshold', async () => {
      // Set threshold to 1 MB
      setupSettingsMock({ storageWarningThresholdMb: 1 });

      // Mock computeAnalytics to return usage above threshold (2 MB)
      vi.spyOn(provider, 'computeAnalytics').mockResolvedValue({
        totalDiskUsageBytes: 2 * 1024 * 1024,
        packageCount: 1,
        versionCount: 1,
        largestPackages: [],
        stalePackageCount: 0,
      });

      await provider.checkThreshold();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('exceeds the configured threshold of 1 MB'),
      );
    });

    it('does not show warning when storage is below threshold', async () => {
      setupSettingsMock({ storageWarningThresholdMb: 500 });

      vi.spyOn(provider, 'computeAnalytics').mockResolvedValue({
        totalDiskUsageBytes: 100 * 1024 * 1024, // 100 MB
        packageCount: 1,
        versionCount: 1,
        largestPackages: [],
        stalePackageCount: 0,
      });

      await provider.checkThreshold();

      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });
  });

  /**
   * Validates: Requirements 11.8
   * Test prune confirmation prompt shows total size to be freed
   */
  describe('prune confirmation prompt', () => {
    it('shows confirmation with size to be freed and proceeds on confirm', async () => {
      mockShowWarningMessage.mockResolvedValue('Delete');

      // Mock internal methods
      vi.spyOn(provider as any, '_getStoragePath').mockResolvedValue('/mock/storage');
      vi.spyOn(provider as any, '_scanPackages').mockResolvedValue([
        {
          name: 'my-pkg',
          versions: [
            { version: '1.0.0', sizeBytes: 1024, lastAccessDate: new Date('2024-01-01') },
            { version: '2.0.0', sizeBytes: 2048, lastAccessDate: new Date('2024-06-01') },
            { version: '3.0.0', sizeBytes: 4096, lastAccessDate: new Date('2025-01-01') },
          ],
        },
      ]);
      vi.spyOn(provider, 'pruneOldVersions').mockResolvedValue({ deletedCount: 2, freedBytes: 3072 });

      const result = await provider.pruneOldVersionsWithConfirmation('my-pkg', 1);

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('2 version(s)'),
        { modal: true },
        'Delete',
      );
      expect(result.deletedCount).toBe(2);
    });

    it('does not prune when user cancels confirmation', async () => {
      mockShowWarningMessage.mockResolvedValue(undefined);

      vi.spyOn(provider as any, '_getStoragePath').mockResolvedValue('/mock/storage');
      vi.spyOn(provider as any, '_scanPackages').mockResolvedValue([
        {
          name: 'my-pkg',
          versions: [
            { version: '1.0.0', sizeBytes: 1024, lastAccessDate: new Date('2024-01-01') },
            { version: '2.0.0', sizeBytes: 2048, lastAccessDate: new Date('2025-01-01') },
          ],
        },
      ]);

      const result = await provider.pruneOldVersionsWithConfirmation('my-pkg', 1);

      expect(result.deletedCount).toBe(0);
      expect(result.freedBytes).toBe(0);
    });
  });

  /**
   * Validates: Requirements 11.9
   * Test cleanup notification shows freed space amount
   */
  describe('cleanup notification with freed space', () => {
    it('shows information message with freed space after bulk cleanup', async () => {
      mockShowWarningMessage.mockResolvedValue('Delete');

      vi.spyOn(provider, 'bulkCleanup').mockResolvedValue({ deletedCount: 3, freedBytes: 5 * 1024 * 1024 });

      const stalePackages = [
        { name: 'old-pkg', version: '0.1.0', lastAccessDate: new Date('2023-01-01'), sizeBytes: 2 * 1024 * 1024 },
        { name: 'old-pkg', version: '0.2.0', lastAccessDate: new Date('2023-02-01'), sizeBytes: 1.5 * 1024 * 1024 },
        { name: 'stale-lib', version: '1.0.0', lastAccessDate: new Date('2023-03-01'), sizeBytes: 1.5 * 1024 * 1024 },
      ];

      const result = await provider.bulkCleanupWithConfirmation(stalePackages);

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('freed'),
      );
      expect(result.deletedCount).toBe(3);
      expect(result.freedBytes).toBe(5 * 1024 * 1024);
    });

    it('shows information message with freed space after prune', async () => {
      mockShowWarningMessage.mockResolvedValue('Delete');

      vi.spyOn(provider as any, '_getStoragePath').mockResolvedValue('/mock/storage');
      vi.spyOn(provider as any, '_scanPackages').mockResolvedValue([
        {
          name: 'my-pkg',
          versions: [
            { version: '1.0.0', sizeBytes: 512 * 1024, lastAccessDate: new Date('2024-01-01') },
            { version: '2.0.0', sizeBytes: 1024 * 1024, lastAccessDate: new Date('2025-01-01') },
          ],
        },
      ]);
      vi.spyOn(provider, 'pruneOldVersions').mockResolvedValue({ deletedCount: 1, freedBytes: 512 * 1024 });

      await provider.pruneOldVersionsWithConfirmation('my-pkg', 1);

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('freed'),
      );
    });
  });

  /**
   * Validates: Requirements 11.7
   * Test tree view renders all analytics metrics correctly
   */
  describe('tree view renders metrics', () => {
    it('renders all metric items when analytics are available', () => {
      // Set analytics via refresh mock
      (provider as any)._analytics = {
        totalDiskUsageBytes: 1024 * 1024 * 50, // 50 MB
        packageCount: 10,
        versionCount: 25,
        stalePackageCount: 3,
        largestPackages: [
          { name: 'big-pkg', version: '1.0.0', sizeBytes: 10 * 1024 * 1024 },
        ],
      };

      const children = provider.getChildren();

      expect(children.length).toBe(5); // 4 metrics + 1 largest package
      expect(children[0]).toEqual({ type: 'metric', label: 'Total Disk Usage', value: '50.0 MB' });
      expect(children[1]).toEqual({ type: 'metric', label: 'Packages', value: '10' });
      expect(children[2]).toEqual({ type: 'metric', label: 'Versions', value: '25' });
      expect(children[3]).toEqual({ type: 'metric', label: 'Stale Packages', value: '3' });
      expect(children[4]).toEqual({ type: 'largestPackage', name: 'big-pkg@1.0.0', sizeBytes: 10 * 1024 * 1024 });
    });

    it('returns empty array when no analytics computed', () => {
      const children = provider.getChildren();
      expect(children).toEqual([]);
    });

    it('renders tree items with correct labels and icons', () => {
      const metricItem = { type: 'metric' as const, label: 'Packages', value: '5' };
      const treeItem = provider.getTreeItem(metricItem);
      expect(treeItem.label).toBe('Packages: 5');
      expect(treeItem.contextValue).toBe('metric');

      const pkgItem = { type: 'largestPackage' as const, name: 'my-lib@1.0.0', sizeBytes: 2048 };
      const pkgTreeItem = provider.getTreeItem(pkgItem);
      expect(pkgTreeItem.label).toContain('my-lib@1.0.0');
      expect(pkgTreeItem.contextValue).toBe('largestPackage');
    });
  });

  /**
   * Validates: Requirements 11.2, 11.6
   * Test settings defaults (500 MB threshold, 90 days staleness)
   */
  describe('settings defaults', () => {
    it('uses default 500 MB threshold and 90 days staleness', () => {
      // Use default settings mock (already set in beforeEach)
      const settings = (provider as any)._getSettings();
      expect(settings.storageWarningThresholdMb).toBe(500);
      expect(settings.stalenessThresholdDays).toBe(90);
    });

    it('reads custom settings when configured', () => {
      setupSettingsMock({ storageWarningThresholdMb: 1000, stalenessThresholdDays: 30 });
      const settings = (provider as any)._getSettings();
      expect(settings.storageWarningThresholdMb).toBe(1000);
      expect(settings.stalenessThresholdDays).toBe(30);
    });
  });
});
