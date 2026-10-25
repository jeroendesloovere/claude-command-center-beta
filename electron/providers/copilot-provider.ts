import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type { AppSettings } from '../types';
import type {
  CLIProvider,
  InteractiveCommandParams,
  ScheduledCommandParams,
  OneShotCommandParams,
  ProviderModel,
  HookConfig,
} from './cli-provider';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class CopilotProvider implements CLIProvider {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot';
  readonly binaryName = 'copilot';
  readonly configDir = path.join(os.homedir(), '.copilot');

  private getRegisteredUserMcpServerPath(name: string): string | null {
    try {
      const output = execSync(`copilot mcp get ${name}`, {
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 5000,
      });
      const argsLine = output
        .split('\n')
        .find((line) => line.trim().startsWith('Args:'));

      if (!argsLine) return null;
      const argsValue = argsLine.replace(/^\s*Args:\s*/, '').trim();
      return argsValue || null;
    } catch {
      return null;
    }
  }

  private getRegisteredFileMcpServerPath(name: string): string | null {
    const mcpConfigPath = path.join(this.configDir, 'mcp.json');
    if (!fs.existsSync(mcpConfigPath)) return null;

    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      const existing = mcpConfig?.mcpServers?.[name];
      if (!existing?.args?.length) return null;
      return existing.args[existing.args.length - 1];
    } catch {
      return null;
    }
  }

  getModels(): ProviderModel[] {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Latest GPT-4o model' },
      { id: 'o1', name: 'o1', description: 'Reasoning model' },
      { id: 'o1-mini', name: 'o1-mini', description: 'Fast reasoning' },
      { id: 'o3-mini', name: 'o3-mini', description: 'Code-optimized reasoning' },
    ];
  }

  resolveBinaryPath(appSettings: AppSettings): string {
    return appSettings.cliPaths?.copilot || 'copilot';
  }

  buildInteractiveCommand(params: InteractiveCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    // MCP config
    if (params.mcpConfigPath && fs.existsSync(params.mcpConfigPath)) {
      command += ` --mcp-config '${params.mcpConfigPath.replace(/'/g, "'\\''")}'`;
    }

    // System prompt file (Super Agent instructions)
    if (params.systemPromptFile && fs.existsSync(params.systemPromptFile)) {
      command += ` --system-prompt-file '${params.systemPromptFile.replace(/'/g, "'\\''")}'`;
    }

    // Model
    if (params.model) {
      if (!/^[a-zA-Z0-9._:\/\[\]-]+$/.test(params.model)) {
        throw new Error('Invalid model name');
      }
      command += ` --model '${params.model}'`;
    }

    // Verbose
    if (params.verbose) {
      command += ' --verbose';
    }

    // Skip permissions
    if (params.skipPermissions) {
      command += ' --skip-permissions';
    }

    // Secondary project
    if (params.secondaryProjectPath) {
      const escaped = params.secondaryProjectPath.replace(/'/g, "'\\''");
      command += ` --dir '${escaped}'`;
    }

    // Samins Command Center's CLAUDE.md via ~/.claude-command-center
    command += ` --dir '${os.homedir()}/.claude-command-center'`;

    // Prompt with skills directive
    let finalPrompt = params.prompt;
    if (params.skills && params.skills.length > 0 && !params.isSuperAgent) {
      const skillsList = params.skills.join(', ');
      finalPrompt = `[IMPORTANT: Use these skills for this session: ${skillsList}. Invoke them with /<skill-name> when relevant to the task.] ${params.prompt}`;
    }

    if (finalPrompt) {
      const escaped = finalPrompt.replace(/'/g, "'\\''");
      command += ` '${escaped}'`;
    }

    return command;
  }

  buildScheduledCommand(params: ScheduledCommandParams): string {
    let command = `"${params.binaryPath}"`;

    if (params.autonomous) {
      command += ' --skip-permissions';
    }

    if (params.outputFormat) {
      command += ` --output-format ${params.outputFormat}`;
    }

    if (params.verbose) {
      command += ' --verbose';
    }

    if (params.mcpConfigPath) {
      command += ` --mcp-config "${params.mcpConfigPath}"`;
    }

    command += ` --dir "${os.homedir()}/.claude-command-center"`;

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` -p '${escaped}'`;

    return command;
  }

  buildOneShotCommand(params: OneShotCommandParams): string {
    let command = `'${params.binaryPath.replace(/'/g, "'\\''")}'`;

    command += ' -p';

    if (params.model) {
      command += ` --model ${params.model}`;
    }

    const escaped = params.prompt.replace(/'/g, "'\\''");
    command += ` '${escaped}'`;

    return command;
  }

  getPtyEnvVars(agentId: string, projectPath: string, skills: string[]): Record<string, string> {
    return {
      COPILOT_SKILLS: skills.join(','),
      COPILOT_AGENT_ID: agentId,
      COPILOT_PROJECT_PATH: projectPath,
    };
  }

  getEnvVarsToDelete(): string[] {
    return ['GITHUB_COPILOT'];
  }

  getHookConfig(): HookConfig {
    return {
      supportsNativeHooks: true,
      configDir: this.configDir,
      settingsFile: path.join(this.configDir, 'settings.json'),
    };
  }

  async configureHooks(hooksDir: string): Promise<void> {
    const settingsPath = path.join(this.configDir, 'settings.json');

    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    let settings: {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
      [key: string]: unknown;
    } = {};

    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      } catch {
        settings = {};
      }
    }

    if (!settings.hooks) {
      settings.hooks = {};
    }

    const hookFiles = [
      { type: 'PostToolUse', file: 'post-tool-use.sh', matcher: '*' },
      { type: 'Stop', file: 'on-stop.sh', matcher: undefined },
      { type: 'SessionStart', file: 'session-start.sh', matcher: '*' },
      { type: 'SessionEnd', file: 'session-end.sh', matcher: '*' },
    ];

    let updated = false;

    type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };

    for (const { type, file, matcher } of hookFiles) {
      const hookPath = path.join(hooksDir, file);
      if (!fs.existsSync(hookPath)) continue;
      const commandPath = shellQuote(hookPath);

      const existing: HookEntry[] = settings.hooks![type] || [];
      const entryIndex = existing.findIndex((h: HookEntry) =>
        h.hooks?.some((hh: { command?: string }) => hh.command?.includes(file))
      );

      if (entryIndex >= 0) {
        const entry: HookEntry = existing[entryIndex];
        const hookIndex = entry.hooks.findIndex((hh: { command?: string }) => hh.command?.includes(file));
        if (hookIndex >= 0 && entry.hooks[hookIndex].command !== commandPath) {
          entry.hooks[hookIndex].command = commandPath;
          updated = true;
        }
      } else {
        const hookConfig: { matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> } = {
          hooks: [{ type: 'command', command: commandPath, timeout: 30 }]
        };
        if (matcher) hookConfig.matcher = matcher;
        settings.hooks![type] = [...existing, hookConfig];
        updated = true;
      }
    }

    if (updated) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log('Copilot hooks configured/updated in', settingsPath);
    } else {
      console.log('Copilot hooks already configured');
    }
  }

  async registerMcpServer(name: string, command: string, args: string[]): Promise<void> {
    const expectedServerPath = args[args.length - 1];
    const registeredUserPath = this.getRegisteredUserMcpServerPath(name);

    if (registeredUserPath && registeredUserPath !== expectedServerPath) {
      try {
        execSync(`copilot mcp remove -s user ${name}`, {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5000,
        });
        console.log(`[copilot] Removed stale user-scoped MCP server ${name} at ${registeredUserPath}`);
      } catch (err) {
        console.warn(`[copilot] Failed to remove stale user-scoped MCP server ${name}:`, err);
      }
    }

    // Try copilot mcp add -s user first
    try {
      const argsStr = args.map(a => `"${a}"`).join(' ');
      execSync(`copilot mcp add -s user ${name} ${command} ${argsStr}`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      console.log(`[copilot] Registered MCP server ${name} via copilot mcp add`);
      return;
    } catch {
      // Fallback: write to mcp.json
    }

    const mcpConfigPath = path.join(this.configDir, 'mcp.json');
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    let mcpConfig: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };
    if (fs.existsSync(mcpConfigPath)) {
      try {
        mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
        if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      } catch {
        mcpConfig = { mcpServers: {} };
      }
    }

    mcpConfig.mcpServers![name] = { command, args };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
    console.log(`[copilot] Registered MCP server ${name} via mcp.json fallback`);
  }

  async removeMcpServer(name: string): Promise<void> {
    // Try copilot mcp remove -s user
    try {
      execSync(`copilot mcp remove -s user ${name} 2>&1`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch {
      // Ignore if doesn't exist
    }

    // Also clean mcp.json
    const mcpConfigPath = path.join(this.configDir, 'mcp.json');
    if (fs.existsSync(mcpConfigPath)) {
      try {
        const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
        if (mcpConfig?.mcpServers?.[name]) {
          delete mcpConfig.mcpServers[name];
          fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  isMcpServerRegistered(name: string, expectedServerPath: string): boolean {
    const registeredUserPath = this.getRegisteredUserMcpServerPath(name);
    if (registeredUserPath !== null) {
      return registeredUserPath === expectedServerPath;
    }

    const registeredFilePath = this.getRegisteredFileMcpServerPath(name);
    return registeredFilePath === expectedServerPath;
  }

  getMcpConfigStrategy(): 'flag' | 'config-file' {
    return 'flag';
  }

  getSkillDirectories(): string[] {
    return [
      path.join(this.configDir, 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
    ];
  }

  getInstalledSkills(): string[] {
    const skills = new Set<string>();

    for (const dir of this.getSkillDirectories()) {
      if (fs.existsSync(dir)) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              skills.add(entry.name);
            }
          }
        } catch {
          // Ignore read errors
        }
      }
    }

    const settingsPath = path.join(this.configDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.enabledPlugins) {
          for (const key of Object.keys(settings.enabledPlugins)) {
            if (settings.enabledPlugins[key]) {
              skills.add(key.split('@')[0]);
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return Array.from(skills);
  }

  supportsSkills(): boolean {
    return true;
  }

  getMemoryBasePath(): string {
    return path.join(this.configDir, 'projects');
  }

  getAddDirFlag(): string {
    return '--dir';
  }

  buildScheduledScript(params: {
    binaryPath: string;
    binaryDir: string;
    projectPath: string;
    prompt: string;
    autonomous: boolean;
    mcpConfigPath: string;
    logPath: string;
    homeDir: string;
  }): string {
    const flags = params.autonomous ? '--skip-permissions' : '';

    return `#!/bin/bash

# Source shell profile for proper PATH (nvm, homebrew, etc.)
export HOME="${params.homeDir}"

if [ -s "${params.homeDir}/.nvm/nvm.sh" ]; then
  source "${params.homeDir}/.nvm/nvm.sh" 2>/dev/null || true
fi

if [ -f "${params.homeDir}/.bashrc" ]; then
  source "${params.homeDir}/.bashrc" 2>/dev/null || true
elif [ -f "${params.homeDir}/.bash_profile" ]; then
  source "${params.homeDir}/.bash_profile" 2>/dev/null || true
elif [ -f "${params.homeDir}/.zshrc" ]; then
  source "${params.homeDir}/.zshrc" 2>/dev/null || true
fi

export PATH="${params.binaryDir}:$PATH"
cd "${params.projectPath}"
echo "=== Task started at $(date) ===" >> "${params.logPath}"
unset GITHUB_COPILOT
COPILOT_PROJECT_PATH_CLAUDE_MD=1 "${params.binaryPath}" ${flags} --output-format stream-json --verbose --mcp-config "${params.mcpConfigPath}" --dir "${params.homeDir}/.claude-command-center" -p '${params.prompt}' >> "${params.logPath}" 2>&1
echo "=== Task completed at $(date) ===" >> "${params.logPath}"
`;
  }
}