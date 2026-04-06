import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockShowErrorMessage,
  mockShowInformationMessage,
  mockReadFile,
  mockWriteFile,
  mockMkdir,
} = vi.hoisted(() => ({
  mockShowErrorMessage: vi.fn(),
  mockShowInformationMessage: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showWarningMessage: vi.fn(),
    showErrorMessage: mockShowErrorMessage,
    showInformationMessage: mockShowInformationMessage,
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

function createMockServerManager(state: string = 'running'): IServerManager {
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

function createMockSecretStorage() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    store: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    onDidChange: vi.fn() as any,
    _store: store,
  };
}


describe('NpmrcManager - Scoped Registries and Auth Tokens', () => {
  let serverManager: IServerManager;
  let secretStorage: ReturnType<typeof createMockSecretStorage>;
  let npmrcManager: NpmrcManager;

  beforeEach(() => {
    vi.clearAllMocks();
    serverManager = createMockServerManager('running');
    secretStorage = createMockSecretStorage();
    npmrcManager = new NpmrcManager(serverManager, secretStorage as any);
  });

  // ---- Scoped Registry Tests ----

  describe('addScopedRegistry', () => {
    it('adds a scoped registry line to existing .npmrc content', async () => {
      const existing = 'always-auth=true\nregistry=http://localhost:4873/\n';
      mockReadFile.mockResolvedValue(existing);
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.addScopedRegistry('@fortawesome', 'https://npm.fontawesome.com/');

      const written = mockWriteFile.mock.calls[0][1] as string;
      expect(written).toContain('@fortawesome:registry=https://npm.fontawesome.com/');
      expect(written).toContain('always-auth=true');
      expect(written).toContain('registry=http://localhost:4873/');
    });

    it('rejects invalid scope without @ prefix', async () => {
      await npmrcManager.addScopedRegistry('noscope', 'https://npm.fontawesome.com/');

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Invalid scope')
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('editScopedRegistry', () => {
    it('updates the URL for an existing scoped registry entry', async () => {
      const existing = 'always-auth=true\n@fortawesome:registry=https://old.fontawesome.com/\n';
      mockReadFile.mockResolvedValue(existing);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.editScopedRegistry('@fortawesome', 'https://new.fontawesome.com/');

      const written = mockWriteFile.mock.calls[0][1] as string;
      expect(written).toContain('@fortawesome:registry=https://new.fontawesome.com/');
      expect(written).not.toContain('https://old.fontawesome.com/');
      expect(written).toContain('always-auth=true');
    });
  });

  describe('removeScopedRegistry', () => {
    it('removes the scoped registry line and preserves other lines', async () => {
      const existing = 'always-auth=true\n@fortawesome:registry=https://npm.fontawesome.com/\nregistry=http://localhost:4873/\n';
      mockReadFile.mockResolvedValue(existing);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.removeScopedRegistry('@fortawesome');

      const written = mockWriteFile.mock.calls[0][1] as string;
      expect(written).not.toContain('@fortawesome:registry=');
      expect(written).toContain('always-auth=true');
      expect(written).toContain('registry=http://localhost:4873/');
    });
  });

  describe('listScopedRegistries', () => {
    it('returns all scoped registry entries from .npmrc', async () => {
      const existing = 'always-auth=true\n@fortawesome:registry=https://npm.fontawesome.com/\n@myorg:registry=https://npm.myorg.com/\nregistry=http://localhost:4873/\n';
      mockReadFile.mockResolvedValue(existing);

      const entries = await npmrcManager.listScopedRegistries();

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ scope: '@fortawesome', registryUrl: 'https://npm.fontawesome.com/' });
      expect(entries[1]).toEqual({ scope: '@myorg', registryUrl: 'https://npm.myorg.com/' });
    });
  });

  // ---- Auth Token Tests ----

  describe('addAuthToken', () => {
    it('writes auth token line to .npmrc and stores in SecretStorage', async () => {
      const existing = 'always-auth=true\n';
      mockReadFile.mockResolvedValue(existing);
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.addAuthToken('https://registry.npmjs.org/', 'my-secret-token');

      const written = mockWriteFile.mock.calls[0][1] as string;
      expect(written).toContain('//registry.npmjs.org/:_authToken=my-secret-token');
      expect(written).toContain('always-auth=true');
      expect(secretStorage.store).toHaveBeenCalledWith(
        'verdaccio.authToken.https://registry.npmjs.org/',
        'my-secret-token'
      );
    });

    it('rejects empty/whitespace-only token', async () => {
      await npmrcManager.addAuthToken('https://registry.npmjs.org/', '   ');

      expect(mockShowErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('empty or whitespace')
      );
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(secretStorage.store).not.toHaveBeenCalled();
    });
  });

  describe('rotateAuthToken', () => {
    it('updates auth token in .npmrc and SecretStorage', async () => {
      const existing = '//registry.npmjs.org/:_authToken=old-token\nalways-auth=true\n';
      mockReadFile.mockResolvedValue(existing);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.rotateAuthToken('https://registry.npmjs.org/', 'new-token');

      const written = mockWriteFile.mock.calls[0][1] as string;
      expect(written).toContain('//registry.npmjs.org/:_authToken=new-token');
      expect(written).not.toContain('old-token');
      expect(secretStorage.store).toHaveBeenCalledWith(
        'verdaccio.authToken.https://registry.npmjs.org/',
        'new-token'
      );
    });
  });

  describe('removeAuthToken', () => {
    it('removes auth token line from .npmrc and deletes from SecretStorage', async () => {
      const existing = '//registry.npmjs.org/:_authToken=my-token\nalways-auth=true\n';
      mockReadFile.mockResolvedValue(existing);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.removeAuthToken('https://registry.npmjs.org/');

      const written = mockWriteFile.mock.calls[0][1] as string;
      expect(written).not.toContain('_authToken');
      expect(written).toContain('always-auth=true');
      expect(secretStorage.delete).toHaveBeenCalledWith(
        'verdaccio.authToken.https://registry.npmjs.org/'
      );
    });
  });

  describe('listAuthTokens', () => {
    it('returns masked token entries from .npmrc', async () => {
      const existing = '//registry.npmjs.org/:_authToken=abcdefgh1234\n//npm.myorg.com/:_authToken=xy\n';
      mockReadFile.mockResolvedValue(existing);

      const entries = await npmrcManager.listAuthTokens();

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({ registryUrl: 'registry.npmjs.org/', maskedToken: '****1234' });
      expect(entries[1]).toEqual({ registryUrl: 'npm.myorg.com/', maskedToken: '****' });
    });
  });

  describe('revealToken', () => {
    it('retrieves token from SecretStorage and shows information message', async () => {
      secretStorage._store.set('verdaccio.authToken.https://registry.npmjs.org/', 'revealed-token');

      const token = await npmrcManager.revealToken('https://registry.npmjs.org/');

      expect(token).toBe('revealed-token');
      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('revealed-token')
      );
    });
  });

  // ---- .npmrc creation when file doesn't exist ----

  describe('.npmrc creation when file does not exist', () => {
    it('creates .npmrc when adding a scoped registry and file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await npmrcManager.addScopedRegistry('@myorg', 'https://npm.myorg.com/');

      expect(mockMkdir).toHaveBeenCalledWith('/mock/workspace', { recursive: true });
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.npmrc'),
        expect.stringContaining('@myorg:registry=https://npm.myorg.com/'),
        'utf-8',
      );
    });
  });
});
