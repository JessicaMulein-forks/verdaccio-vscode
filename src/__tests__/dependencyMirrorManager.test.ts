import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockShowWarningMessage,
  mockShowErrorMessage,
  mockShowInformationMessage,
  mockWithProgress,
  mockReadFile,
  mockWorkspaceFolders,
} = vi.hoisted(() => ({
  mockShowWarningMessage: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockWithProgress: vi.fn(),
  mockReadFile: vi.fn(),
  mockWorkspaceFolders: [{ uri: { fsPath: '/workspace' } }],
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
    showInformationMessage: mockShowInformationMessage,
    withProgress: mockWithProgress,
  },
  workspace: {
    workspaceFolders: mockWorkspaceFolders,
  },
  ProgressLocation: { Notification: 15 },
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, '', '');
  }),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

import { DependencyMirrorManager } from '../dependencyMirrorManager';
import { IServerManager } from '../serverManager';

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

describe('DependencyMirrorManager', () => {
  let serverManager: IServerManager;
  let manager: DependencyMirrorManager;

  beforeEach(() => {
    vi.clearAllMocks();
    serverManager = createMockServerManager();
    manager = new DependencyMirrorManager(serverManager);
  });

  /**
   * Validates: Requirements 17.1, 17.6
   * Lockfile detection (package-lock.json and yarn.lock)
   */
  describe('lockfile detection', () => {
    it('parses package-lock.json when available', async () => {
      const lockContent = JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          lodash: { version: '4.17.21' },
          express: { version: '4.18.2' },
        },
      });
      mockReadFile.mockResolvedValueOnce(lockContent);

      const deps = await manager.parseLockfile();

      expect(deps).toHaveLength(2);
      expect(deps.find((d) => d.name === 'lodash')).toBeDefined();
      expect(deps.find((d) => d.name === 'express')).toBeDefined();
    });

    it('falls back to yarn.lock when package-lock.json is missing', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // package-lock.json
      const yarnContent = [
        '# yarn lockfile v1',
        '',
        'lodash@^4.17.0:',
        '  version "4.17.21"',
        '  resolved "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"',
        '',
      ].join('\n');
      mockReadFile.mockResolvedValueOnce(yarnContent);

      const deps = await manager.parseLockfile();

      expect(deps).toHaveLength(1);
      expect(deps[0].name).toBe('lodash');
      expect(deps[0].version).toBe('4.17.21');
    });
  });

  /**
   * Validates: Requirement 17.7
   * No-lockfile error notification
   */
  describe('no-lockfile error', () => {
    it('shows error when no lockfile is found', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // package-lock.json
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT')); // yarn.lock

      await expect(manager.parseLockfile()).rejects.toThrow('No lockfile found');
      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        'No lockfile found. Run `npm install` or `yarn install` first to generate a lockfile.',
      );
    });
  });

  /**
   * Validates: Requirement 17.5
   * Server-not-running guard
   */
  describe('server-not-running guard', () => {
    it('shows warning when server is not running', async () => {
      serverManager = createMockServerManager({ state: 'stopped', port: undefined });
      manager = new DependencyMirrorManager(serverManager);
      mockShowWarningMessage.mockResolvedValue('Cancel');

      const result = await manager.mirrorDependencies();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Verdaccio server is not running. Start the server first?',
        'Start Server',
        'Cancel',
      );
      expect(result.newlyCached).toHaveLength(0);
    });

    it('starts server when user chooses "Start Server"', async () => {
      serverManager = createMockServerManager({ state: 'stopped', port: undefined });
      manager = new DependencyMirrorManager(serverManager);
      mockShowWarningMessage.mockResolvedValue('Start Server');

      // After starting, parseLockfile will be called — provide lockfile
      const lockContent = JSON.stringify({
        lockfileVersion: 1,
        dependencies: { lodash: { version: '4.17.21' } },
      });
      mockReadFile.mockResolvedValueOnce(lockContent);
      mockWithProgress.mockImplementation(async (_opts: any, task: Function) => {
        await task({ report: vi.fn() });
      });

      await manager.mirrorDependencies();

      expect(serverManager.start).toHaveBeenCalled();
    });
  });

  /**
   * Validates: Requirement 17.2
   * Progress indicator updates
   */
  describe('progress indicator', () => {
    it('shows progress during mirroring', async () => {
      const lockContent = JSON.stringify({
        lockfileVersion: 1,
        dependencies: { lodash: { version: '4.17.21' } },
      });
      mockReadFile.mockResolvedValueOnce(lockContent);
      mockWithProgress.mockImplementation(async (_opts: any, task: Function) => {
        const progress = { report: vi.fn() };
        await task(progress);
        expect(progress.report).toHaveBeenCalled();
      });

      await manager.mirrorDependencies();

      expect(mockWithProgress).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Mirroring dependencies',
        }),
        expect.any(Function),
      );
    });
  });

  /**
   * Validates: Requirement 17.4
   * Summary report with correct counts
   */
  describe('summary report', () => {
    it('shows summary notification after mirroring', async () => {
      const lockContent = JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          lodash: { version: '4.17.21' },
          express: { version: '4.18.2' },
        },
      });
      mockReadFile.mockResolvedValueOnce(lockContent);
      mockWithProgress.mockImplementation(async (_opts: any, task: Function) => {
        await task({ report: vi.fn() });
      });

      const result = await manager.mirrorDependencies();

      expect(result.newlyCached).toHaveLength(2);
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('Mirroring complete'),
      );
    });
  });
});
