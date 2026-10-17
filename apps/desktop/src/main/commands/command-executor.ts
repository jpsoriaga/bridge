import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configService } from '../services/config.service';
import { isCommandAllowed } from './allowlist';

const execFileAsync = promisify(execFile);

export interface CommandExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  error?: string;
}

export class CommandExecutor {
  /**
   * Executes a strictly allowlisted command within the selected workspace directory.
   */
  async runAllowlistedCommand(
    executable: string,
    args: string[]
  ): Promise<CommandExecutionResult> {
    const workspace = configService.getSelectedWorkspace();
    if (!workspace) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        error: 'No active workspace directory selected.'
      };
    }

    if (!isCommandAllowed(executable, args)) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        error: `Command "${executable} ${args.join(' ')}" is not permitted by security allowlist.`
      };
    }

    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        cwd: workspace,
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 5 // 5MB limit
      });

      return {
        success: true,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      };
    } catch (err: unknown) {
      const errorObj = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        success: false,
        stdout: errorObj.stdout || '',
        stderr: errorObj.stderr || '',
        exitCode: errorObj.code,
        error: errorObj.message || 'Execution error'
      };
    }
  }
}

export const commandExecutor = new CommandExecutor();
