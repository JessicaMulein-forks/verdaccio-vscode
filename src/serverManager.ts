import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { ServerState, ServerInfo } from './types';
import { IConfigManager } from './configManager';

export interface IServerManager extends vscode.Disposable {
  readonly state: ServerState;
  readonly onDidChangeState: vscode.Event<ServerState>;
  readonly port: number | undefined;
  readonly startTime: Date | undefined;
  /** Starts the server. Resolves when the server is confirmed running (port detected) or rejects on failure. */
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

const OUTPUT_BUFFER_SIZE = 20;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 5000;

export class ServerManager implements IServerManager {
  private _info: ServerInfo = {
    state: 'stopped',
    port: undefined,
    startTime: undefined,
    pid: undefined,
    lastError: undefined,
  };

  private _process: ChildProcess | undefined;
  private _outputBuffer: string[] = [];
  private _startupTimer: NodeJS.Timeout | undefined;
  private readonly _stateEmitter = new vscode.EventEmitter<ServerState>();
  private readonly _configManager: IConfigManager;

  readonly onDidChangeState: vscode.Event<ServerState> = this._stateEmitter.event;

  constructor(configManager: IConfigManager) {
    this._configManager = configManager;
  }

  get state(): ServerState {
    return this._info.state;
  }

  get port(): number | undefined {
    return this._info.port;
  }

  get startTime(): Date | undefined {
    return this._info.startTime;
  }

  get pid(): number | undefined {
    return this._info.pid;
  }

  get serverInfo(): ServerInfo {
    return { ...this._info };
  }

  get outputBuffer(): readonly string[] {
    return [...this._outputBuffer];
  }

  async start(): Promise<void> {
    // If stuck in 'starting' with no process, reset to stopped
    if (this._info.state === 'starting' && !this._process) {
      this._setState('stopped');
      this._resetInfo();
    }

    if (this._info.state === 'running' || this._info.state === 'starting') {
      vscode.window.showWarningMessage(`Verdaccio server is already ${this._info.state}.`);
      return;
    }

    const configPath = this._configManager.getConfigPath();
    this._setState('starting');
    this._outputBuffer = [];
    this._pendingOutput = '';

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) { return; }
        settled = true;
        fn();
      };

      try {
        const child = spawn('verdaccio', ['--config', configPath]);
        this._process = child;
        this._info.pid = child.pid;
        console.log('[Verdaccio] Spawned verdaccio, pid:', child.pid, 'config:', configPath);

        // Listen for the ready transition to resolve the promise
        const readyListener = this.onDidChangeState((state) => {
          if (state === 'running') {
            readyListener.dispose();
            settle(() => resolve());
          }
        });

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          console.log('[Verdaccio] stdout:', text.substring(0, 200));
          this._bufferOutput(text);
          this._detectReady(text);
        });

        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          console.log('[Verdaccio] stderr:', text.substring(0, 200));
          this._bufferOutput(text);
          this._detectReady(text);
        });

        child.on('error', (err: Error) => {
          this._clearStartupTimer();
          readyListener.dispose();
          this._info.lastError = err.message;
          this._setState('error');
          settle(() => reject(err));
        });

        child.on('close', (code: number | null) => {
          this._clearStartupTimer();
          readyListener.dispose();
          const wasRunning = this._info.state === 'running' || this._info.state === 'starting';
          this._process = undefined;
          this._info.pid = undefined;

          // Only treat as unexpected if we didn't initiate the stop
          if (wasRunning && this._info.state !== 'stopped') {
            this._info.lastError = `Process exited with code ${code}`;
            this._setState('error');
            const lastLines = this._outputBuffer.join('\n');
            vscode.window.showErrorMessage(
              `Verdaccio exited unexpectedly (code ${code}).\n\nLast output:\n${lastLines}`
            );
            settle(() => reject(new Error(`Process exited with code ${code}`)));
          }
        });

        // Start a timeout so we don't stay in 'starting' forever
        this._startupTimer = setTimeout(() => {
          console.log('[Verdaccio] Startup timeout fired, state:', this._info.state, 'settled:', settled);
          try {
            if (this._info.state === 'starting') {
              this._info.port = this._info.port ?? this._parsePortFromConfig();
              this._info.startTime = new Date();
              this._setState('running');
              readyListener.dispose();
              settle(() => resolve());
            }
          } catch (e) {
            console.error('[Verdaccio] Timeout handler error:', e);
            // If anything fails in the timeout, still resolve so we don't hang
            this._info.port = this._info.port ?? 4873;
            this._info.startTime = new Date();
            this._info.state = 'running';
            readyListener.dispose();
            settle(() => resolve());
          }
        }, STARTUP_TIMEOUT_MS);

        // If spawn itself failed synchronously (no pid), reject
        if (!child.pid) {
          readyListener.dispose();
          settle(() => reject(new Error('Failed to spawn verdaccio process')));
        }
      } catch (err: any) {
        this._clearStartupTimer();
        this._info.lastError = err.message;
        this._setState('error');
        settle(() => reject(err));
      }
    });
  }

  async stop(): Promise<void> {
    this._clearStartupTimer();
    if (this._info.state === 'stopped') {
      return;
    }

    const child = this._process;
    if (!child) {
      this._setState('stopped');
      this._resetInfo();
      return;
    }

    return new Promise<void>((resolve) => {
      let forceKillTimer: NodeJS.Timeout | undefined;
      let resolved = false;

      const onExit = () => {
        if (resolved) { return; }
        resolved = true;
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        this._process = undefined;
        this._resetInfo();
        this._setState('stopped');
        resolve();
      };

      child.once('close', onExit);
      child.once('exit', onExit);

      // Send SIGTERM for graceful shutdown
      child.kill('SIGTERM');

      // After 5 seconds, force kill with SIGKILL
      forceKillTimer = setTimeout(() => {
        if (!resolved && child && !child.killed) {
          child.kill('SIGKILL');
        }
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  dispose(): void {
    this._clearStartupTimer();
    if (this._process) {
      this._process.kill('SIGKILL');
      this._process = undefined;
    }
    this._stateEmitter.dispose();
  }

  private _clearStartupTimer(): void {
    if (this._startupTimer) {
      clearTimeout(this._startupTimer);
      this._startupTimer = undefined;
    }
  }

  private _setState(newState: ServerState): void {
    this._info.state = newState;
    try {
      this._stateEmitter.fire(newState);
    } catch {
      // Never let listener errors propagate — they'd break the state machine
    }
  }

  private _resetInfo(): void {
    this._info.port = undefined;
    this._info.startTime = undefined;
    this._info.pid = undefined;
    this._info.lastError = undefined;
  }

  private _bufferOutput(text: string): void {
    const lines = text.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      this._outputBuffer.push(line);
      if (this._outputBuffer.length > OUTPUT_BUFFER_SIZE) {
        this._outputBuffer.shift();
      }
    }
  }

  private _pendingOutput = '';

  /**
   * Tries to extract the port from the config's `listen` field (e.g. "0.0.0.0:4873").
   * Returns 4873 as fallback.
   */
  private _parsePortFromConfig(): number {
    try {
      const configPath = this._configManager.getConfigPath();
      // Synchronous read to avoid async complexity inside setTimeout
      const fs = require('fs');
      const content = fs.readFileSync(configPath, 'utf-8');
      const match = content.match(/listen[:\s]+['"]?[^'"\s]*?:(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    } catch {
      // Config unreadable — use default
    }
    return 4873;
  }

  private _detectReady(text: string): void {
    if (this._info.state !== 'starting') {
      return;
    }

    try {
      // Accumulate text in case the ready message is split across data events
      this._pendingOutput += text;

      // Verdaccio pretty format: "warn --- http address - http://0.0.0.0:4873/ - verdaccio/x.x.x"
      // Verdaccio JSON format:   {"level":30,"msg":"http address - http://0.0.0.0:4873/", ...}
      const urlMatch = this._pendingOutput.match(/https?:\/\/[^:"\s]+:(\d+)/);
      if (urlMatch) {
        this._clearStartupTimer();
        this._info.port = parseInt(urlMatch[1], 10);
        this._info.startTime = new Date();
        this._setState('running');
        this._pendingOutput = '';
        return;
      }

      // Prevent unbounded accumulation — keep only the last 4KB
      if (this._pendingOutput.length > 4096) {
        this._pendingOutput = this._pendingOutput.slice(-2048);
      }
    } catch {
      // Never let regex or parsing errors prevent the timeout fallback
    }
  }
}
