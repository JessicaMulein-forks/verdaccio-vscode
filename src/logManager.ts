import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';

export interface ILogManager extends vscode.Disposable {
  attach(process: ChildProcess): void;
  show(): void;
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Returns the numeric rank for a log level.
 * trace=0, debug=1, info=2, warn=3, error=4, fatal=5.
 * Returns -1 for unknown levels.
 */
export function logLevelRank(level: string): number {
  const idx = LOG_LEVELS.indexOf(level.toLowerCase() as LogLevel);
  return idx;
}

/**
 * Pure function: determines whether a log entry with the given severity
 * should be displayed given the configured threshold.
 *
 * Returns true if entrySeverity >= threshold in the ordering:
 * trace < debug < info < warn < error < fatal
 *
 * Unknown severity entries are always displayed.
 */
export function shouldDisplayLogEntry(entrySeverity: string, threshold: string): boolean {
  const entryRank = logLevelRank(entrySeverity);
  const thresholdRank = logLevelRank(threshold);

  // If threshold is unknown, display everything
  if (thresholdRank === -1) {
    return true;
  }

  // If entry severity is unknown, display it (don't suppress unrecognized lines)
  if (entryRank === -1) {
    return true;
  }

  return entryRank >= thresholdRank;
}

/**
 * Parses a log line to extract its severity level.
 * Verdaccio log lines typically contain severity keywords like:
 *   "warn --- http address ..."
 *   " info --- ..."
 *   "error--- ..."
 * Returns the detected level or undefined if none found.
 */
export function parseLogLevel(line: string): string | undefined {
  const lower = line.toLowerCase();
  // Match severity keywords as whole words
  for (let i = LOG_LEVELS.length - 1; i >= 0; i--) {
    const level = LOG_LEVELS[i];
    const regex = new RegExp(`\\b${level}\\b`);
    if (regex.test(lower)) {
      return level;
    }
  }
  return undefined;
}

export class LogManager implements ILogManager {
  private readonly _outputChannel: vscode.OutputChannel;
  private _attachedPid: number | undefined;

  constructor() {
    this._outputChannel = vscode.window.createOutputChannel('Verdaccio');
  }

  attach(process: ChildProcess): void {
    // Prevent duplicate listeners if called multiple times for the same process
    if (this._attachedPid === process.pid) {
      return;
    }
    this._attachedPid = process.pid;

    process.stdout?.on('data', (data: Buffer) => {
      this._processOutput(data.toString());
    });

    process.stderr?.on('data', (data: Buffer) => {
      this._processOutput(data.toString());
    });

    // Reset attached PID when process exits so we can attach to the next one
    process.on('close', () => {
      this._attachedPid = undefined;
    });
    process.on('exit', () => {
      this._attachedPid = undefined;
    });
  }

  show(): void {
    this._outputChannel.show();
  }

  getOutputChannel(): vscode.OutputChannel {
    return this._outputChannel;
  }

  dispose(): void {
    this._outputChannel.dispose();
  }

  private _getConfiguredLogLevel(): string {
    const config = vscode.workspace.getConfiguration('verdaccio');
    return config.get<string>('logLevel', 'info');
  }

  private _processOutput(text: string): void {
    const threshold = this._getConfiguredLogLevel();
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }

      const severity = parseLogLevel(line);
      if (severity === undefined || shouldDisplayLogEntry(severity, threshold)) {
        this._outputChannel.appendLine(line);
      }
    }
  }
}
