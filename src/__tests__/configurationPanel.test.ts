import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so mocks are available inside vi.mock factories
const {
  mockCreateWebviewPanel,
  mockShowInformationMessage,
  mockActiveTextEditor,
  mockOnDidReceiveMessage,
  mockOnDidDispose,
  mockPostMessage,
  mockPanelReveal,
  mockPanelDispose,
  capturedHtmlSetter,
} = vi.hoisted(() => {
  const onDidReceiveMessageListeners: Array<(msg: any) => void> = [];
  const onDidDisposeListeners: Array<() => void> = [];
  let currentHtml = '';

  return {
    mockCreateWebviewPanel: vi.fn(),
    mockShowInformationMessage: vi.fn(),
    mockActiveTextEditor: { viewColumn: 1 },
    mockOnDidReceiveMessage: vi.fn((cb: (msg: any) => void) => {
      onDidReceiveMessageListeners.push(cb);
      return { dispose: vi.fn() };
    }),
    mockOnDidDispose: vi.fn((cb: () => void) => {
      onDidDisposeListeners.push(cb);
      return { dispose: vi.fn() };
    }),
    mockPostMessage: vi.fn(),
    mockPanelReveal: vi.fn(),
    mockPanelDispose: vi.fn(),
    capturedHtmlSetter: {
      get listeners() { return onDidReceiveMessageListeners; },
      get disposeListeners() { return onDidDisposeListeners; },
      get html() { return currentHtml; },
      set html(val: string) { currentHtml = val; },
      reset() {
        onDidReceiveMessageListeners.length = 0;
        onDidDisposeListeners.length = 0;
        currentHtml = '';
      },
    },
  };
});

function buildMockPanel() {
  return {
    webview: {
      get html() { return capturedHtmlSetter.html; },
      set html(val: string) { capturedHtmlSetter.html = val; },
      onDidReceiveMessage: mockOnDidReceiveMessage,
      postMessage: mockPostMessage,
    },
    onDidDispose: mockOnDidDispose,
    reveal: mockPanelReveal,
    dispose: mockPanelDispose,
  };
}

vi.mock('vscode', () => {
  mockCreateWebviewPanel.mockImplementation(() => buildMockPanel());

  return {
    window: {
      createWebviewPanel: mockCreateWebviewPanel,
      showInformationMessage: mockShowInformationMessage,
      get activeTextEditor() { return mockActiveTextEditor; },
    },
    ViewColumn: { One: 1, Two: 2, Three: 3 },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
  };
});

import { ConfigurationPanel } from '../configurationPanel';
import { IConfigManager } from '../configManager';
import { IServerManager } from '../serverManager';
import { VerdaccioConfig } from '../types';

const sampleConfig: VerdaccioConfig = {
  storage: './storage',
  listen: '0.0.0.0:4873',
  max_body_size: '10mb',
  log: { level: 'warn' },
  uplinks: {
    npmjs: {
      url: 'https://registry.npmjs.org/',
      timeout: '30s',
      maxage: '2m',
      max_fails: 5,
      fail_timeout: '5m',
    },
  },
  packages: {
    '**': { access: '$all', publish: '$authenticated', proxy: ['npmjs'] },
  },
};

function createMockConfigManager(config: VerdaccioConfig = sampleConfig): IConfigManager {
  return {
    getConfigPath: vi.fn().mockReturnValue('/mock/.verdaccio/config.yaml'),
    readConfig: vi.fn().mockResolvedValue(config),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    generateDefaultConfig: vi.fn(),
    configExists: vi.fn(),
    openRawConfig: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IConfigManager;
}

function createMockServerManager(state: string = 'stopped'): IServerManager {
  return {
    state,
    onDidChangeState: vi.fn(),
    port: state === 'running' ? 4873 : undefined,
    startTime: state === 'running' ? new Date() : undefined,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as unknown as IServerManager;
}

/** Simulate a webview message by calling the captured onDidReceiveMessage listener */
function simulateMessage(msg: { command: string; data?: any }): void {
  for (const listener of capturedHtmlSetter.listeners) {
    listener(msg);
  }
}

describe('ConfigurationPanel', () => {
  let configManager: IConfigManager;
  let serverManager: IServerManager;
  const extensionUri = { fsPath: '/mock/ext', scheme: 'file' } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedHtmlSetter.reset();
    // Re-set the mock implementation after clearAllMocks wipes it
    mockCreateWebviewPanel.mockImplementation(() => buildMockPanel());
    // Reset the static singleton so each test gets a fresh panel
    (ConfigurationPanel as any).currentPanel = undefined;
    configManager = createMockConfigManager();
    serverManager = createMockServerManager('stopped');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirement 2.1
   * Form renders with current config values (listen port, storage, max body size, log level)
   */
  describe('form renders with current config values', () => {
    it('renders HTML containing listen address, storage, max body size, and log level', async () => {
      ConfigurationPanel.createOrShow(extensionUri, configManager, serverManager);

      // Wait for the async _updateWebview to complete
      await vi.waitFor(() => {
        expect(capturedHtmlSetter.html).not.toBe('');
      });

      const html = capturedHtmlSetter.html;
      expect(html).toContain('0.0.0.0:4873');
      expect(html).toContain('./storage');
      expect(html).toContain('10mb');
      // Log level 'warn' should be selected
      expect(html).toContain('value="warn"');
      expect(html).toMatch(/warn.*selected/s);
    });

    it('renders uplink settings with URL, timeout, and max retries', async () => {
      ConfigurationPanel.createOrShow(extensionUri, configManager, serverManager);

      await vi.waitFor(() => {
        expect(capturedHtmlSetter.html).not.toBe('');
      });

      const html = capturedHtmlSetter.html;
      expect(html).toContain('npmjs');
      expect(html).toContain('https://registry.npmjs.org/');
      expect(html).toContain('30s');
      expect(html).toContain('5'); // max_fails
    });
  });

  /**
   * Validates: Requirement 2.3
   * Form submission calls updateConfig with correct patch
   */
  describe('form submission', () => {
    it('calls configManager.updateConfig with the submitted values', async () => {
      ConfigurationPanel.createOrShow(extensionUri, configManager, serverManager);

      await vi.waitFor(() => {
        expect(capturedHtmlSetter.html).not.toBe('');
      });

      simulateMessage({
        command: 'save',
        data: {
          listen: '0.0.0.0:5000',
          storage: './new-storage',
          max_body_size: '50mb',
          logLevel: 'info',
          uplinks: {
            npmjs: {
              url: 'https://registry.npmjs.org/',
              timeout: '60s',
              max_fails: 10,
            },
          },
        },
      });

      await vi.waitFor(() => {
        expect(configManager.updateConfig).toHaveBeenCalled();
      });

      const patch = vi.mocked(configManager.updateConfig).mock.calls[0][0];
      expect(patch.listen).toBe('0.0.0.0:5000');
      expect(patch.storage).toBe('./new-storage');
      expect(patch.max_body_size).toBe('50mb');
      expect(patch.log?.level).toBe('info');
    });

    it('sends a saved confirmation message back to the webview', async () => {
      ConfigurationPanel.createOrShow(extensionUri, configManager, serverManager);

      await vi.waitFor(() => {
        expect(capturedHtmlSetter.html).not.toBe('');
      });

      simulateMessage({
        command: 'save',
        data: {
          listen: '0.0.0.0:4873',
          storage: './storage',
          max_body_size: '10mb',
          logLevel: 'warn',
          uplinks: {},
        },
      });

      await vi.waitFor(() => {
        expect(mockPostMessage).toHaveBeenCalledWith({ command: 'saved' });
      });
    });
  });

  /**
   * Validates: Requirement 2.4
   * Restart prompt appears when server is running
   */
  describe('restart prompt when server is running', () => {
    it('shows restart prompt when saving while server is running', async () => {
      serverManager = createMockServerManager('running');
      mockShowInformationMessage.mockResolvedValue('Later');

      ConfigurationPanel.createOrShow(extensionUri, configManager, serverManager);

      await vi.waitFor(() => {
        expect(capturedHtmlSetter.html).not.toBe('');
      });

      simulateMessage({
        command: 'save',
        data: {
          listen: '0.0.0.0:4873',
          storage: './storage',
          max_body_size: '10mb',
          logLevel: 'warn',
          uplinks: {},
        },
      });

      await vi.waitFor(() => {
        expect(mockShowInformationMessage).toHaveBeenCalledWith(
          'Verdaccio configuration updated. Restart the server for changes to take effect?',
          'Restart',
          'Later',
        );
      });
    });

    it('calls restart when user selects Restart', async () => {
      serverManager = createMockServerManager('running');
      mockShowInformationMessage.mockResolvedValue('Restart');

      ConfigurationPanel.createOrShow(extensionUri, configManager, serverManager);

      await vi.waitFor(() => {
        expect(capturedHtmlSetter.html).not.toBe('');
      });

      simulateMessage({
        command: 'save',
        data: {
          listen: '0.0.0.0:4873',
          storage: './storage',
          max_body_size: '10mb',
          logLevel: 'warn',
          uplinks: {},
        },
      });

      await vi.waitFor(() => {
        expect(serverManager.restart).toHaveBeenCalled();
      });
    });
  });

  /**
   * Validates: Requirement 2.4 (negative case)
   * No restart prompt when server is stopped
   */
  describe('no restart prompt when server is stopped', () => {
    it('does NOT show restart prompt when saving while server is stopped', async () => {
      serverManager = createMockServerManager('stopped');

      ConfigurationPanel.createOrShow(extensionUri, configManager, serverManager);

      await vi.waitFor(() => {
        expect(capturedHtmlSetter.html).not.toBe('');
      });

      simulateMessage({
        command: 'save',
        data: {
          listen: '0.0.0.0:4873',
          storage: './storage',
          max_body_size: '10mb',
          logLevel: 'warn',
          uplinks: {},
        },
      });

      // Wait for updateConfig to be called, then verify no info message
      await vi.waitFor(() => {
        expect(configManager.updateConfig).toHaveBeenCalled();
      });

      // Give a tick for any async follow-up
      await vi.waitFor(() => {
        expect(mockPostMessage).toHaveBeenCalledWith({ command: 'saved' });
      });

      expect(mockShowInformationMessage).not.toHaveBeenCalled();
    });
  });
});
