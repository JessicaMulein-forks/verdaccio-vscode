import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockShowWarningMessage,
  mockShowErrorMessage,
  mockReadFile,
  mockWriteFile,
  mockMkdir,
  mockReaddir,
  mockUnlink,
  mockAccess,
} = vi.hoisted(() => ({
  mockShowWarningMessage: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReaddir: vi.fn(),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockAccess: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: mockShowWarningMessage,
    showErrorMessage: mockShowErrorMessage,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readdir: mockReaddir,
  unlink: mockUnlink,
  access: mockAccess,
}));

import { ProfileManager, serializeProfile, deserializeProfile } from '../profileManager';
import { INpmrcManager } from '../npmrcManager';

function createMockNpmrcManager(): INpmrcManager {
  return {
    setRegistry: vi.fn().mockResolvedValue(undefined),
    resetRegistry: vi.fn().mockResolvedValue(undefined),
    addScopedRegistry: vi.fn(),
    editScopedRegistry: vi.fn(),
    removeScopedRegistry: vi.fn(),
    listScopedRegistries: vi.fn(),
    addAuthToken: vi.fn(),
    rotateAuthToken: vi.fn(),
    removeAuthToken: vi.fn(),
    listAuthTokens: vi.fn(),
    revealToken: vi.fn(),
  };
}

describe('ProfileManager', () => {
  let npmrcManager: INpmrcManager;
  let manager: ProfileManager;

  beforeEach(() => {
    vi.clearAllMocks();
    npmrcManager = createMockNpmrcManager();
    manager = new ProfileManager(npmrcManager);
  });

  /**
   * Validates: Requirement 19.1
   * Create profile saves current .npmrc state as JSON
   */
  describe('createProfile', () => {
    it('creates a profile from current .npmrc content', async () => {
      mockReadFile.mockResolvedValueOnce('registry=http://localhost:4873\n@myorg:registry=https://npm.myorg.com/');

      await manager.createProfile('dev');

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('dev.json'),
        expect.any(String),
        'utf-8',
      );

      // Verify JSON content
      const writtenContent = mockWriteFile.mock.calls[0][1];
      const profile = JSON.parse(writtenContent);
      expect(profile.name).toBe('dev');
      expect(profile.registry).toBe('http://localhost:4873');
      expect(profile.scopedRegistries).toHaveLength(1);
    });

    it('creates profile with empty .npmrc', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      await manager.createProfile('empty');

      expect(mockWriteFile).toHaveBeenCalled();
      const writtenContent = mockWriteFile.mock.calls[0][1];
      const profile = JSON.parse(writtenContent);
      expect(profile.name).toBe('empty');
      expect(profile.registry).toBeUndefined();
    });
  });

  /**
   * Validates: Requirement 19.3
   * Switch profile overwrites .npmrc with stored configuration
   */
  describe('switchProfile', () => {
    it('switches to an existing profile', async () => {
      const profile = {
        name: 'dev',
        registry: 'http://localhost:4873',
        scopedRegistries: [{ scope: '@myorg', registryUrl: 'https://npm.myorg.com/' }],
        authTokenRegistries: [],
      };
      mockAccess.mockResolvedValueOnce(undefined);
      mockReadFile.mockResolvedValueOnce(JSON.stringify(profile));

      await manager.switchProfile('dev');

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.npmrc'),
        expect.stringContaining('registry=http://localhost:4873'),
        'utf-8',
      );
      expect(manager.getActiveProfile()).toBe('dev');
    });
  });

  /**
   * Validates: Requirement 19.8
   * Nonexistent profile error lists available profiles
   */
  describe('nonexistent profile error', () => {
    it('shows error with available profiles when switching to nonexistent profile', async () => {
      mockAccess.mockRejectedValueOnce(new Error('ENOENT'));
      mockReaddir.mockResolvedValueOnce(['dev.json', 'ci.json']);

      await manager.switchProfile('nonexistent');

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Profile "nonexistent" not found'),
      );
      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('dev, ci'),
      );
    });
  });

  /**
   * Validates: Requirement 19.5
   * Delete profile removes JSON file after confirmation
   */
  describe('deleteProfile', () => {
    it('deletes profile after confirmation', async () => {
      mockShowWarningMessage.mockResolvedValue('Delete');

      await manager.deleteProfile('dev');

      expect(mockUnlink).toHaveBeenCalledWith(
        expect.stringContaining('dev.json'),
      );
    });

    it('does not delete when user cancels', async () => {
      mockShowWarningMessage.mockResolvedValue('Cancel');

      await manager.deleteProfile('dev');

      expect(mockUnlink).not.toHaveBeenCalled();
    });
  });

  /**
   * Validates: Requirement 19.2
   * List profiles reads from profiles directory
   */
  describe('listProfiles', () => {
    it('lists available profiles', async () => {
      mockReaddir.mockResolvedValueOnce(['dev.json', 'ci.json', 'readme.txt']);

      const profiles = await manager.listProfiles();

      expect(profiles).toEqual(['dev', 'ci']);
    });

    it('returns empty array when profiles directory does not exist', async () => {
      mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));

      const profiles = await manager.listProfiles();

      expect(profiles).toEqual([]);
    });
  });

  /**
   * Validates: Requirement 19.4
   * Status bar displays active profile name
   */
  describe('status bar', () => {
    it('getActiveProfile returns undefined initially', () => {
      expect(manager.getActiveProfile()).toBeUndefined();
    });

    it('getActiveProfile returns profile name after create', async () => {
      mockReadFile.mockResolvedValueOnce('registry=http://localhost:4873');

      await manager.createProfile('dev');

      expect(manager.getActiveProfile()).toBe('dev');
    });

    it('updates status bar item when set', async () => {
      const statusBarItem = { text: '', show: vi.fn(), hide: vi.fn() } as any;
      manager.setStatusBarItem(statusBarItem);

      mockReadFile.mockResolvedValueOnce('registry=http://localhost:4873');
      await manager.createProfile('dev');

      expect(statusBarItem.text).toContain('dev');
      expect(statusBarItem.show).toHaveBeenCalled();
    });
  });

  /**
   * Validates: Requirement 19.6
   * Profile JSON schema contains required fields
   */
  describe('profile JSON schema', () => {
    it('serializeProfile produces correct schema', () => {
      const content = 'registry=http://localhost:4873\n@myorg:registry=https://npm.myorg.com/\n//registry.npmjs.org/:_authToken=abc123';
      const profile = serializeProfile(content, 'test');

      expect(profile).toHaveProperty('name', 'test');
      expect(profile).toHaveProperty('registry', 'http://localhost:4873');
      expect(profile).toHaveProperty('scopedRegistries');
      expect(profile).toHaveProperty('authTokenRegistries');
      expect(profile.scopedRegistries).toHaveLength(1);
      expect(profile.authTokenRegistries).toHaveLength(1);
    });

    it('deserializeProfile produces valid .npmrc content', () => {
      const profile = {
        name: 'test',
        registry: 'http://localhost:4873',
        scopedRegistries: [{ scope: '@myorg', registryUrl: 'https://npm.myorg.com/' }],
        authTokenRegistries: ['registry.npmjs.org/'],
      };

      const content = deserializeProfile(profile);

      expect(content).toContain('registry=http://localhost:4873');
      expect(content).toContain('@myorg:registry=https://npm.myorg.com/');
      expect(content).toContain('//registry.npmjs.org/:_authToken=');
    });
  });
});
