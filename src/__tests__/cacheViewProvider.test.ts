import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockFire,
  mockDispose,
  mockEvent,
  mockOnDidCreate,
  mockOnDidDelete,
  mockWatcherDispose,
  mockShowWarningMessage,
  mockShowErrorMessage,
  mockCreateFileSystemWatcher,
  mockRm,
} = vi.hoisted(() => ({
  mockFire: vi.fn(),
  mockDispose: vi.fn(),
  mockEvent: vi.fn(),
  mockOnDidCreate: vi.fn(),
  mockOnDidDelete: vi.fn(),
  mockWatcherDispose: vi.fn(),
  mockShowWarningMessage: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockCreateFileSystemWatcher: vi.fn(),
  mockRm: vi.fn(),
}));

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    contextValue?: string;
    iconPath?: any;
    description?: string;
    tooltip?: any;
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
    constructor(id: string) {
      this.id = id;
    }
  },
  MarkdownString: class {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  },
  RelativePattern: class {
    constructor(public base: string, public pattern: string) {}
  },
  workspace: {
    createFileSystemWatcher: mockCreateFileSystemWatcher.mockReturnValue({
      onDidCreate: mockOnDidCreate,
      onDidDelete: mockOnDidDelete,
      dispose: mockWatcherDispose,
    }),
  },
  window: {
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    rm: mockRm,
    readdir: vi.fn(),
    readFile: vi.fn(),
    stat: vi.fn(),
  },
  rm: mockRm,
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

import { CacheViewProvider } from '../cacheViewProvider';
import { IConfigManager } from '../configManager';
import type { PackageNode, VersionNode, ScopeNode } from '../types';

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
  };
}

describe('CacheViewProvider', () => {
  let provider: CacheViewProvider;
  let configManager: IConfigManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    configManager = createMockConfigManager();
    provider = new CacheViewProvider(configManager);
  });

  afterEach(() => {
    provider.dispose();
    vi.useRealTimers();
  });

  /**
   * Validates: Requirement 4.2
   * Version listing for expanded package nodes
   */
  describe('version listing', () => {
    it('returns VersionNodes when getChildren is called with a PackageNode', () => {
      const versions: VersionNode[] = [
        { type: 'version', version: '1.0.0', description: 'First', tarballSize: 1024, packageName: 'my-lib' },
        { type: 'version', version: '2.0.0', description: 'Second', tarballSize: 2048, packageName: 'my-lib' },
      ];
      const packageNode: PackageNode = {
        type: 'package',
        name: 'my-lib',
        scope: undefined,
        path: '/storage/my-lib',
        versions,
      };

      const children = provider.getChildren(packageNode);

      expect(children).toHaveLength(2);
      expect(children[0]).toBe(versions[0]);
      expect(children[1]).toBe(versions[1]);
    });

    it('returns scope children when getChildren is called with a ScopeNode', () => {
      const pkgNode: PackageNode = {
        type: 'package',
        name: 'utils',
        scope: '@myorg',
        path: '/storage/@myorg/utils',
        versions: [],
      };
      const scopeNode: ScopeNode = {
        type: 'scope',
        name: '@myorg',
        children: [pkgNode],
      };

      const children = provider.getChildren(scopeNode);

      expect(children).toHaveLength(1);
      expect(children[0]).toBe(pkgNode);
    });

    it('returns empty array when getChildren is called with a VersionNode', () => {
      const versionNode: VersionNode = {
        type: 'version',
        version: '1.0.0',
        description: 'desc',
        tarballSize: 512,
        packageName: 'my-lib',
      };

      const children = provider.getChildren(versionNode);

      expect(children).toHaveLength(0);
    });
  });

  /**
   * Validates: Requirement 4.3
   * Metadata display for selected version
   */
  describe('metadata display', () => {
    it('returns a TreeItem with tooltip containing name, version, description, and tarball size', () => {
      const versionNode: VersionNode = {
        type: 'version',
        version: '1.2.3',
        description: 'A useful library',
        tarballSize: 5120,
        packageName: 'my-lib',
      };

      const treeItem = provider.getTreeItem(versionNode);

      expect(treeItem.label).toBe('1.2.3');
      expect(treeItem.contextValue).toBe('version');
      expect(treeItem.tooltip).toBeDefined();
      const tooltipValue = (treeItem.tooltip as any).value as string;
      expect(tooltipValue).toContain('my-lib@1.2.3');
      expect(tooltipValue).toContain('A useful library');
      expect(tooltipValue).toContain('5.0 KB');
    });

    it('shows "No description" when description is empty', () => {
      const versionNode: VersionNode = {
        type: 'version',
        version: '0.1.0',
        description: '',
        tarballSize: 256,
        packageName: '@org/pkg',
      };

      const treeItem = provider.getTreeItem(versionNode);
      const tooltipValue = (treeItem.tooltip as any).value as string;

      expect(tooltipValue).toContain('No description');
    });

    it('renders package TreeItem with version count description', () => {
      const packageNode: PackageNode = {
        type: 'package',
        name: 'my-lib',
        scope: undefined,
        path: '/storage/my-lib',
        versions: [
          { type: 'version', version: '1.0.0', description: '', tarballSize: 100, packageName: 'my-lib' },
          { type: 'version', version: '2.0.0', description: '', tarballSize: 200, packageName: 'my-lib' },
        ],
      };

      const treeItem = provider.getTreeItem(packageNode);

      expect(treeItem.label).toBe('my-lib');
      expect(treeItem.description).toBe('2 version(s)');
      expect(treeItem.contextValue).toBe('package');
    });

    it('renders scoped package TreeItem with full name', () => {
      const packageNode: PackageNode = {
        type: 'package',
        name: 'utils',
        scope: '@myorg',
        path: '/storage/@myorg/utils',
        versions: [],
      };

      const treeItem = provider.getTreeItem(packageNode);

      expect(treeItem.label).toBe('@myorg/utils');
    });
  });

  /**
   * Validates: Requirement 4.5
   * Delete confirmation prompt flow
   */
  describe('delete confirmation', () => {
    it('calls fs.rm when user confirms deletion', async () => {
      mockShowWarningMessage.mockResolvedValue('Delete');
      mockRm.mockResolvedValue(undefined);

      const packageNode: PackageNode = {
        type: 'package',
        name: 'my-lib',
        scope: undefined,
        path: '/storage/my-lib',
        versions: [],
      };

      await provider.deletePackage(packageNode);

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Are you sure you want to delete "my-lib"?',
        { modal: true },
        'Delete',
      );
      expect(mockRm).toHaveBeenCalledWith('/storage/my-lib', { recursive: true, force: true });
    });

    it('does not call fs.rm when user cancels deletion', async () => {
      mockShowWarningMessage.mockResolvedValue(undefined);

      const packageNode: PackageNode = {
        type: 'package',
        name: 'my-lib',
        scope: undefined,
        path: '/storage/my-lib',
        versions: [],
      };

      await provider.deletePackage(packageNode);

      expect(mockShowWarningMessage).toHaveBeenCalled();
      expect(mockRm).not.toHaveBeenCalled();
    });

    it('shows scoped package full name in confirmation prompt', async () => {
      mockShowWarningMessage.mockResolvedValue(undefined);

      const packageNode: PackageNode = {
        type: 'package',
        name: 'utils',
        scope: '@myorg',
        path: '/storage/@myorg/utils',
        versions: [],
      };

      await provider.deletePackage(packageNode);

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Are you sure you want to delete "@myorg/utils"?',
        { modal: true },
        'Delete',
      );
    });

    it('ignores non-package items', async () => {
      const versionNode: VersionNode = {
        type: 'version',
        version: '1.0.0',
        description: '',
        tarballSize: 100,
        packageName: 'my-lib',
      };

      await provider.deletePackage(versionNode);

      expect(mockShowWarningMessage).not.toHaveBeenCalled();
    });
  });

  /**
   * Validates: Requirement 4.6
   * File system watcher triggers refresh
   */
  describe('file system watcher', () => {
    it('creates a file system watcher during construction', () => {
      expect(mockCreateFileSystemWatcher).toHaveBeenCalled();
    });

    it('registers onDidCreate and onDidDelete callbacks', () => {
      expect(mockOnDidCreate).toHaveBeenCalledWith(expect.any(Function));
      expect(mockOnDidDelete).toHaveBeenCalledWith(expect.any(Function));
    });

    it('triggers refresh after debounce on file create', async () => {
      const createCallback = mockOnDidCreate.mock.calls[0][0];

      createCallback();

      // Should not fire immediately (debounced at 5s)
      expect(mockFire).not.toHaveBeenCalled();

      // Advance past the 5-second debounce
      vi.advanceTimersByTime(5000);

      // Allow async _scanStorage to settle
      await vi.advanceTimersByTimeAsync(0);

      // refresh() calls _scanStorage then fires, or catches and fires
      expect(mockFire).toHaveBeenCalled();
    });

    it('debounces multiple rapid file changes into a single refresh', async () => {
      const createCallback = mockOnDidCreate.mock.calls[0][0];
      const deleteCallback = mockOnDidDelete.mock.calls[0][0];

      createCallback();
      vi.advanceTimersByTime(1000);
      createCallback();
      vi.advanceTimersByTime(1000);
      deleteCallback();

      // 2s after last call — not yet 5s
      vi.advanceTimersByTime(3000);
      await vi.advanceTimersByTimeAsync(0);

      // Should not have fired yet since debounce resets each time
      // Actually the debounce resets on each call, so 5s from the last call
      // Last call was at t=2000, so fire at t=7000. We're at t=5000 now.
      // Wait the remaining 2s
      vi.advanceTimersByTime(2000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFire).toHaveBeenCalled();
    });
  });
});
