import { spawn } from "node:child_process";
import { basename, dirname, join, win32 } from "node:path";

function windowsPathFromWsl(path: string, distro?: string): string {
  const mounted = path.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (mounted) return `${mounted[1].toUpperCase()}:\\${(mounted[2] || "").replace(/\//g, "\\")}`;
  if (distro && path.startsWith("/")) return `\\\\wsl.localhost\\${distro}${path.replace(/\//g, "\\")}`;
  return path;
}

function windowsCodeExecutable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.VSCODE_EXE) return env.VSCODE_EXE;
  const separator = platform === "win32" ? ";" : ":";
  const entry = (env.PATH || env.Path || "").split(separator).find((item) => /[\\/]microsoft vs code(?:[\\/]bin)?[\\/]?$/i.test(item));
  if (!entry) return "code.exe";
  if (platform === "win32") return win32.join(/[\\/]bin[\\/]?$/i.test(entry) ? win32.dirname(entry) : entry, "Code.exe");
  return join(/\/bin\/?$/i.test(entry) ? dirname(entry) : entry, "Code.exe");
}

export function directoryOpenCommand(
  path: string,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform === "win32") return { command: "explorer.exe", args: [path] };
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return { command: "explorer.exe", args: [windowsPathFromWsl(path, env.WSL_DISTRO_NAME)] };
  if (platform === "darwin") return { command: "open", args: [path] };
  return { command: "xdg-open", args: [path] };
}

export function terminalOpenCommand(
  path: string,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform === "win32") return { command: "wt.exe", args: ["-w", "0", "new-tab", "-d", path] };
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return {
    command: "wt.exe",
    args: ["-w", "0", "new-tab", "wsl.exe", ...(env.WSL_DISTRO_NAME ? ["-d", env.WSL_DISTRO_NAME] : []), "--cd", path],
  };
  if (platform === "darwin") return { command: "open", args: ["-a", "Terminal", path] };
  return { command: "x-terminal-emulator", args: ["--working-directory", path] };
}

export function codeOpenCommand(
  path: string,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform === "win32") return { command: windowsCodeExecutable(env, platform), args: ["--new-window", path] };
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return { command: windowsCodeExecutable(env, platform), args: ["--new-window", windowsPathFromWsl(path, env.WSL_DISTRO_NAME)] };
  return { command: "code", args: ["--new-window", path] };
}

export function zedOpenCommand(
  path: string,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (platform === "win32") return { command: "zed.exe", args: ["--existing", path] };
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return { command: "zed.exe", args: ["--existing", windowsPathFromWsl(path, env.WSL_DISTRO_NAME)] };
  return { command: "zed", args: ["--existing", path] };
}

export function gameClientOpenCommand(
  projectPath: string,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const clientBin = windowsPathFromWsl(join(projectPath, "client", "bin"), env.WSL_DISTRO_NAME);
  if (platform === "win32" || env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return { command: "cmd.exe", args: ["/c", `cd /d ${clientBin} && start game.exe`] };
  }
  return { command: "sh", args: ["-c", `cd ${JSON.stringify(join(projectPath, "client", "bin"))} && ./game.exe`] };
}

export function gameServerOpenCommand(
  projectPath: string,
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const serverDebug = windowsPathFromWsl(join(projectPath, "server", "debug"), env.WSL_DISTRO_NAME);
  if (platform === "win32" || env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    return {
      command: "wt.exe",
      args: ["-w", "0", "nt", "--title", "GameServer", "-d", serverDebug, "cmd.exe", "/k", "start /b game_unite && start /b game_charge"],
    };
  }
  return { command: "sh", args: ["-c", `cd ${JSON.stringify(join(projectPath, "server", "debug"))} && game_unite & game_charge`] };
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function workspaceName(path: string): string {
  return basename(path.replace(/\\/g, "/"));
}

function windowsCommandLineArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

export function maximizedWindowsOpenCommand(
  opener: { command: string; args: string[] },
  processName: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const name = powershellString(processName);
  const workspace = powershellString(workspaceName(path));
  const executable = powershellString(windowsPathFromWsl(opener.command, env.WSL_DISTRO_NAME));
  const arguments_ = powershellString(opener.args.map(windowsCommandLineArgument).join(" "));
  const script = [
    "$signature = '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);'",
    "Add-Type -MemberDefinition $signature -Name NativeWindow -Namespace OwnerConfig",
    `$before = @((Get-Process -Name ${name} -ErrorAction SilentlyContinue | Where-Object MainWindowHandle).MainWindowHandle)`,
    "$startInfo = New-Object System.Diagnostics.ProcessStartInfo",
    `$startInfo.FileName = ${executable}`,
    `$startInfo.Arguments = ${arguments_}`,
    "$startInfo.UseShellExecute = $true",
    "[System.Diagnostics.Process]::Start($startInfo) | Out-Null",
    "for ($attempt = 0; $attempt -lt 40; $attempt++) {",
    "  Start-Sleep -Milliseconds 100",
    `  $windows = @(Get-Process -Name ${name} -ErrorAction SilentlyContinue | Where-Object MainWindowHandle)`,
    "  $target = $windows | Where-Object { $before -notcontains $_.MainWindowHandle } | Select-Object -First 1",
    `  if (-not $target -and $attempt -ge 4) { $target = $windows | Where-Object { $_.MainWindowTitle.IndexOf(${workspace}, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1 }`,
    "  if ($target) { [OwnerConfig.NativeWindow]::ShowWindowAsync($target.MainWindowHandle, 3) | Out-Null; break }",
    "}",
  ].join("\n");
  return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script] };
}

async function launchDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => { child.unref(); resolve(); });
    child.once("error", reject);
  });
}

export async function openDirectory(path: string): Promise<void> {
  const { command, args } = directoryOpenCommand(path);
  await launchDetached(command, args);
}

export async function openTerminal(path: string): Promise<void> {
  const { command, args } = terminalOpenCommand(path);
  await launchDetached(command, args);
}

export async function openCode(path: string): Promise<void> {
  let opener = codeOpenCommand(path);
  if (process.platform === "win32" || process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    opener = maximizedWindowsOpenCommand(opener, "Code", path);
  }
  await launchDetached(opener.command, opener.args);
}

export async function openZed(path: string): Promise<void> {
  let opener = zedOpenCommand(path);
  if (process.platform === "win32" || process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    opener = maximizedWindowsOpenCommand(opener, "Zed", path);
  }
  await launchDetached(opener.command, opener.args);
}

export async function openGameClient(projectPath: string): Promise<void> {
  const opener = gameClientOpenCommand(projectPath);
  await launchDetached(opener.command, opener.args);
}

export async function openGameServer(projectPath: string): Promise<void> {
  const opener = gameServerOpenCommand(projectPath);
  await launchDetached(opener.command, opener.args);
}
