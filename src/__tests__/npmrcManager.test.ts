import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockShowWarningMessage,
  mockReadFile,
  mockWriteFile,
  mockMkdir,
} = vi.hoisted(() => ({
  mockShowWarningMessage: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: mockShowWarningMessage,
  },
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: '/mock/workspace' } },
    ],
  },
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

import { NpmrcManager } from '../npmrcManager';
import { IServerManager } from '../serverManager';

function createMockServerManager(state: string = 'stopped'): IServerManager {
  return {
    state,
    port: state === 'running' ? 4873 : undefined,
    startTime: state === 'running' ? new Date() : undefined,
    onDidChangeState: vi.fn() as any,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as unknown as IServerManager;
}

describe('NpmrcManager', () => {
  let serverManager: IServerManager;
  let npmrcManager: NpmrcManager;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Validates: Requirement 6.3
   * Server-not-running guard shows warning and offers to start
   */
  describe('server-not-running guard', () => {
    it('shows warning when server is stopped', async () => {
      serverManager = createMockServerManager('stopped');
      npmrcManager = new NpmrcManager(serverManager);
      mockShowWarningMessage.mockResolvedValue('Cancel');

      await npmrcManager.setRegistry('http://localhost:4873/');

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Verdaccio server is not running. Start the server first?',
        'Start Server',
        'Cancel',
      );
    });

    it('starts server when user selects "Start Server"', async () => {
      serverManager = createMockServerManager('stopped');
      npmrcManager = new NpmrcManager(serverManager);
      mockShowWarningMessage.mockResolvedValue('Start Server');

      await npmrcManager.setRegistry('http://localhost:4873/');

      expect(serverManager.start).toHaveBeenCalled();
    });

    it('does not start server when user cancels', async () => {
      serverManager = createMockServerManager('stopped');
      npmrcManager = new NpmrcManager(serverManager);
      mockShowWarningMessage.mockResolvedValue('Cancel');

      await npmrcManager.setRegistry('http://localhost:4873/');

      expect(serverManager.start).not.toHaveBeenCalled();
    });
  });

  /**
   * Validates: Requirement 6.3 (implicit: .npmrc creation)
   * .npmrc creation when file doesn't exist
   */
  describe('.npmrc creation when file does not exist', () => {
    it('creates .npmrc with registry line when file does not exist', async () => {
      serverManager = createMockServerManager('running');
      npmrcManager = new NpmrcManager(serverManager);
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.setRegistry('http://localhost:4873/');

      expect(mockMkdir).toHaveBeenCalledWith('/mock/workspace', { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.npmrc'),
        expect.stringContaining('registry=http://localhost:4873/'),
        'utf-8',
      );
    });
  });

  /**
   * Validates: Requirement 6.1
   * Preserving existing .npmrc entries when setting registry
   */
  describe('preserving existing .npmrc entries', () => {
    it('preserves other lines when setting registry', async () => {
      serverManager = createMockServerManager('running');
      npmrcManager = new NpmrcManager(serverManager);
      const existingContent = 'always-auth=true\n@myorg:registry=https://npm.myorg.com/\n';
      mockReadFile.mockResolvedValue(existingContent);
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.setRegistry('http://localhost:4873/');

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent).toContain('always-auth=true');
      expect(writtenContent).toContain('@myorg:registry=https://npm.myorg.com/');
      expect(writtenContent).toContain('registry=http://localhost:4873/');
    });

    it('replaces existing registry line instead of duplicating', async () => {
      serverManager = createMockServerManager('running');
      npmrcManager = new NpmrcManager(serverManager);
      const existingContent = 'always-auth=true\nregistry=https://old.registry.com/\n';
      mockReadFile.mockResolvedValue(existingContent);
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.setRegistry('http://localhost:4873/');

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      const registryLines = writtenContent.split('\n').filter((l: string) => l.startsWith('registry='));
      expect(registryLines).toHaveLength(1);
      expect(registryLines[0]).toBe('registry=http://localhost:4873/');
    });
  });

  /**
   * Validates: Requirement 6.2
   * resetRegistry removes the registry line
   */
  describe('resetRegistry', () => {
    it('removes registry line from .npmrc', async () => {
      serverManager = createMockServerManager('running');
      npmrcManager = new NpmrcManager(serverManager);
      const existingContent = 'always-auth=true\nregistry=http://localhost:4873/\n@myorg:registry=https://npm.myorg.com/';
      mockReadFile.mockResolvedValue(existingContent);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.resetRegistry();

      const writtenContent = mockWriteFile.mock.calls[0][1] as string;
      expect(writtenContent).not.toContain('registry=http://localhost:4873/');
      expect(writtenContent).toContain('always-auth=true');
      expect(writtenContent).toContain('@myorg:registry=https://npm.myorg.com/');
    });

    it('does not write when .npmrc does not exist', async () => {
      serverManager = createMockServerManager('running');
      npmrcManager = new NpmrcManager(serverManager);
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      await npmrcManager.resetRegistry();

      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});
