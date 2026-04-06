/**
 * E2E tests for ProfileManager — real file system profile CRUD and .npmrc switching.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined as any,
  },
  window: {
    showWarningMessage: vi.fn().mockResolvedValue('Delete'),
    showErrorMessage: vi.fn(),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

import * as vscode from 'vscode';
import { ProfileManager } from '../../profileManager';
import { INpmrcManager } from '../../npmrcManager';

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

describe('ProfileManager E2E', () => {
  let tmpDir: string;
  let manager: ProfileManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdaccio-e2e-profile-'));
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    manager = new ProfileManager(createMockNpmrcManager());
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a profile from .npmrc, lists it, switches to it, and deletes it', async () => {
    // Write initial .npmrc
    const npmrcPath = path.join(tmpDir, '.npmrc');
    await fs.writeFile(npmrcPath, 'registry=http://localhost:4873\n@myorg:registry=https://npm.myorg.com/\n//registry.npmjs.org/:_authToken=abc123\n', 'utf-8');

    // Create profile
    await manager.createProfile('dev');
    expect(manager.getActiveProfile()).toBe('dev');

    // List profiles
    const profiles = await manager.listProfiles();
    expect(profiles).toContain('dev');

    // Verify profile JSON on disk
    const profilePath = path.join(tmpDir, '.verdaccio', 'profiles', 'dev.json');
    const profileContent = await fs.readFile(profilePath, 'utf-8');
    const profile = JSON.parse(profileContent);
    expect(profile.name).toBe('dev');
    expect(profile.registry).toBe('http://localhost:4873');
    expect(profile.scopedRegistries).toHaveLength(1);
    expect(profile.scopedRegistries[0].scope).toBe('@myorg');
    expect(profile.authTokenRegistries).toHaveLength(1);

    // Overwrite .npmrc with different content
    await fs.writeFile(npmrcPath, 'registry=https://registry.npmjs.org/\n', 'utf-8');

    // Switch back to dev profile
    await manager.switchProfile('dev');
    expect(manager.getActiveProfile()).toBe('dev');

    // Verify .npmrc was restored
    const restored = await fs.readFile(npmrcPath, 'utf-8');
    expect(restored).toContain('registry=http://localhost:4873');
    expect(restored).toContain('@myorg:registry=https://npm.myorg.com/');

    // Delete profile
    await manager.deleteProfile('dev');
    const afterDelete = await manager.listProfiles();
    expect(afterDelete).not.toContain('dev');
  });

  it('creates multiple profiles and switches between them', async () => {
    const npmrcPath = path.join(tmpDir, '.npmrc');

    // Create "local" profile
    await fs.writeFile(npmrcPath, 'registry=http://localhost:4873\n', 'utf-8');
    await manager.createProfile('local');

    // Create "ci" profile
    await fs.writeFile(npmrcPath, 'registry=https://registry.npmjs.org/\nalways-auth=true\n', 'utf-8');
    await manager.createProfile('ci');

    // List both
    const profiles = await manager.listProfiles();
    expect(profiles).toContain('local');
    expect(profiles).toContain('ci');

    // Switch to local
    await manager.switchProfile('local');
    const localContent = await fs.readFile(npmrcPath, 'utf-8');
    expect(localContent).toContain('registry=http://localhost:4873');

    // Switch to ci
    await manager.switchProfile('ci');
    const ciContent = await fs.readFile(npmrcPath, 'utf-8');
    expect(ciContent).toContain('registry=https://registry.npmjs.org/');
  });

  it('handles nonexistent profile gracefully', async () => {
    await manager.switchProfile('nonexistent');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('not found'),
    );
  });
});
