import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockShowInformationMessage,
  mockWorkspaceFolders,
  mockAccess,
} = vi.hoisted(() => ({
  mockShowInformationMessage: vi.fn(),
  mockWorkspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  mockAccess: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: mockShowInformationMessage,
  },
  workspace: {
    workspaceFolders: mockWorkspaceFolders,
  },
}));

vi.mock('fs/promises', () => ({
  access: mockAccess,
}));

import { OnboardingManager, IDependencyMirrorManagerMinimal } from '../onboardingManager';
import { IServerManager } from '../serverManager';
import { INpmrcManager } from '../npmrcManager';

function createMockServerManager(overrides: Partial<IServerManager> = {}): IServerManager {
  return {
    state: 'stopped',
    port: 4873,
    startTime: undefined,
    onDidChangeState: vi.fn() as any,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as IServerManager;
}

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

function createMockWorkspaceState(initial: Record<string, unknown> = {}): any {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn((key: string, defaultValue?: unknown) => store.has(key) ? store.get(key) : defaultValue),
    update: vi.fn((key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); }),
  };
}

function createMockMirrorManager(): IDependencyMirrorManagerMinimal {
  return {
    mirrorDependencies: vi.fn().mockResolvedValue({ newlyCached: [], alreadyAvailable: [], totalNewSizeBytes: 0 }),
  };
}

describe('OnboardingManager', () => {
  let serverManager: IServerManager;
  let npmrcManager: INpmrcManager;
  let workspaceState: any;
  let mirrorManager: IDependencyMirrorManagerMinimal;

  beforeEach(() => {
    vi.clearAllMocks();
    serverManager = createMockServerManager();
    npmrcManager = createMockNpmrcManager();
    workspaceState = createMockWorkspaceState();
    mirrorManager = createMockMirrorManager();
  });

  /**
   * Validates: Requirement 16.1
   * Config detection triggers onboarding notification
   */
  describe('config detection', () => {
    it('shows onboarding notification when config exists', async () => {
      mockAccess.mockResolvedValue(undefined); // config exists
      mockShowInformationMessage.mockResolvedValue('No thanks');

      const manager = new OnboardingManager(serverManager, npmrcManager, workspaceState, mirrorManager);
      await manager.checkAndPrompt();

      expect(mockShowInformationMessage).toHaveBeenCalledWith(
        'Verdaccio configuration detected. Would you like to bootstrap your local registry environment?',
        'Yes, set up',
        'No thanks',
      );
    });
  });

  /**
   * Validates: Requirement 16.8
   * Skips when .verdaccio/config.yaml does not exist
   */
  describe('skip when no config', () => {
    it('skips silently when config does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const manager = new OnboardingManager(serverManager, npmrcManager, workspaceState, mirrorManager);
      await manager.checkAndPrompt();

      expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });
  });

  /**
   * Validates: Requirement 16.7
   * Skips when already onboarded (state persisted)
   */
  describe('skip when already onboarded', () => {
    it('skips when onboarding state is already persisted', async () => {
      mockAccess.mockResolvedValue(undefined);
      workspaceState = createMockWorkspaceState({ 'verdaccio.onboardingComplete': true });

      const manager = new OnboardingManager(serverManager, npmrcManager, workspaceState, mirrorManager);
      await manager.checkAndPrompt();

      expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });
  });

  /**
   * Validates: Requirement 16.6
   * State persistence on completion
   */
  describe('state persistence', () => {
    it('persists onboarding state on completion', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockShowInformationMessage
        .mockResolvedValueOnce('Yes, set up')  // onboarding prompt
        .mockResolvedValueOnce('Skip');          // mirror prompt

      const manager = new OnboardingManager(serverManager, npmrcManager, workspaceState, mirrorManager);
      await manager.checkAndPrompt();

      expect(workspaceState.update).toHaveBeenCalledWith('verdaccio.onboardingComplete', true);
    });
  });

  /**
   * Validates: Requirements 16.2, 16.3
   * Delegates to ServerManager.start() and NpmrcManager.setRegistry()
   */
  describe('delegation', () => {
    it('starts server and sets registry on accept', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockShowInformationMessage
        .mockResolvedValueOnce('Yes, set up')  // onboarding prompt
        .mockResolvedValueOnce('Skip');          // mirror prompt

      const manager = new OnboardingManager(serverManager, npmrcManager, workspaceState, mirrorManager);
      await manager.checkAndPrompt();

      expect(serverManager.start).toHaveBeenCalled();
      expect(npmrcManager.setRegistry).toHaveBeenCalledWith('http://localhost:4873');
    });

    it('offers to mirror dependencies and delegates on accept', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockShowInformationMessage
        .mockResolvedValueOnce('Yes, set up')   // onboarding prompt
        .mockResolvedValueOnce('Yes, mirror');   // mirror prompt

      const manager = new OnboardingManager(serverManager, npmrcManager, workspaceState, mirrorManager);
      await manager.checkAndPrompt();

      expect(mirrorManager.mirrorDependencies).toHaveBeenCalled();
    });
  });
});
