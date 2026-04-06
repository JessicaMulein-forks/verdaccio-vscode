import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import { ServerState, ServerInfo } from './types';
import { IConfigManager } from './configManager';

export interface IServerManager extends vscode.Disposable {
  readonly state: ServerState;
  readonly onDidChangeState: vscode.Event<ServerState>;
  readonly port: number | undefined;
  readonly startTime: Date | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

const OUTPUT_BUFFER_SIZE = 20;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;

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
    if (this._info.state === 'running' || this._info.state === 'starting') {
      vscode.window.showWarningMessage('Verdaccio server is already running.');
      return;
    }

    const configPath = this._configManager.getConfigPath();
    this._setState('starting');
    this._outputBuffer = [];

    return new Promise<void>((resolve, reject) => {
      try {
        const child = spawn('verdaccio', ['--config', configPath]);
        this._process = child;
        this._info.pid = child.pid;

        child.stdout?.on('data', (data: Buffer) => {
          this._bufferOutput(data.toString());
          this._detectReady(data.toString());
        });

        child.stderr?.on('data', (data: Buffer) => {
          this._bufferOutput(data.toString());
        });

        child.on('error', (err: Error) => {
          this._info.lastError = err.message;
          this._setState('error');
          vscode.window.showErrorMessage(
            `Verdaccio failed to start: ${err.message}`
          );
          reject(err);
        });

        child.on('close', (code: number | null) => {
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
          }
        });

        // Resolve after a short delay to allow error events to fire,
        // or resolve immediately if we detect the server is ready via stdout
        // The _detectReady method will transition to 'running' state
        // For now, resolve once the process is spawned successfully
        if (child.pid) {
          resolve();
        }
      } catch (err: any) {
        this._info.lastError = err.message;
        this._setState('error');
        reject(err);
      }
    });
  }

  async stop(): Promise<void> {
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
    if (this._process) {
      this._process.kill('SIGKILL');
      this._process = undefined;
    }
    this._stateEmitter.dispose();
  }

  private _setState(newState: ServerState): void {
    this._info.state = newState;
    this._stateEmitter.fire(newState);
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

  private _detectReady(text: string): void {
    // Verdaccio logs something like "http address - http://localhost:4873/"
    // or "warn --- http address - http://0.0.0.0:4873/ - verdaccio/x.x.x"
    const match = text.match(/http[s]?:\/\/[^:]+:(\d+)/);
    if (match && this._info.state === 'starting') {
      this._info.port = parseInt(match[1], 10);
      this._info.startTime = new Date();
      this._setState('running');
    }
  }
}
