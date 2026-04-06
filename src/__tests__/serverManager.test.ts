import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Use vi.hoisted so these are available inside the hoisted vi.mock factories
const {
  mockShowWarningMessage,
  mockShowErrorMessage,
  mockSpawn,
} = vi.hoisted(() => ({
  mockShowWarningMessage: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('vscode', () => {
  // Functional EventEmitter that supports fire/event/dispose
  class MockVscodeEventEmitter {
    private _listeners: Array<(e: any) => void> = [];
    fire = (e: any) => {
      for (const listener of this._listeners) {
        listener(e);
      }
    };
    dispose = () => {
      this._listeners = [];
    };
    event = (listener: (e: any) => void) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter((l) => l !== listener); } };
    };
  }
  return {
    EventEmitter: MockVscodeEventEmitter,
    window: {
      showWarningMessage: mockShowWarningMessage,
      showErrorMessage: mockShowErrorMessage,
    },
  };
});

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

import { ServerManager } from '../serverManager';
import { IConfigManager } from '../configManager';

/** Creates a mock ChildProcess with controllable stdout, stderr, and events. */
function createMockChildProcess(pid = 12345) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
    killed: boolean;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = pid;
  proc.killed = false;
  return proc;
}

/** Creates a minimal mock IConfigManager. */
function createMockConfigManager(): IConfigManager {
  return {
    getConfigPath: vi.fn().mockReturnValue('/mock/workspace/.verdaccio/config.yaml'),
    readConfig: vi.fn(),
    updateConfig: vi.fn(),
    generateDefaultConfig: vi.fn(),
    configExists: vi.fn(),
    openRawConfig: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IConfigManager;
}

/**
 * Helper: starts the server and emits the ready line so start() resolves.
 * Returns the start promise.
 */
async function startAndReady(sm: ServerManager, child: ReturnType<typeof createMockChildProcess>, readyLine = 'warn --- http address - http://0.0.0.0:4873/ - verdaccio/5.0.0') {
  // Emit the ready line on next microtask so start() can set up listeners first
  const startPromise = sm.start();
  child.stdout.emit('data', Buffer.from(readyLine));
  await startPromise;
}

describe('ServerManager', () => {
  let serverManager: ServerManager;
  let configManager: IConfigManager;
  let mockChild: ReturnType<typeof createMockChildProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    configManager = createMockConfigManager();
    serverManager = new ServerManager(configManager);

    mockChild = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Validates: Requirements 1.1, 1.2
   * State transitions: stopped → starting → running → stopped
   */
  describe('state transitions', () => {
    it('transitions to running when ready output is detected and start() resolves', async () => {
      expect(serverManager.state).toBe('stopped');

      await startAndReady(serverManager, mockChild);

      expect(serverManager.state).toBe('running');
      expect(serverManager.port).toBe(4873);
      expect(serverManager.startTime).toBeInstanceOf(Date);
      expect(mockSpawn).toHaveBeenCalledWith('verdaccio', [
        '--config',
        '/mock/workspace/.verdaccio/config.yaml',
      ]);
    });

    it('transitions from running → stopped on stop()', async () => {
      await startAndReady(serverManager, mockChild);
      expect(serverManager.state).toBe('running');

      const stopPromise = serverManager.stop();

      // Simulate process exiting after SIGTERM
      mockChild.emit('close', 0);
      await stopPromise;

      expect(serverManager.state).toBe('stopped');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('start() resolves only after state becomes running', async () => {
      const startPromise = serverManager.start();

      // State should be 'starting' before ready line
      expect(serverManager.state).toBe('starting');

      // Emit ready line
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));

      await startPromise;
      expect(serverManager.state).toBe('running');
    });

    it('start() rejects if process exits before becoming ready', async () => {
      const startPromise = serverManager.start();
      expect(serverManager.state).toBe('starting');

      // Process exits unexpectedly before ready
      mockChild.emit('close', 1);

      await expect(startPromise).rejects.toThrow('Process exited with code 1');
      expect(serverManager.state).toBe('error');
    });
  });

  /**
   * Validates: Requirement 1.6
   * Duplicate start guard shows warning
   */
  describe('duplicate start guard', () => {
    it('shows warning when start() is called while running', async () => {
      await startAndReady(serverManager, mockChild);
      expect(serverManager.state).toBe('running');

      await serverManager.start();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Verdaccio server is already running.'
      );
    });

    it('shows warning when start() is called while starting', async () => {
      // Don't await — leave in starting state
      const startPromise = serverManager.start();
      expect(serverManager.state).toBe('starting');

      await serverManager.start();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Verdaccio server is already running.'
      );

      // Clean up: emit ready so the first start resolves
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
      await startPromise;
    });
  });

  /**
   * Validates: Requirement 1.4
   * Unexpected exit captures exit code and last output lines
   */
  describe('unexpected exit', () => {
    it('shows error with exit code and last output on unexpected close', async () => {
      await startAndReady(serverManager, mockChild);
      expect(serverManager.state).toBe('running');

      // Feed some output lines
      for (let i = 1; i <= 5; i++) {
        mockChild.stdout.emit('data', Buffer.from(`log line ${i}\n`));
      }

      // Simulate unexpected exit
      mockChild.emit('close', 1);

      expect(mockShowErrorMessage).toHaveBeenCalledTimes(1);
      const errorMsg = mockShowErrorMessage.mock.calls[0][0] as string;
      expect(errorMsg).toContain('code 1');
      expect(errorMsg).toContain('log line');
    });

    it('buffers at most 20 lines of output', async () => {
      const startPromise = serverManager.start();

      // Feed 25 lines (before ready, so state is still 'starting')
      for (let i = 1; i <= 25; i++) {
        mockChild.stdout.emit('data', Buffer.from(`line-${i}\n`));
      }

      // The buffer should only keep the last 20
      expect(serverManager.outputBuffer.length).toBeLessThanOrEqual(20);
      // First lines should have been evicted
      expect(serverManager.outputBuffer).not.toContain('line-1');

      // Clean up: emit ready so start resolves
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
      await startPromise;
    });
  });

  /**
   * Validates: Requirement 7.3
   * Graceful shutdown timeout escalates to SIGKILL
   */
  describe('graceful shutdown timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends SIGTERM first, then SIGKILL after 5 seconds if process does not exit', async () => {
      const startPromise = serverManager.start();
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
      await startPromise;
      expect(serverManager.state).toBe('running');

      const stopPromise = serverManager.stop();

      // SIGTERM should have been sent immediately
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');

      // Advance time by 5 seconds — the graceful shutdown timeout
      vi.advanceTimersByTime(5000);

      // SIGKILL should now have been sent
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

      // Let the process finally exit to resolve the promise
      mockChild.emit('close', null);
      await stopPromise;

      expect(serverManager.state).toBe('stopped');
    });

    it('does not send SIGKILL if process exits before timeout', async () => {
      const startPromise = serverManager.start();
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
      await startPromise;

      const stopPromise = serverManager.stop();

      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Process exits quickly
      mockChild.emit('close', 0);
      await stopPromise;

      // Advance past the timeout — SIGKILL should NOT have been sent
      vi.advanceTimersByTime(6000);
      expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    });

    it('resolves start() via timeout fallback when ready line is never detected', async () => {
      const startPromise = serverManager.start();
      expect(serverManager.state).toBe('starting');

      // Advance past the startup timeout (30s)
      vi.advanceTimersByTime(30000);

      await startPromise;
      expect(serverManager.state).toBe('running');
      expect(serverManager.port).toBe(4873); // default fallback
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('did not print its ready message')
      );
    });
  });

  /**
   * Validates: Requirement 1.5
   * Restart cycles through stop then start
   */
  describe('restart', () => {
    it('stops the running server then starts a new one', async () => {
      await startAndReady(serverManager, mockChild);
      expect(serverManager.state).toBe('running');

      // Prepare a fresh mock child for the second start
      const secondChild = createMockChildProcess(99999);
      mockSpawn.mockReturnValue(secondChild);

      // Start restart — it will call stop() then start()
      const restartPromise = serverManager.restart();

      // Simulate first process exiting so stop() resolves
      mockChild.emit('close', 0);

      // After stop resolves, start() will be called with secondChild.
      // We need to wait a tick for start() to set up listeners, then emit ready.
      // Use queueMicrotask to ensure start() has attached its listeners.
      await new Promise<void>((resolve) => {
        const check = () => {
          if (serverManager.state === 'starting') {
            secondChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
            resolve();
          } else {
            setTimeout(check, 1);
          }
        };
        check();
      });

      await restartPromise;

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(serverManager.state).toBe('running');
    });

    it('restart from stopped state just starts', async () => {
      expect(serverManager.state).toBe('stopped');

      const restartPromise = serverManager.restart();

      // Wait for state to become 'starting' then emit ready
      await new Promise<void>((resolve) => {
        const check = () => {
          if (serverManager.state === 'starting') {
            mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
            resolve();
          } else {
            setTimeout(check, 1);
          }
        };
        check();
      });

      await restartPromise;

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(serverManager.state).toBe('running');
    });
  });

  /**
   * Validates: Requirement 1.1
   * Tracks pid from spawned process
   */
  describe('process info tracking', () => {
    it('tracks pid from the spawned process', async () => {
      const startPromise = serverManager.start();
      // pid is set immediately on spawn, even before ready
      expect(serverManager.pid).toBe(12345);

      // Clean up
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
      await startPromise;
    });
  });

  /**
   * Validates: Promise contract — start() settles exactly once
   */
  describe('promise contract', () => {
    it('start() rejects on spawn error and does not resolve', async () => {
      const startPromise = serverManager.start();

      mockChild.emit('error', new Error('ENOENT'));

      await expect(startPromise).rejects.toThrow('ENOENT');
      expect(serverManager.state).toBe('error');
    });
  });
});
