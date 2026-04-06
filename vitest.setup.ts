/**
 * Vitest setup file
 * Runs before all tests
 */

import { vi } from "vitest";

// Mock @ai-capabilities-suite/vscode-shared-status-bar
vi.mock("@ai-capabilities-suite/vscode-shared-status-bar", () => ({
  setOutputChannel: vi.fn(),
  registerExtension: vi.fn().mockResolvedValue(undefined),
  unregisterExtension: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
  getStatusBarItem: vi.fn().mockReturnValue(undefined),
  getActiveExtensionCount: vi.fn().mockReturnValue(0),
  getCommandDisposable: vi.fn().mockReturnValue(undefined),
  getDiagnosticInfo: vi.fn().mockReturnValue({
    activeExtensionCount: 0,
    registeredExtensions: [],
    statusBarExists: false,
    statusBarVisible: false,
    commandRegistered: false,
    registerCommandRegistered: false,
    lastError: null,
  }),
  resetStateForTesting: vi.fn(),
}));

// Mock @ai-capabilities-suite/mcp-client-base
vi.mock("@ai-capabilities-suite/mcp-client-base", () => ({
  BaseMCPClient: class BaseMCPClient {
    constructor() {}
    async start() {}
    stop() {}
    async reconnect() {
      return true;
    }
    getConnectionStatus() {
      return {
        state: "connected",
        message: "Connected",
        serverProcessRunning: true,
        timestamp: Date.now(),
      };
    }
    getDiagnostics() {
      return {
        extensionName: "test",
        processRunning: true,
        connectionState: "connected",
        pendingRequestCount: 0,
        pendingRequests: [],
        recentCommunication: [],
        stateHistory: [],
      };
    }
    isServerProcessAlive() {
      return true;
    }
    protected async callTool() {
      return {};
    }
  },
  TimeoutManager: class TimeoutManager {},
  ConnectionStateManager: class ConnectionStateManager {},
  ReSyncManager: class ReSyncManager {},
}));
