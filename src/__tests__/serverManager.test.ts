import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Use vi.hoisted so these are available inside the hoisted vi.mock factories
const {
  mockShowWarningMessage,
  mockShowErrorMessage,
  mockStateEmitterFire,
  mockStateEmitterDispose,
  mockSpawn,
} = vi.hoisted(() => ({
  mockShowWarningMessage: vi.fn(),
  mockShowErrorMessage: vi.fn(),
  mockStateEmitterFire: vi.fn(),
  mockStateEmitterDispose: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('vscode', () => {
  class MockVscodeEventEmitter {
    fire = mockStateEmitterFire;
    dispose = mockStateEmitterDispose;
    event = vi.fn();
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
    it('transitions from stopped → starting on start()', async () => {
      expect(serverManager.state).toBe('stopped');

      await serverManager.start();

      expect(serverManager.state).toBe('starting');
      expect(mockSpawn).toHaveBeenCalledWith('verdaccio', [
        '--config',
        '/mock/workspace/.verdaccio/config.yaml',
      ]);
    });

    it('transitions from starting → running when ready output is detected', async () => {
      await serverManager.start();
      expect(serverManager.state).toBe('starting');

      // Simulate Verdaccio printing its ready message
      mockChild.stdout.emit('data', Buffer.from('warn --- http address - http://0.0.0.0:4873/ - verdaccio/5.0.0'));

      expect(serverManager.state).toBe('running');
      expect(serverManager.port).toBe(4873);
      expect(serverManager.startTime).toBeInstanceOf(Date);
    });

    it('transitions from running → stopped on stop()', async () => {
      await serverManager.start();
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
      expect(serverManager.state).toBe('running');

      const stopPromise = serverManager.stop();

      // Simulate process exiting after SIGTERM
      mockChild.emit('close', 0);
      await stopPromise;

      expect(serverManager.state).toBe('stopped');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('fires onDidChangeState for each transition', async () => {
      await serverManager.start();
      // 'starting' state fired
      expect(mockStateEmitterFire).toHaveBeenCalledWith('starting');

      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
      // 'running' state fired
      expect(mockStateEmitterFire).toHaveBeenCalledWith('running');

      const stopPromise = serverManager.stop();
      mockChild.emit('close', 0);
      await stopPromise;
      // 'stopped' state fired
      expect(mockStateEmitterFire).toHaveBeenCalledWith('stopped');
    });
  });

  /**
   * Validates: Requirement 1.6
   * Duplicate start guard shows warning
   */
  describe('duplicate start guard', () => {
    it('shows warning when start() is called while running', async () => {
      await serverManager.start();
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
      expect(serverManager.state).toBe('running');

      await serverManager.start();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Verdaccio server is already running.'
      );
    });

    it('shows warning when start() is called while starting', async () => {
      await serverManager.start();
      expect(serverManager.state).toBe('starting');

      await serverManager.start();

      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        'Verdaccio server is already running.'
      );
    });
  });

  /**
   * Validates: Requirement 1.4
   * Unexpected exit captures exit code and last output lines
   */
  describe('unexpected exit', () => {
    it('shows error with exit code and last output on unexpected close', async () => {
      await serverManager.start();
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
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
      await serverManager.start();

      // Feed 25 lines
      for (let i = 1; i <= 25; i++) {
        mockChild.stdout.emit('data', Buffer.from(`line-${i}\n`));
      }

      // The buffer should only keep the last 20
      expect(serverManager.outputBuffer.length).toBeLessThanOrEqual(20);
      // First lines should have been evicted
      expect(serverManager.outputBuffer).not.toContain('line-1');
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
      await serverManager.start();
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
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
      await serverManager.start();
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));

      const stopPromise = serverManager.stop();

      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Process exits quickly
      mockChild.emit('close', 0);
      await stopPromise;

      // Advance past the timeout — SIGKILL should NOT have been sent
      vi.advanceTimersByTime(6000);
      expect(mockChild.kill).not.toHaveBeenCalledWith('SIGKILL');
    });
  });

  /**
   * Validates: Requirement 1.5
   * Restart cycles through stop then start
   */
  describe('restart', () => {
    it('stops the running server then starts a new one', async () => {
      await serverManager.start();
      mockChild.stdout.emit('data', Buffer.from('http address - http://localhost:4873/'));
      expect(serverManager.state).toBe('running');

      // Prepare a fresh mock child for the second start
      const secondChild = createMockChildProcess(99999);
      mockSpawn.mockReturnValue(secondChild);

      const restartPromise = serverManager.restart();

      // The first process should receive SIGTERM from stop()
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Simulate first process exiting
      mockChild.emit('close', 0);
      await restartPromise;

      // After restart, a new process should have been spawned
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(serverManager.state).toBe('starting');
    });

    it('restart from stopped state just starts', async () => {
      expect(serverManager.state).toBe('stopped');

      await serverManager.restart();

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(serverManager.state).toBe('starting');
    });
  });

  /**
   * Validates: Requirement 1.1
   * Tracks pid from spawned process
   */
  describe('process info tracking', () => {
    it('tracks pid from the spawned process', async () => {
      await serverManager.start();
      expect(serverManager.pid).toBe(12345);
    });
  });
});
