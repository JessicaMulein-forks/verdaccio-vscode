import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockShowWarningMessage } = vi.hoisted(() => ({
  mockShowWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => {
  class MockVscodeEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    fire = (e: any) => { for (const l of this._listeners) { l(e); } };
    dispose = () => { this._listeners = []; };
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter((l) => l !== listener); } };
    };
  }
  return {
    EventEmitter: MockVscodeEventEmitter,
    window: { showWarningMessage: mockShowWarningMessage },
  };
});

import { ServerManager } from '../serverManager';
import { IConfigManager } from '../configManager';

function createMockConfigManager(): IConfigManager {
  return {
    getConfigPath: vi.fn().mockReturnValue('/mock/.verdaccio/config.yaml'),
    readConfig: vi.fn(), updateConfig: vi.fn(), generateDefaultConfig: vi.fn(),
    configExists: vi.fn(), openRawConfig: vi.fn(), dispose: vi.fn(),
  } as unknown as IConfigManager;
}

describe('ServerManager (in-process)', () => {
  let sm: ServerManager;
  let configManager: IConfigManager;
  const logMessages: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    logMessages.length = 0;
    configManager = createMockConfigManager();
    sm = new ServerManager(configManager, (msg) => logMessages.push(msg));
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('initial state is stopped', () => {
    expect(sm.state).toBe('stopped');
    expect(sm.port).toBeUndefined();
  });

  it('resets stale starting state with no server', async () => {
    // Manually set stale state
    (sm as any)._info.state = 'starting';
    (sm as any)._server = undefined;
    // start() should reset and try to start
    await expect(sm.start()).rejects.toThrow(); // will fail because no real verdaccio
    // But it should have attempted (state went through starting)
    expect(logMessages.some(m => m.includes('Starting verdaccio'))).toBe(true);
  });

  it('silently returns if already running', async () => {
    (sm as any)._info.state = 'running';
    (sm as any)._server = {}; // fake server
    await sm.start();
    expect(logMessages.length).toBe(0); // no log = no action taken
  });

  it('stop from stopped is a no-op', async () => {
    await sm.stop();
    expect(sm.state).toBe('stopped');
  });

  it('stop with no server resets to stopped', async () => {
    (sm as any)._info.state = 'running';
    (sm as any)._server = undefined;
    await sm.stop();
    expect(sm.state).toBe('stopped');
  });

  it('stop closes the server', async () => {
    const mockClose = vi.fn((cb: () => void) => cb());
    (sm as any)._info.state = 'running';
    (sm as any)._server = { close: mockClose };
    await sm.stop();
    expect(mockClose).toHaveBeenCalled();
    expect(sm.state).toBe('stopped');
  });

  it('dispose closes server', () => {
    const mockClose = vi.fn();
    (sm as any)._server = { close: mockClose };
    sm.dispose();
    expect(mockClose).toHaveBeenCalled();
  });

  it('fires state change events', () => {
    const states: string[] = [];
    sm.onDidChangeState((s) => states.push(s));
    (sm as any)._setState('starting');
    (sm as any)._setState('running');
    (sm as any)._setState('stopped');
    expect(states).toEqual(['starting', 'running', 'stopped']);
  });

  it('parsePortFromConfig returns 4873 as default', () => {
    const port = (sm as any)._parsePortFromConfig();
    expect(port).toBe(4873);
  });
});
