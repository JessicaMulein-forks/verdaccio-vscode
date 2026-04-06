/**
 * E2E tests for NpmrcManager — real .npmrc file manipulation.
 * Tests registry set/reset, scoped registries, auth tokens on real files.
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
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
}));

import * as vscode from 'vscode';
import { NpmrcManager } from '../../npmrcManager';
import { IServerManager } from '../../serverManager';

function createRunningServerManager(): IServerManager {
  return {
    state: 'running',
    port: 4873,
    startTime: new Date(),
    onDidChangeState: vi.fn() as any,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as unknown as IServerManager;
}

// Mock SecretStorage backed by a real Map
function createRealSecretStorage() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    store: vi.fn((key: string, value: string) => { store.set(key, value); return Promise.resolve(); }),
    delete: vi.fn((key: string) => { store.delete(key); return Promise.resolve(); }),
    onDidChange: vi.fn() as any,
    _store: store,
  };
}

describe('NpmrcManager E2E', () => {
  let tmpDir: string;
  let npmrcPath: string;
  let manager: NpmrcManager;
  let secretStorage: ReturnType<typeof createRealSecretStorage>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verdaccio-e2e-npmrc-'));
    npmrcPath = path.join(tmpDir, '.npmrc');
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
    secretStorage = createRealSecretStorage();
    manager = new NpmrcManager(createRunningServerManager(), secretStorage as any);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('registry set/reset round-trip', () => {
    it('creates .npmrc, sets registry, then resets to original state', async () => {
      // No .npmrc initially
      await expect(fs.access(npmrcPath)).rejects.toThrow();

      await manager.setRegistry('http://localhost:4873/');

      const afterSet = await fs.readFile(npmrcPath, 'utf-8');
      expect(afterSet).toContain('registry=http://localhost:4873/');

      await manager.resetRegistry();

      const afterReset = await fs.readFile(npmrcPath, 'utf-8');
      expect(afterReset).not.toContain('registry=');
    });

    it('preserves existing .npmrc content during set/reset', async () => {
      await fs.writeFile(npmrcPath, 'always-auth=true\nsave-exact=true\n', 'utf-8');

      await manager.setRegistry('http://localhost:4873/');
      const afterSet = await fs.readFile(npmrcPath, 'utf-8');
      expect(afterSet).toContain('always-auth=true');
      expect(afterSet).toContain('save-exact=true');
      expect(afterSet).toContain('registry=http://localhost:4873/');

      await manager.resetRegistry();
      const afterReset = await fs.readFile(npmrcPath, 'utf-8');
      expect(afterReset).toContain('always-auth=true');
      expect(afterReset).toContain('save-exact=true');
      expect(afterReset).not.toContain('registry=http://localhost:4873/');
    });
  });

  describe('scoped registry CRUD', () => {
    it('adds, lists, edits, and removes scoped registries on real .npmrc', async () => {
      // Add two scoped registries
      await manager.addScopedRegistry('@fortawesome', 'https://npm.fontawesome.com/');
      await manager.addScopedRegistry('@myorg', 'https://npm.myorg.com/');

      // List
      const registries = await manager.listScopedRegistries();
      expect(registries).toHaveLength(2);
      expect(registries.find(r => r.scope === '@fortawesome')?.registryUrl).toBe('https://npm.fontawesome.com/');
      expect(registries.find(r => r.scope === '@myorg')?.registryUrl).toBe('https://npm.myorg.com/');

      // Edit
      await manager.editScopedRegistry('@myorg', 'https://new.myorg.com/');
      const afterEdit = await manager.listScopedRegistries();
      expect(afterEdit.find(r => r.scope === '@myorg')?.registryUrl).toBe('https://new.myorg.com/');

      // Remove
      await manager.removeScopedRegistry('@fortawesome');
      const afterRemove = await manager.listScopedRegistries();
      expect(afterRemove).toHaveLength(1);
      expect(afterRemove[0].scope).toBe('@myorg');

      // Verify file content
      const content = await fs.readFile(npmrcPath, 'utf-8');
      expect(content).not.toContain('@fortawesome');
      expect(content).toContain('@myorg:registry=https://new.myorg.com/');
    });
  });

  describe('auth token CRUD with SecretStorage', () => {
    it('adds, lists, removes auth tokens with real file and SecretStorage', async () => {
      await manager.addAuthToken('https://registry.npmjs.org/', 'npm_abc123xyz');

      // Verify .npmrc
      const content = await fs.readFile(npmrcPath, 'utf-8');
      expect(content).toContain('//registry.npmjs.org/:_authToken=npm_abc123xyz');

      // Verify SecretStorage
      expect(secretStorage.store).toHaveBeenCalledWith(
        'verdaccio.authToken.https://registry.npmjs.org/',
        'npm_abc123xyz',
      );

      // List (masked)
      const tokens = await manager.listAuthTokens();
      expect(tokens).toHaveLength(1);
      expect(tokens[0].maskedToken).toBe('****3xyz');

      // Reveal
      const revealed = await manager.revealToken('https://registry.npmjs.org/');
      expect(revealed).toBe('npm_abc123xyz');

      // Remove
      await manager.removeAuthToken('https://registry.npmjs.org/');
      const afterRemove = await fs.readFile(npmrcPath, 'utf-8');
      expect(afterRemove).not.toContain('_authToken');
      expect(secretStorage.delete).toHaveBeenCalled();
    });
  });

  describe('combined operations preserve file integrity', () => {
    it('registry + scoped registries + auth tokens coexist correctly', async () => {
      await manager.setRegistry('http://localhost:4873/');
      await manager.addScopedRegistry('@fortawesome', 'https://npm.fontawesome.com/');
      await manager.addAuthToken('https://npm.fontawesome.com/', 'fa_token_123');

      const content = await fs.readFile(npmrcPath, 'utf-8');
      expect(content).toContain('registry=http://localhost:4873/');
      expect(content).toContain('@fortawesome:registry=https://npm.fontawesome.com/');
      expect(content).toContain('//npm.fontawesome.com/:_authToken=fa_token_123');

      // Reset registry — should only remove the default registry line
      await manager.resetRegistry();
      const afterReset = await fs.readFile(npmrcPath, 'utf-8');
      expect(afterReset).not.toContain('registry=http://localhost:4873/');
      expect(afterReset).toContain('@fortawesome:registry=https://npm.fontawesome.com/');
      expect(afterReset).toContain('//npm.fontawesome.com/:_authToken=fa_token_123');
    });
  });
});
