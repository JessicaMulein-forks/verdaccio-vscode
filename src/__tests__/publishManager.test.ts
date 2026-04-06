import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockShowWarningMessage,
  mockShowErrorMessage,
  mockShowInformationMessage,
  mockExecFile,
  mockReadFile,
  mockAccess,
} = vi.hoisted(() => ({
  mockShowWarningMessage: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockExecFile: vi.fn(),
  mockReadFile: vi.fn(),
  mockAccess: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
    showInformationMessage: mockShowInformationMessage,
  },
}));

vi.mock('child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  access: mockAccess,
}));

import { PublishManager, buildRegistryUrl, buildPublishArgs, buildVersionArgs, buildPromoteArgs, extractPackageInfo } from '../publishManager';
import { IServerManager } from '../serverManager';
import { IConfigManager } from '../configManager';

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

function createMockConfigManager(): IConfigManager {
  return {
    getConfigPath: vi.fn().mockReturnValue('/workspace/.verdaccio/config.yaml'),
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
  } as unknown as IConfigManager;
}

describe('Pure functions', () => {
  describe('buildRegistryUrl', () => {
    it('builds a localhost URL from a port', () => {
      expect(buildRegistryUrl(4873)).toBe('http://localhost:4873');
      expect(buildRegistryUrl(8080)).toBe('http://localhost:8080');
    });
  });

  describe('buildPublishArgs', () => {
    it('returns npm publish args with registry flag', () => {
      expect(buildPublishArgs('http://localhost:4873')).toEqual([
        'publish', '--registry', 'http://localhost:4873',
      ]);
    });
  });

  describe('buildVersionArgs', () => {
    it('returns npm version args for each bump type', () => {
      expect(buildVersionArgs('patch')).toEqual(['version', 'patch']);
      expect(buildVersionArgs('minor')).toEqual(['version', 'minor']);
      expect(buildVersionArgs('major')).toEqual(['version', 'major']);
      expect(buildVersionArgs('prerelease')).toEqual(['version', 'prerelease']);
    });
  });

  describe('buildPromoteArgs', () => {
    it('returns npm publish args with tarball and target registry', () => {
      expect(buildPromoteArgs('/path/to/pkg-1.0.0.tgz', 'https://registry.npmjs.org')).toEqual([
        'publish', '/path/to/pkg-1.0.0.tgz', '--registry', 'https://registry.npmjs.org',
      ]);
    });
  });

  describe('extractPackageInfo', () => {
    it('extracts name and version from package.json', () => {
      expect(extractPackageInfo({ name: 'my-pkg', version: '1.2.3' })).toEqual({
        name: 'my-pkg', version: '1.2.3',
      });
    });

    it('returns defaults for missing fields', () => {
      expect(extractPackageInfo({})).toEqual({ name: 'unknown', version: '0.0.0' });
    });
  });
});

describe('PublishManager', () => {
  let publishManager: PublishManager;
  let serverManager: IServerManager;
  let configManager: IConfigManager;

  beforeEach(() => {
    vi.clearAllMocks();
    serverManager = createMockServerManager();
    configManager = createMockConfigManager();
    publishManager = new PublishManager(serverManager, configManager);
  });

  /**
   * Validates: Requirement 12.2
   * Server-not-running guard shows warning and offers to start
   */
  describe('server-not-running guard', () => {
    it('shows warning and offers to start when server is not running', async () => {
      serverManager = createMockServerManager({ state: 'stopped', port: undefined });
      publishManager = new PublishManager(serverManager, configManager);
      mockShowWarningMessage.mockResolvedValue('Cancel');

      const result = await publishManager.publishToVerdaccio('/some/package');

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Verdaccio server is not running. Start the server first?',
        'Start Server',
        'Cancel',
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('Server not running');
    });

    it('starts the server when user chooses "Start Server"', async () => {
      serverManager = createMockServerManager({ state: 'stopped', port: undefined });
      publishManager = new PublishManager(serverManager, configManager);
      mockShowWarningMessage.mockResolvedValue('Start Server');

      const result = await publishManager.publishToVerdaccio('/some/package');

      expect(serverManager.start).toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });

  /**
   * Validates: Requirements 12.5, 12.6
   * Success/error notifications
   */
  describe('publish notifications', () => {
    it('shows success notification with package name and version', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ name: 'my-pkg', version: '1.0.0' }));
      // checkDuplicate: no package.json in storage
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ name: 'my-pkg', version: '1.0.0' }));

      // execFile succeeds
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, '', '');
      });

      const result = await publishManager.publishToVerdaccio('/workspace/my-pkg');

      expect(result.success).toBe(true);
      expect(result.packageName).toBe('my-pkg');
      expect(result.version).toBe('1.0.0');
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        'Successfully published my-pkg@1.0.0 to Verdaccio.',
      );
    });

    it('shows error notification with npm error output on failure', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ name: 'my-pkg', version: '1.0.0' }));

      // execFile fails
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        const err = new Error('npm ERR! 403 Forbidden') as any;
        err.stderr = 'npm ERR! 403 Forbidden';
        cb(err, '', 'npm ERR! 403 Forbidden');
      });

      const result = await publishManager.publishToVerdaccio('/workspace/my-pkg');

      expect(result.success).toBe(false);
      expect(result.error).toContain('403 Forbidden');
      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to publish my-pkg@1.0.0'),
      );
    });
  });

  /**
   * Validates: Requirement 12.7
   * Duplicate detection warns before publishing
   */
  describe('duplicate detection', () => {
    it('warns when package@version already exists', async () => {
      // First readFile call: package.json in workspace
      mockReadFile.mockResolvedValueOnce(JSON.stringify({ name: 'my-pkg', version: '1.0.0' }));
      // Second readFile call: package.json in storage (for checkDuplicate)
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        versions: { '1.0.0': { description: 'existing' } },
      }));

      mockShowWarningMessage.mockResolvedValue('Cancel');

      const result = await publishManager.publishToVerdaccio('/workspace/my-pkg');

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Package my-pkg@1.0.0 already exists in Verdaccio. Publish anyway?',
        'Publish',
        'Cancel',
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Duplicate detected');
    });

    it('returns false when package does not exist in storage', async () => {
      // readFile throws (no package.json in storage)
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      const isDuplicate = await publishManager.checkDuplicate('nonexistent-pkg', '1.0.0');
      expect(isDuplicate).toBe(false);
    });

    it('returns true when version exists in storage', async () => {
      mockReadFile.mockResolvedValueOnce(JSON.stringify({
        versions: { '1.0.0': {}, '2.0.0': {} },
      }));

      const isDuplicate = await publishManager.checkDuplicate('my-pkg', '1.0.0');
      expect(isDuplicate).toBe(true);
    });
  });

  /**
   * Validates: Requirement 12.4
   * Version bump constructs correct npm version command
   */
  describe('bumpVersion', () => {
    it('runs npm version with the correct bump type and returns new version', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, 'v1.1.0\n', '');
      });

      const newVersion = await publishManager.bumpVersion('/workspace/my-pkg', 'minor');

      expect(newVersion).toBe('1.1.0');
      expect(mockExecFile).toHaveBeenCalledWith(
        'npm',
        ['version', 'minor'],
        { cwd: '/workspace/my-pkg' },
        expect.any(Function),
      );
      expect(mockShowInformationMessage).toHaveBeenCalledWith('Version bumped to 1.1.0.');
    });

    it('shows error and throws on failure', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        const err = new Error('npm ERR! Git working directory not clean') as any;
        err.stderr = 'npm ERR! Git working directory not clean';
        cb(err, '', 'npm ERR! Git working directory not clean');
      });

      await expect(publishManager.bumpVersion('/workspace/my-pkg', 'patch')).rejects.toThrow();
      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to bump version'),
      );
    });
  });

  /**
   * Validates: Requirement 12.3
   * Promote package re-publishes tarball to target registry
   */
  describe('promotePackage', () => {
    it('publishes tarball to target registry on success', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, '', '');
      });

      const result = await publishManager.promotePackage('my-pkg', '1.0.0', 'https://registry.npmjs.org');

      expect(result.success).toBe(true);
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        'Successfully promoted my-pkg@1.0.0 to https://registry.npmjs.org.',
      );
    });

    it('shows error when tarball is not found', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await publishManager.promotePackage('my-pkg', '1.0.0', 'https://registry.npmjs.org');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Tarball not found');
      expect(mockShowErrorMessage).toHaveBeenCalled();
    });

    it('shows error when npm publish to target fails', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        const err = new Error('publish failed') as any;
        err.stderr = 'npm ERR! 401 Unauthorized';
        cb(err, '', 'npm ERR! 401 Unauthorized');
      });

      const result = await publishManager.promotePackage('my-pkg', '1.0.0', 'https://registry.npmjs.org');

      expect(result.success).toBe(false);
      expect(result.error).toContain('401 Unauthorized');
    });
  });
});
