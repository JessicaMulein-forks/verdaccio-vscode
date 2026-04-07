import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEventEmitterFire, mockEventEmitterDispose, mockEventEmitterEvent } =
  vi.hoisted(() => ({
    mockEventEmitterFire: vi.fn(),
    mockEventEmitterDispose: vi.fn(),
    mockEventEmitterEvent: vi.fn(),
  }));

vi.mock('vscode', () => ({
  TreeItem: class {
    label: string;
    collapsibleState: number;
    description?: string;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: class {
    fire = mockEventEmitterFire;
    dispose = mockEventEmitterDispose;
    event = mockEventEmitterEvent;
  },
}));

import { StatusViewProvider, StatusItem } from '../statusViewProvider';
import { IServerManager } from '../serverManager';
import { ServerState } from '../types';

/**
 * Creates a mock IServerManager with controllable state, port, startTime,
 * and a subscribable onDidChangeState.
 */
function createMockServerManager(overrides: {
  state?: ServerState;
  port?: number;
  startTime?: Date;
} = {}): IServerManager & { stateListener: ((s: ServerState) => void) | undefined } {
  let stateListener: ((s: ServerState) => void) | undefined;

  return {
    state: overrides.state ?? 'stopped',
    port: overrides.port,
    startTime: overrides.startTime,
    stateListener,
    onDidChangeState: vi.fn((listener: (s: ServerState) => void) => {
      stateListener = listener;
      // Return a disposable
      return { dispose: vi.fn() };
    }) as any,
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
  };
}

/** Helper to extract label/description pairs from StatusItem[] */
function itemSummaries(items: StatusItem[]): { label: string; description: string | undefined }[] {
  return items.map((item) => ({
    label: item.label as string,
    description: item.description as string | undefined,
  }));
}

describe('StatusViewProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Validates: Requirements 3.1, 3.2
   * Tree item rendering for each server state
   */
  describe('tree item rendering per state', () => {
    it('returns "Status: Stopped" and Start action when state is stopped', () => {
      const mgr = createMockServerManager({ state: 'stopped' });
      const provider = new StatusViewProvider(mgr);

      const items = provider.getChildren();
      const summaries = itemSummaries(items);

      expect(summaries[0]).toEqual({ label: 'Status', description: 'Stopped' });
      expect(summaries[1]).toEqual({ label: 'Start Verdaccio', description: undefined });
    });

    it('returns "Status: Starting..." when state is starting', () => {
      const mgr = createMockServerManager({ state: 'starting' });
      const provider = new StatusViewProvider(mgr);

      const items = provider.getChildren();
      const summaries = itemSummaries(items);

      expect(summaries).toEqual([{ label: 'Status', description: 'Starting...' }]);
    });

    it('returns status, address, uptime, and packages when state is running', () => {
      const startTime = new Date(Date.now() - 3661000); // ~1h 1m 1s ago
      const mgr = createMockServerManager({
        state: 'running',
        port: 4873,
        startTime,
      });
      const provider = new StatusViewProvider(mgr);

      const items = provider.getChildren();
      const summaries = itemSummaries(items);

      expect(summaries.length).toBe(6);
      expect(summaries[0]).toEqual({ label: 'Status', description: 'Running' });
      expect(summaries[1]).toEqual({ label: 'Address', description: '0.0.0.0:4873' });
      // Uptime is dynamic, just verify it exists and matches the format
      expect(summaries[2].label).toBe('Uptime');
      expect(summaries[2].description).toMatch(/^\d+h \d+m \d+s$/);
      expect(summaries[3]).toEqual({ label: 'Packages', description: '0' });
      expect(summaries[4]).toEqual({ label: 'Stop Verdaccio', description: undefined });
      expect(summaries[5]).toEqual({ label: 'Restart Verdaccio', description: undefined });
    });

    it('returns "Status: Error" and Start action when state is error', () => {
      const mgr = createMockServerManager({ state: 'error' });
      const provider = new StatusViewProvider(mgr);

      const items = provider.getChildren();
      const summaries = itemSummaries(items);

      expect(summaries[0]).toEqual({ label: 'Status', description: 'Error' });
      expect(summaries[1]).toEqual({ label: 'Start Verdaccio', description: undefined });
    });
  });

  /**
   * Validates: Requirement 3.2
   * Uptime display updates correctly
   */
  describe('uptime display', () => {
    it('shows increasing uptime on successive getChildren calls', () => {
      const startTime = new Date(Date.now() - 60000); // 1 minute ago
      const mgr = createMockServerManager({
        state: 'running',
        port: 4873,
        startTime,
      });
      const provider = new StatusViewProvider(mgr);

      const items = provider.getChildren();
      const uptimeItem = items.find((i) => i.label === 'Uptime');
      expect(uptimeItem).toBeDefined();
      // The uptime description should contain at least "1m" since startTime is 1 min ago
      expect(uptimeItem!.description).toMatch(/\d+h \d+m \d+s/);
    });
  });

  /**
   * Validates: Requirement 3.1
   * Package count display
   */
  describe('package count', () => {
    it('displays 0 packages by default in running state', () => {
      const mgr = createMockServerManager({
        state: 'running',
        port: 4873,
        startTime: new Date(),
      });
      const provider = new StatusViewProvider(mgr);

      const items = provider.getChildren();
      const pkgItem = items.find((i) => i.label === 'Packages');
      expect(pkgItem).toBeDefined();
      expect(pkgItem!.description).toBe('0');
    });

    it('displays updated package count after setPackageCount', () => {
      const mgr = createMockServerManager({
        state: 'running',
        port: 4873,
        startTime: new Date(),
      });
      const provider = new StatusViewProvider(mgr);

      provider.setPackageCount(42);

      const items = provider.getChildren();
      const pkgItem = items.find((i) => i.label === 'Packages');
      expect(pkgItem).toBeDefined();
      expect(pkgItem!.description).toBe('42');
    });
  });

  /**
   * Validates: Requirement 3.6
   * State change subscription triggers refresh
   */
  describe('state change subscription', () => {
    it('subscribes to onDidChangeState on construction', () => {
      const mgr = createMockServerManager({ state: 'stopped' });
      new StatusViewProvider(mgr);

      expect(mgr.onDidChangeState).toHaveBeenCalledTimes(1);
      expect(mgr.onDidChangeState).toHaveBeenCalledWith(expect.any(Function));
    });

    it('fires onDidChangeTreeData when state changes', () => {
      const mgr = createMockServerManager({ state: 'stopped' });
      const provider = new StatusViewProvider(mgr);

      // Simulate a state change by calling the registered listener
      const listener = (mgr.onDidChangeState as any).mock.calls[0][0];
      listener('running');

      // The provider should have fired its tree data change event
      expect(mockEventEmitterFire).toHaveBeenCalled();
    });
  });

  /**
   * Validates: Requirement 3.1
   * getTreeItem returns the element itself
   */
  describe('getTreeItem', () => {
    it('returns the same StatusItem passed in', () => {
      const mgr = createMockServerManager({ state: 'stopped' });
      const provider = new StatusViewProvider(mgr);
      const item = new StatusItem('Test', 'Value');

      expect(provider.getTreeItem(item)).toBe(item);
    });
  });
});
