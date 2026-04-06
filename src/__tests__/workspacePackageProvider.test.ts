import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockShowWarningMessage,
  mockShowErrorMessage,
  mockShowInformationMessage,
  mockWithProgress,
} = vi.hoisted(() => ({
  mockShowWarningMessage: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockWithProgress: vi.fn(),
}));

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string | undefined;
    collapsibleState: number | undefined;
    description: string | undefined;
    tooltip: string | undefined;
    constructor(label?: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    fire = vi.fn();
    dispose = vi.fn();
    event = vi.fn();
  },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
  window: {
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
    showInformationMessage: mockShowInformationMessage,
    withProgress: mockWithProgress,
  },
  ProgressLocation: { Notification: 15 },
}));

const mockReadFile = vi.hoisted(() => vi.fn());
const mockReaddir = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
}));

import {
  WorkspacePackageProvider,
  WorkspacePackageItem,
  topologicalSort,
} from '../workspacePackageProvider';
import { IServerManager } from '../serverManager';
import { IPublishManager } from '../publishManager';
import { WorkspacePackageInfo } from '../types';

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

function createMockPublishManager(): IPublishManager {
  return {
    publishToVerdaccio: vi.fn().mockResolvedValue({
      success: true,
      packageName: 'test-pkg',
      version: '1.0.0',
    }),
    promotePackage: vi.fn(),
    bumpVersion: vi.fn(),
    checkDuplicate: vi.fn(),
  };
}

describe('topologicalSort (pure function)', () => {
  it('sorts a simple linear dependency chain', () => {
    const packages = [
      { name: 'c', dependencies: ['b'] },
      { name: 'b', dependencies: ['a'] },
      { name: 'a', dependencies: [] },
    ];
    const result = topologicalSort(packages);
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('c'));
  });

  it('handles packages with no dependencies', () => {
    const packages = [
      { name: 'a', dependencies: [] },
      { name: 'b', dependencies: [] },
      { name: 'c', dependencies: [] },
    ];
    const result = topologicalSort(packages);
    expect(result).toHaveLength(3);
    expect(new Set(result)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('ignores external dependencies not in the package set', () => {
    const packages = [
      { name: 'a', dependencies: ['lodash', 'react'] },
      { name: 'b', dependencies: ['a', 'express'] },
    ];
    const result = topologicalSort(packages);
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
  });

  it('throws on circular dependencies', () => {
    const packages = [
      { name: 'a', dependencies: ['b'] },
      { name: 'b', dependencies: ['a'] },
    ];
    expect(() => topologicalSort(packages)).toThrow('Circular dependency');
  });

  it('handles a diamond dependency graph', () => {
    const packages = [
      { name: 'd', dependencies: ['b', 'c'] },
      { name: 'b', dependencies: ['a'] },
      { name: 'c', dependencies: ['a'] },
      { name: 'a', dependencies: [] },
    ];
    const result = topologicalSort(packages);
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('b'));
    expect(result.indexOf('a')).toBeLessThan(result.indexOf('c'));
    expect(result.indexOf('b')).toBeLessThan(result.indexOf('d'));
    expect(result.indexOf('c')).toBeLessThan(result.indexOf('d'));
  });

  it('handles a single package', () => {
    const result = topologicalSort([{ name: 'solo', dependencies: [] }]);
    expect(result).toEqual(['solo']);
  });
});

describe('WorkspacePackageItem', () => {
  /**
   * Validates: Requirement 13.2
   * Tree view renders detected packages with name and version
   */
  it('renders package name and version in label', () => {
    const info: WorkspacePackageInfo = {
      name: '@myorg/utils',
      version: '2.3.1',
      directory: '/workspace/packages/utils',
      dependencies: [],
    };
    const item = new WorkspacePackageItem(info);
    expect(item.label).toBe('@myorg/utils (2.3.1)');
    expect(item.description).toBe('/workspace/packages/utils');
  });
});

describe('WorkspacePackageProvider', () => {
  let provider: WorkspacePackageProvider;
  let serverManager: IServerManager;
  let publishManager: IPublishManager;

  beforeEach(() => {
    vi.clearAllMocks();
    serverManager = createMockServerManager();
    publishManager = createMockPublishManager();
    provider = new WorkspacePackageProvider(serverManager, publishManager);
  });

  /**
   * Validates: Requirement 13.7
   * Server-not-running guard shows warning
   */
  describe('server-not-running guard', () => {
    it('shows warning when publishing all and server is not running', async () => {
      serverManager = createMockServerManager({ state: 'stopped', port: undefined });
      provider = new WorkspacePackageProvider(serverManager, publishManager);
      mockShowWarningMessage.mockResolvedValue('Cancel');

      const result = await provider.publishAll();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Verdaccio server is not running. Start the server first?',
        'Start Server',
        'Cancel',
      );
      expect(result.successes).toHaveLength(0);
      expect(result.failures).toHaveLength(0);
    });

    it('offers to start server and starts when user accepts', async () => {
      serverManager = createMockServerManager({ state: 'stopped', port: undefined });
      provider = new WorkspacePackageProvider(serverManager, publishManager);
      mockShowWarningMessage.mockResolvedValue('Start Server');

      await provider.publishAll();

      expect(serverManager.start).toHaveBeenCalled();
    });

    it('shows warning when unpublishing all and server is not running', async () => {
      serverManager = createMockServerManager({ state: 'stopped', port: undefined });
      provider = new WorkspacePackageProvider(serverManager, publishManager);
      mockShowWarningMessage.mockResolvedValue('Cancel');

      await provider.unpublishAll();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Verdaccio server is not running. Start the server first?',
        'Start Server',
        'Cancel',
      );
    });
  });

  /**
   * Validates: Requirement 13.4
   * Partial failure summary shows successes and failures
   */
  describe('partial failure summary', () => {
    it('shows summary with successes and failures after bulk publish', async () => {
      // Mock detectPackages by mocking fs
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.endsWith('package.json') && filePath.includes('/workspace/package.json')) {
          return Promise.resolve(JSON.stringify({ workspaces: ['packages/*'] }));
        }
        if (filePath.includes('pkg-a')) {
          return Promise.resolve(JSON.stringify({ name: 'pkg-a', version: '1.0.0', dependencies: {} }));
        }
        if (filePath.includes('pkg-b')) {
          return Promise.resolve(JSON.stringify({ name: 'pkg-b', version: '1.0.0', dependencies: {} }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      mockReaddir.mockResolvedValue([
        { name: 'pkg-a', isDirectory: () => true },
        { name: 'pkg-b', isDirectory: () => true },
      ]);

      // First publish succeeds, second fails
      const mockPublish = vi.fn()
        .mockResolvedValueOnce({ success: true, packageName: 'pkg-a', version: '1.0.0' })
        .mockResolvedValueOnce({ success: false, packageName: 'pkg-b', version: '1.0.0', error: 'publish failed' });
      publishManager.publishToVerdaccio = mockPublish;

      // Mock withProgress to execute the callback immediately
      mockWithProgress.mockImplementation(async (_opts: any, cb: any) => {
        await cb({ report: vi.fn() });
      });

      const result = await provider.publishAll();

      expect(result.successes).toHaveLength(1);
      expect(result.failures).toHaveLength(1);
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('1 failed'),
      );
    });

    it('shows success message when all packages publish successfully', async () => {
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes('/workspace/package.json')) {
          return Promise.resolve(JSON.stringify({ workspaces: ['packages/*'] }));
        }
        if (filePath.includes('pkg-a')) {
          return Promise.resolve(JSON.stringify({ name: 'pkg-a', version: '1.0.0', dependencies: {} }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      mockReaddir.mockResolvedValue([
        { name: 'pkg-a', isDirectory: () => true },
      ]);

      (publishManager.publishToVerdaccio as any).mockResolvedValue({
        success: true, packageName: 'pkg-a', version: '1.0.0',
      });

      mockWithProgress.mockImplementation(async (_opts: any, cb: any) => {
        await cb({ report: vi.fn() });
      });

      const result = await provider.publishAll();

      expect(result.successes).toHaveLength(1);
      expect(result.failures).toHaveLength(0);
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Successfully published all 1'),
      );
    });
  });

  /**
   * Validates: Requirement 13.5
   * Unpublish confirmation prompt
   */
  describe('unpublish confirmation', () => {
    it('prompts for confirmation before unpublishing', async () => {
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes('/workspace/package.json')) {
          return Promise.resolve(JSON.stringify({ workspaces: ['packages/*'] }));
        }
        if (filePath.includes('pkg-a')) {
          return Promise.resolve(JSON.stringify({ name: 'pkg-a', version: '1.0.0', dependencies: {} }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      mockReaddir.mockResolvedValue([
        { name: 'pkg-a', isDirectory: () => true },
      ]);

      mockShowWarningMessage.mockResolvedValue(undefined); // User cancels

      await provider.unpublishAll();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Remove all'),
        { modal: true },
        'Remove All',
      );
    });
  });

  /**
   * Validates: Requirement 13.6
   * Progress indicator updates during bulk publish
   */
  describe('progress indicator', () => {
    it('shows progress during bulk publish', async () => {
      mockReadFile.mockImplementation((filePath: string) => {
        if (filePath.includes('/workspace/package.json')) {
          return Promise.resolve(JSON.stringify({ workspaces: ['packages/*'] }));
        }
        if (filePath.includes('pkg-a')) {
          return Promise.resolve(JSON.stringify({ name: 'pkg-a', version: '1.0.0', dependencies: {} }));
        }
        if (filePath.includes('pkg-b')) {
          return Promise.resolve(JSON.stringify({ name: 'pkg-b', version: '2.0.0', dependencies: {} }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      mockReaddir.mockResolvedValue([
        { name: 'pkg-a', isDirectory: () => true },
        { name: 'pkg-b', isDirectory: () => true },
      ]);

      (publishManager.publishToVerdaccio as any).mockResolvedValue({
        success: true, packageName: 'test', version: '1.0.0',
      });

      const progressReport = vi.fn();
      mockWithProgress.mockImplementation(async (opts: any, cb: any) => {
        expect(opts.location).toBe(15); // ProgressLocation.Notification
        expect(opts.title).toBe('Publishing workspace packages');
        await cb({ report: progressReport });
      });

      await provider.publishAll();

      expect(mockWithProgress).toHaveBeenCalled();
      expect(progressReport).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('1 of 2'),
        }),
      );
    });
  });
});
