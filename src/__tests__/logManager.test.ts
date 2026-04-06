import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const {
  mockAppendLine,
  mockShow,
  mockDispose,
  mockCreateOutputChannel,
  mockGet,
  mockGetConfiguration,
} = vi.hoisted(() => {
  const mockAppendLine = vi.fn();
  const mockShow = vi.fn();
  const mockDispose = vi.fn();
  const mockCreateOutputChannel = vi.fn(() => ({
    appendLine: mockAppendLine,
    show: mockShow,
    dispose: mockDispose,
  }));
  const mockGet = vi.fn((_key: string, defaultValue?: any) => defaultValue);
  const mockGetConfiguration = vi.fn(() => ({ get: mockGet }));
  return {
    mockAppendLine,
    mockShow,
    mockDispose,
    mockCreateOutputChannel,
    mockGet,
    mockGetConfiguration,
  };
});

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: mockCreateOutputChannel,
  },
  workspace: {
    getConfiguration: mockGetConfiguration,
  },
}));

import { LogManager } from '../logManager';

/** Creates a mock ChildProcess with EventEmitter stdout and stderr. */
function createMockChildProcess() {
  const proc = {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  };
  return proc as any;
}

describe('LogManager', () => {
  let logManager: LogManager;

  beforeEach(() => {
    vi.clearAllMocks();
    logManager = new LogManager();
  });

  /**
   * Validates: Requirement 5.1
   * Output Channel creation with correct name
   */
  describe('Output Channel creation', () => {
    it('calls createOutputChannel with "Verdaccio" during construction', () => {
      expect(mockCreateOutputChannel).toHaveBeenCalledWith('Verdaccio');
    });

    it('creates exactly one output channel per instance', () => {
      expect(mockCreateOutputChannel).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Validates: Requirement 5.3
   * show() reveals the Output Channel
   */
  describe('show()', () => {
    it('calls outputChannel.show()', () => {
      logManager.show();
      expect(mockShow).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * Validates: Requirement 5.1, 5.3
   * stdout piping writes to channel
   */
  describe('stdout piping', () => {
    it('writes stdout data to the output channel via appendLine', () => {
      const mockProcess = createMockChildProcess();
      logManager.attach(mockProcess);

      mockProcess.stdout.emit('data', Buffer.from('info --- server started'));

      expect(mockAppendLine).toHaveBeenCalledWith('info --- server started');
    });

    it('handles multi-line stdout output', () => {
      const mockProcess = createMockChildProcess();
      logManager.attach(mockProcess);

      mockProcess.stdout.emit('data', Buffer.from('line one\nline two'));

      expect(mockAppendLine).toHaveBeenCalledWith('line one');
      expect(mockAppendLine).toHaveBeenCalledWith('line two');
    });
  });

  /**
   * Validates: Requirement 5.1, 5.3
   * stderr piping writes to channel
   */
  describe('stderr piping', () => {
    it('writes stderr data to the output channel via appendLine', () => {
      const mockProcess = createMockChildProcess();
      logManager.attach(mockProcess);

      mockProcess.stderr.emit('data', Buffer.from('error --- something failed'));

      expect(mockAppendLine).toHaveBeenCalledWith('error --- something failed');
    });

    it('handles multi-line stderr output', () => {
      const mockProcess = createMockChildProcess();
      logManager.attach(mockProcess);

      mockProcess.stderr.emit('data', Buffer.from('warn --- low memory\nerror --- crash'));

      expect(mockAppendLine).toHaveBeenCalledWith('warn --- low memory');
      expect(mockAppendLine).toHaveBeenCalledWith('error --- crash');
    });
  });

  /**
   * Validates: Requirement 5.1
   * dispose() cleans up the output channel
   */
  describe('dispose()', () => {
    it('disposes the output channel', () => {
      logManager.dispose();
      expect(mockDispose).toHaveBeenCalledTimes(1);
    });
  });
});
