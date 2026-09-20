import { access, copyFile, mkdir, readFile, readdir, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename as pathBasename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { isExternalOperationTimeout, withExternalOperationTimeout } from "./external.js";
import { validateJenkinsToken } from "./jenkins.js";
import { mergeConfigFile, previewConfigFile, readConfigFile } from "./merge.js";
import type { ComposeDeployment, ComposeOperation, ConfigFileView, ConfigSummary, GlobalSettings, JenkinsCredentials, NewProject, Operation, ProjectConfig, Scalar } from "./types.js";

export type CommandRunner = (command: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }>;

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

async function assertTreeCompatible(source: string, target: string): Promise<void> {
  if (!await exists(target)) return;
  const [sourceStat, targetStat] = await Promise.all([stat(source), stat(target)]);
  if (sourceStat.isDirectory() !== targetStat.isDirectory()) throw new Error(`migration target has a different type: ${target}`);
  if (sourceStat.isDirectory()) {
    for (const entry of await readdir(source)) await assertTreeCompatible(join(source, entry), join(target, entry));
  } else if (!Buffer.from(await readFile(source)).equals(Buffer.from(await readFile(target)))) {
    throw new Error(`migration would overwrite different data: ${target}`);
  }
}

async function moveTreeUnchecked(source: string, target: string): Promise<void> {
  if (!await exists(source)) return;
  const sourceStat = await stat(source);
  if (sourceStat.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source)) await moveTreeUnchecked(join(source, entry), join(target, entry));
    await rmdir(source);
    return;
  }
  if (await exists(target)) {
    if (!(await stat(target)).isFile() || !Buffer.from(await readFile(source)).equals(Buffer.from(await readFile(target)))) {
      throw new Error(`migration would overwrite different data: ${target}`);
    }
  } else {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    if (!Buffer.from(await readFile(source)).equals(Buffer.from(await readFile(target)))) throw new Error(`failed to verify migrated file: ${target}`);
  }
  await unlink(source);
}

async function moveTree(source: string, target: string): Promise<void> {
  if (!await exists(source)) return;
  await assertTreeCompatible(source, target);
  await moveTreeUnchecked(source, target);
}

interface EnvironmentConfig {
  current: string;
  options: string[];
}

function projectConfigPath(ownerRoot: string): string {
  return join(ownerRoot, "data/projects.yaml");
}

export async function loadProjects(ownerRoot: string): Promise<ProjectConfig[]> {
  const raw = parse(await readFile(projectConfigPath(ownerRoot), "utf8")) as { projects?: unknown[] };
  if (!raw || !Array.isArray(raw.projects)) throw new Error("projects.yaml must contain a projects list");
  const ids = new Set<number>();
  return raw.projects.map((item) => {
    const project = item as Record<string, unknown>;
    if (typeof project.id !== "number" || !Number.isSafeInteger(project.id) || project.id <= 0) throw new Error("project id must be a positive integer");
    if (typeof project.name !== "string" || !project.name.trim()) throw new Error(`project ${project.id} name must be non-empty`);
    if (ids.has(project.id)) throw new Error(`duplicate project id: ${project.id}`);
    ids.add(project.id);
    if (typeof project.conf_dir !== "string" || !Array.isArray(project.files)) throw new Error(`invalid project: ${project.name}`);
    if (project.compose_file !== undefined && (typeof project.compose_file !== "string" || !project.compose_file.trim())) throw new Error(`project ${project.id} compose_file must be a non-empty string`);
    if (project.jenkins_job_url !== undefined && (typeof project.jenkins_job_url !== "string" || !project.jenkins_job_url.trim())) throw new Error(`project ${project.id} jenkins_job_url must be a non-empty string`);
    if (project.tags !== undefined && (!Array.isArray(project.tags) || project.tags.some((tag) => typeof tag !== "string" || !tag.trim()))) throw new Error(`project ${project.id} tags must be non-empty strings`);
    return {
      id: project.id,
      name: project.name,
      confDir: project.conf_dir,
      ...(project.compose_file ? { composeFile: project.compose_file } : {}),
      ...(project.jenkins_job_url ? { jenkinsJobUrl: project.jenkins_job_url } : {}),
      files: project.files.map(String),
      tags: [...new Set((project.tags ?? []).map((tag) => String(tag).trim()))],
    };
  });
}

function normalizeProjectInput(input: NewProject): NewProject {
  const composeFile = input.composeFile?.trim();
  const jenkinsJobUrl = input.jenkinsJobUrl?.trim();
  const project: NewProject = {
    name: input.name.trim(),
    confDir: input.confDir.trim(),
    ...(composeFile ? { composeFile } : {}),
    ...(jenkinsJobUrl ? { jenkinsJobUrl } : {}),
    files: [...new Set(input.files.map((file) => file.trim()))],
    tags: [...new Set(input.tags.map((tag) => tag.trim()))],
  };
  if (!project.name || !project.confDir) throw new Error("project name and config directory are required");
  if (project.jenkinsJobUrl) {
    let url: URL;
    try { url = new URL(project.jenkinsJobUrl); } catch { throw new Error("Jenkins job URL must be a valid URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.split("/").includes("job")) throw new Error("Jenkins job URL must be an HTTP(S) Jenkins job URL without credentials, query, or fragment");
    project.jenkinsJobUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}/`;
  }
  if (project.files.some((file) => !file || file.startsWith("/") || file.split("/").includes(".."))) throw new Error("project files must be safe relative paths");
  if (project.tags.some((tag) => !tag)) throw new Error("tags must be non-empty strings");
  return project;
}

export function projectDataName(project: Pick<ProjectConfig, "id" | "name">): string {
  const safeName = project.name.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "project";
  return `${safeName}--${project.id}`;
}

function projectDataDir(ownerRoot: string, project: Pick<ProjectConfig, "id" | "name">): string {
  return join(ownerRoot, "data/projects", projectDataName(project));
}

function baseline(ownerRoot: string, project: ProjectConfig, file: string): string {
  return join(projectDataDir(ownerRoot, project), "baseline", file);
}

function localEnvironment(ownerRoot: string, project: Pick<ProjectConfig, "id" | "name">, environment: string): string {
  return join(projectDataDir(ownerRoot, project), "local", environment);
}

export async function createProject(ownerRoot: string, input: NewProject): Promise<number> {
  const project = normalizeProjectInput(input);
  await validateProjectDirectory(ownerRoot, project);
  const existing = await loadProjects(ownerRoot);
  const id = Math.max(0, ...existing.map((item) => item.id)) + 1;
  const path = projectConfigPath(ownerRoot);
  const raw = parse(await readFile(path, "utf8")) as { projects: Array<Record<string, unknown>> };
  raw.projects.push({ id, name: project.name, tags: project.tags, conf_dir: project.confDir, ...(project.composeFile ? { compose_file: project.composeFile } : {}), ...(project.jenkinsJobUrl ? { jenkins_job_url: project.jenkinsJobUrl } : {}), files: project.files });
  await writeFile(path, stringify(raw));
  await ensureProjectLayout(ownerRoot, { id, ...project }, await appEnv(ownerRoot));
  return id;
}

export async function updateProject(ownerRoot: string, id: number, input: NewProject): Promise<ProjectConfig> {
  const project = normalizeProjectInput(input);
  const existing = (await loadProjects(ownerRoot)).find((item) => item.id === id);
  if (!existing) throw new Error(`unknown project id: ${id}`);
  await validateProjectDirectory(ownerRoot, project);
  const path = projectConfigPath(ownerRoot);
  const raw = parse(await readFile(path, "utf8")) as { projects: Array<Record<string, unknown>> };
  const index = raw.projects.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`unknown project id: ${id}`);
  const nextProject = { id, ...project };
  const sourceData = projectDataDir(ownerRoot, existing);
  const targetData = projectDataDir(ownerRoot, nextProject);
  const moveData = sourceData !== targetData && await exists(sourceData);
  if (moveData) await moveTree(sourceData, targetData);
  raw.projects[index] = { id, name: project.name, tags: project.tags, conf_dir: project.confDir, ...(project.composeFile ? { compose_file: project.composeFile } : {}), ...(project.jenkinsJobUrl ? { jenkins_job_url: project.jenkinsJobUrl } : {}), files: project.files };
  try { await writeFile(path, stringify(raw)); }
  catch (error) { if (moveData) await moveTree(targetData, sourceData); throw error; }
  await ensureProjectLayout(ownerRoot, nextProject, await appEnv(ownerRoot));
  return nextProject;
}

export async function deleteProject(ownerRoot: string, id: number): Promise<void> {
  await deleteProjects(ownerRoot, [id]);
}

export async function updateProjectPin(ownerRoot: string, id: number, pinned: boolean): Promise<void> {
  if (!(await loadProjects(ownerRoot)).some((project) => project.id === id)) throw new Error(`unknown project id: ${id}`);
  const pinnedIds = await readPinnedProjects(ownerRoot);
  if (pinned) pinnedIds.add(id);
  else pinnedIds.delete(id);
  await writePinnedProjects(ownerRoot, pinnedIds);
}

export async function deleteProjects(ownerRoot: string, ids: number[]): Promise<void> {
  const projects = selectProjects(await loadProjects(ownerRoot), ids);
  const selectedIds = new Set(ids);
  const path = projectConfigPath(ownerRoot);
  const raw = parse(await readFile(path, "utf8")) as { projects: Array<Record<string, unknown>> };
  raw.projects = raw.projects.filter((project) => !selectedIds.has(project.id as number));
  await writeFile(path, stringify(raw));
  await Promise.all(projects.flatMap((project) => [
    rm(projectDataDir(ownerRoot, project), { recursive: true, force: true }),
    rm(join(ownerRoot, "data/baseline", String(project.id)), { recursive: true, force: true }),
    rm(join(ownerRoot, "data/local", String(project.id)), { recursive: true, force: true }),
  ]));
  const lockedIds = await readLock(ownerRoot);
  ids.forEach((id) => lockedIds.delete(id));
  await writeLock(ownerRoot, lockedIds);
  const pinnedIds = await readPinnedProjects(ownerRoot);
  ids.forEach((id) => pinnedIds.delete(id));
  await writePinnedProjects(ownerRoot, pinnedIds);
}

export function selectProjects(projects: ProjectConfig[], ids: number[]): ProjectConfig[] {
  const selected = projects.filter((project) => ids.includes(project.id));
  if (!ids.length || new Set(ids).size !== ids.length || selected.length !== ids.length) throw new Error(`unknown project ids: ${ids.join(", ")}`);
  return selected;
}

function targetDir(ownerRoot: string, project: ProjectConfig): string {
  return codeDirectory(ownerRoot, project.confDir);
}

function codeDirectory(ownerRoot: string, value: string): string {
  const codeRoot = dirname(ownerRoot);
  return isAbsolute(value) ? value : join(codeRoot, value);
}

export async function getProjectDirectory(ownerRoot: string, id: number, childDirectory = ""): Promise<string> {
  const project = (await loadProjects(ownerRoot)).find((item) => item.id === id);
  if (!project) throw new Error(`unknown project id: ${id}`);
  const child = childDirectory.trim();
  if (child && (child === "." || child === ".." || child.includes("/") || child.includes("\\"))) throw new Error("invalid project child directory");
  const path = child ? join(targetDir(ownerRoot, project), child) : targetDir(ownerRoot, project);
  if (!await exists(path) || !(await stat(path)).isDirectory()) throw new Error(`project directory does not exist: ${path}`);
  return path;
}

export async function listCodeDirectories(ownerRoot: string, value = ""): Promise<{ path: string; parent: string | null; directories: Array<{ name: string; path: string }>; files: Array<{ name: string; path: string }> }> {
  const segments = value.trim().replace(/\\/g, "/").split("/").filter(Boolean);
  if (isAbsolute(value) || segments.some((segment) => segment === "." || segment === "..")) throw new Error("invalid directory path");
  const codeRoot = dirname(ownerRoot);
  const target = resolve(codeRoot, ...segments);
  const fromRoot = relative(codeRoot, target);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("directory path is outside code root");
  if (!await exists(target) || !(await stat(target)).isDirectory()) throw new Error(`directory does not exist: ${target}`);
  const path = segments.join("/");
  const entries = await readdir(target, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: [...segments, entry.name].join("/") }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, path: [...segments, entry.name].join("/") }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { path, parent: segments.length ? segments.slice(0, -1).join("/") : null, directories, files };
}

async function validateProjectDirectory(ownerRoot: string, project: NewProject): Promise<void> {
  const path = targetDir(ownerRoot, { id: 0, ...project });
  if (!await exists(path) || !(await stat(path)).isDirectory()) throw new Error(`project directory does not exist: ${path}`);
  if (project.composeFile) {
    const composePath = codeDirectory(ownerRoot, project.composeFile);
    if (!await exists(composePath) || !(await stat(composePath)).isFile()) throw new Error(`compose file does not exist: ${composePath}`);
  }
}

export function composeCommandArgs(operation: ComposeOperation | "logs" | "services" | "running", file: string, service?: string, tail = 200): string[] {
  const prefix = ["compose", "-f", file];
  if (operation === "services") return [...prefix, "config", "--services"];
  if (operation === "running") return [...prefix, "ps", "--format", "json", "--status", "running"];
  if (operation === "up") return [...prefix, "up", "-d", ...(service ? [service] : [])];
  if (operation === "down") return service ? [...prefix, "stop", service] : [...prefix, "down"];
  if (operation === "logs") return ["compose", "--ansi", "always", "-f", file, "logs", "-f", "-n", String(tail), ...(service ? [service] : [])];
  return [...prefix, "restart", ...(service ? [service] : [])];
}

async function getComposePath(ownerRoot: string, id: number): Promise<string> {
  const project = (await loadProjects(ownerRoot)).find((item) => item.id === id);
  if (!project) throw new Error(`unknown project id: ${id}`);
  if (!project.composeFile) throw new Error(`project ${id} does not configure a compose file`);
  const path = codeDirectory(ownerRoot, project.composeFile);
  if (!await exists(path) || !(await stat(path)).isFile()) throw new Error(`compose file does not exist: ${path}`);
  return path;
}

const executeCommand: CommandRunner = (command, args, cwd, parentSignal) => {
  const run = (signal: AbortSignal) => new Promise<{ stdout: string; stderr: string }>((resolveCommand, rejectCommand) => {
    execFile(command, args, { cwd, encoding: "utf8", signal }, (error, stdout, stderr) => {
      if (error) return rejectCommand(new Error(stderr.trim() || error.message));
      resolveCommand({ stdout, stderr });
    });
  });
  return parentSignal
    ? run(parentSignal)
    : withExternalOperationTimeout(`${command} ${args.join(" ")}`, run);
};

async function composeContext(ownerRoot: string, id: number): Promise<{ file: string; cwd: string }> {
  const path = await getComposePath(ownerRoot, id);
  return { file: pathBasename(path), cwd: dirname(path) };
}

function outputLines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

interface ComposePsEntry {
  Service?: unknown;
  Publishers?: unknown;
}

interface ComposePsPublisher {
  URL?: unknown;
  TargetPort?: unknown;
  PublishedPort?: unknown;
  Protocol?: unknown;
}

function parseComposePs(output: string): Map<string, ComposeDeployment["services"][number]["ports"]> {
  const text = output.trim();
  let parsed: unknown[];
  if (!text) parsed = [];
  else {
    try {
      const value = JSON.parse(text) as unknown;
      parsed = Array.isArray(value) ? value : [value];
    } catch {
      parsed = outputLines(text).map((line) => JSON.parse(line) as unknown);
    }
  }
  const services = new Map<string, ComposeDeployment["services"][number]["ports"]>();
  for (const rawEntry of parsed) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const entry = rawEntry as ComposePsEntry;
    if (typeof entry.Service !== "string" || !entry.Service) continue;
    const ports = services.get(entry.Service) || [];
    if (Array.isArray(entry.Publishers)) for (const rawPublisher of entry.Publishers) {
      if (!rawPublisher || typeof rawPublisher !== "object") continue;
      const publisher = rawPublisher as ComposePsPublisher;
      if (typeof publisher.TargetPort !== "number") continue;
      const port = {
        hostIp: typeof publisher.URL === "string" ? publisher.URL : "",
        publishedPort: typeof publisher.PublishedPort === "number" ? publisher.PublishedPort : 0,
        targetPort: publisher.TargetPort,
        protocol: typeof publisher.Protocol === "string" ? publisher.Protocol : "tcp",
      };
      if (!ports.some((item) => JSON.stringify(item) === JSON.stringify(port))) ports.push(port);
    }
    services.set(entry.Service, ports);
  }
  return services;
}

export async function getComposeDeployment(ownerRoot: string, id: number, runner: CommandRunner = executeCommand, signal?: AbortSignal): Promise<ComposeDeployment> {
  const { file, cwd } = await composeContext(ownerRoot, id);
  try {
    const [configured, running] = await Promise.all([
      runner("docker", composeCommandArgs("services", file), cwd, signal),
      runner("docker", composeCommandArgs("running", file), cwd, signal),
    ]);
    const runningServices = parseComposePs(running.stdout);
    const services = outputLines(configured.stdout).sort().map((name) => ({
      name,
      status: runningServices.has(name) ? "running" as const : "stopped" as const,
      ports: runningServices.get(name) || [],
    }));
    return { status: services.some((service) => service.status === "running") ? "running" : "stopped", services };
  } catch (error) {
    if (isExternalOperationTimeout(error)) throw error;
    throw new Error(`failed to inspect compose deployment for project ${id}: ${(error as Error).message}`);
  }
}

export async function runComposeOperation(ownerRoot: string, id: number, operation: ComposeOperation, runner: CommandRunner = executeCommand, service?: string, signal?: AbortSignal): Promise<string[]> {
  const { file, cwd } = await composeContext(ownerRoot, id);
  try {
    if (service) {
      const configured = await runner("docker", composeCommandArgs("services", file), cwd, signal);
      if (!outputLines(configured.stdout).includes(service)) throw new Error(`unknown compose service: ${service}`);
    }
    const result = await runner("docker", composeCommandArgs(operation, file, service), cwd, signal);
    return [result.stdout.trim(), result.stderr.trim()].filter(Boolean);
  } catch (error) {
    if (isExternalOperationTimeout(error)) throw error;
    throw new Error(`compose ${operation} failed for project ${id}${service ? ` service ${service}` : ""}: ${(error as Error).message}`);
  }
}

export async function spawnComposeLogs(ownerRoot: string, id: number, service?: string, tail = 200): Promise<ChildProcessWithoutNullStreams> {
  const { file, cwd } = await composeContext(ownerRoot, id);
  return spawn("docker", composeCommandArgs("logs", file, service, tail), { cwd, stdio: "pipe" });
}

async function targetFile(ownerRoot: string, project: ProjectConfig, file: string): Promise<string> {
  const base = targetDir(ownerRoot, project);
  const conf = join(base, "conf");
  return join(await exists(conf) && (await stat(conf)).isDirectory() ? conf : base, file);
}

async function projectUpdatedAt(ownerRoot: string, project: ProjectConfig): Promise<string | null> {
  const modifiedTimes = await Promise.all(project.files.map(async (file) => {
    try { return (await stat(await targetFile(ownerRoot, project, file))).mtimeMs; }
    catch { return 0; }
  }));
  const latest = Math.max(0, ...modifiedTimes);
  return latest ? new Date(latest).toISOString() : null;
}

export async function loadVariables(ownerRoot: string): Promise<Record<string, Scalar>> {
  const path = join(ownerRoot, "data/variables.yaml");
  if (!await exists(path)) return {};
  const raw = parse(await readFile(path, "utf8")) ?? {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`variables file must be a mapping: ${path}`);
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || !["string", "number", "boolean"].includes(typeof value)) throw new Error(`variable ${key} must be a scalar value`);
  }
  return raw as Record<string, Scalar>;
}

function normalizeEnvironment(environment: string): string {
  const normalized = environment.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalized)) throw new Error("environment must contain only letters, numbers, underscores, and hyphens");
  return normalized;
}

async function readEnvironmentConfig(ownerRoot: string): Promise<EnvironmentConfig> {
  const raw = parse(await readFile(projectConfigPath(ownerRoot), "utf8")) as { env?: { current?: unknown; options?: unknown } };
  if (!raw.env || typeof raw.env.current !== "string" || !Array.isArray(raw.env.options) || raw.env.options.some((item) => typeof item !== "string")) {
    throw new Error("projects.yaml env must contain current and options");
  }
  const current = normalizeEnvironment(raw.env.current);
  const options = [...new Set(raw.env.options.map((item) => normalizeEnvironment(item as string)))];
  if (!options.includes(current)) throw new Error(`current environment is not listed in options: ${current}`);
  return { current, options };
}

async function writeEnvironmentConfig(ownerRoot: string, config: EnvironmentConfig): Promise<void> {
  const path = projectConfigPath(ownerRoot);
  const raw = parse(await readFile(path, "utf8")) as Record<string, unknown>;
  raw.env = { current: config.current, options: config.options };
  await writeFile(path, stringify(raw));
}

async function appEnv(ownerRoot: string): Promise<string> {
  return (await readEnvironmentConfig(ownerRoot)).current;
}

export async function getGlobalSettings(ownerRoot: string): Promise<GlobalSettings> {
  const env = await readEnvironmentConfig(ownerRoot);
  const credentials = await getJenkinsCredentials(ownerRoot);
  return { environment: env.current, environments: env.options, variables: await loadVariables(ownerRoot), jenkins: { username: credentials.username, tokenConfigured: Boolean(credentials.token) } };
}

export async function getJenkinsCredentials(ownerRoot: string): Promise<JenkinsCredentials> {
  const path = join(ownerRoot, "data/jenkins.yaml");
  if (!await exists(path)) return { username: "", token: "" };
  const raw = parse(await readFile(path, "utf8")) ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Jenkins settings file must be a mapping: ${path}`);
  const value = raw as Record<string, unknown>;
  if ((value.username !== undefined && typeof value.username !== "string") || (value.token !== undefined && typeof value.token !== "string")) throw new Error("Jenkins username and token must be strings");
  return { username: (value.username as string | undefined) || "", token: (value.token as string | undefined) || "" };
}

export async function updateGlobalSettings(ownerRoot: string, environment: string, variables: Record<string, Scalar>, jenkins?: { username?: string; token?: string; clearToken?: boolean }): Promise<GlobalSettings> {
  const normalizedEnvironment = normalizeEnvironment(environment);
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new Error("variables must be a mapping");
  for (const [key, value] of Object.entries(variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid variable name: ${key}`);
    if (value === null || !["string", "number", "boolean"].includes(typeof value)) throw new Error(`variable ${key} must be a scalar value`);
  }
  if (jenkins) {
    if (jenkins.username !== undefined && typeof jenkins.username !== "string") throw new Error("Jenkins username must be a string");
    if (jenkins.token !== undefined && typeof jenkins.token !== "string") throw new Error("Jenkins token must be a string");
    validateJenkinsToken(jenkins.token?.trim() || "");
  }
  const env = await readEnvironmentConfig(ownerRoot);
  if (!env.options.includes(normalizedEnvironment)) throw new Error(`unknown environment: ${normalizedEnvironment}`);
  await writeEnvironmentConfig(ownerRoot, { ...env, current: normalizedEnvironment });
  await mkdir(join(ownerRoot, "data"), { recursive: true });
  await writeFile(join(ownerRoot, "data/variables.yaml"), stringify(variables, { lineWidth: 0 }));
  if (jenkins) {
    const current = await getJenkinsCredentials(ownerRoot);
    const credentials = {
      username: jenkins.username?.trim() ?? current.username,
      token: jenkins.clearToken ? "" : jenkins.token?.trim() || current.token,
    };
    await writeFile(join(ownerRoot, "data/jenkins.yaml"), stringify(credentials, { lineWidth: 0 }), { mode: 0o600 });
  }
  return getGlobalSettings(ownerRoot);
}

export async function createEnvironment(ownerRoot: string, environment: string): Promise<GlobalSettings> {
  const name = normalizeEnvironment(environment);
  const env = await readEnvironmentConfig(ownerRoot);
  if (env.options.includes(name)) throw new Error(`environment already exists: ${name}`);
  for (const project of await loadProjects(ownerRoot)) await ensureProjectLayout(ownerRoot, project, name);
  await writeEnvironmentConfig(ownerRoot, { ...env, options: [...env.options, name].sort() });
  return getGlobalSettings(ownerRoot);
}

export async function renameEnvironment(ownerRoot: string, environment: string, nextEnvironment: string): Promise<GlobalSettings> {
  const name = normalizeEnvironment(environment);
  const nextName = normalizeEnvironment(nextEnvironment);
  if (name === "dev") throw new Error("dev environment cannot be renamed");
  const env = await readEnvironmentConfig(ownerRoot);
  if (!env.options.includes(name)) throw new Error(`unknown environment: ${name}`);
  if (env.options.includes(nextName)) throw new Error(`environment already exists: ${nextName}`);
  for (const project of await loadProjects(ownerRoot)) {
    const source = localEnvironment(ownerRoot, project, name);
    if (await exists(source)) await moveTree(source, localEnvironment(ownerRoot, project, nextName));
  }
  await writeEnvironmentConfig(ownerRoot, {
    current: env.current === name ? nextName : env.current,
    options: env.options.map((item) => item === name ? nextName : item).sort(),
  });
  return getGlobalSettings(ownerRoot);
}

export async function deleteEnvironment(ownerRoot: string, environment: string): Promise<GlobalSettings> {
  const name = normalizeEnvironment(environment);
  if (name === "dev") throw new Error("dev environment cannot be deleted");
  const env = await readEnvironmentConfig(ownerRoot);
  if (!env.options.includes(name)) throw new Error(`unknown environment: ${name}`);
  for (const project of await loadProjects(ownerRoot)) await rm(localEnvironment(ownerRoot, project, name), { recursive: true, force: true });
  await writeEnvironmentConfig(ownerRoot, {
    current: env.current === name ? "dev" : env.current,
    options: env.options.filter((item) => item !== name),
  });
  return getGlobalSettings(ownerRoot);
}

export async function getProjectConfigs(ownerRoot: string, id: number): Promise<ConfigFileView[]> {
  const project = (await loadProjects(ownerRoot)).find((item) => item.id === id);
  if (!project) throw new Error(`unknown project id: ${id}`);
  const env = await appEnv(ownerRoot);
  const variables = await loadVariables(ownerRoot);
  return Promise.all(project.files.map(async (name) => {
    const baselinePath = baseline(ownerRoot, project, name);
    const localPath = join(localEnvironment(ownerRoot, project, env), name);
    const baselineText = await readConfigFile(baselinePath);
    if (!await exists(localPath)) return { name, baseline: baselineText, local: null, merged: baselineText };
    return {
      name,
      baseline: baselineText,
      local: await readConfigFile(localPath),
      merged: await previewConfigFile(baselinePath, localPath, variables),
    };
  }));
}

async function readLock(ownerRoot: string): Promise<Set<number>> {
  const path = join(ownerRoot, "state/apply.lock");
  if (!await exists(path)) return new Set();
  try {
    const value = parse(await readFile(path, "utf8")) as { project_ids?: unknown };
    if (Array.isArray(value?.project_ids)) return new Set(value.project_ids.filter((id): id is number => typeof id === "number"));
  } catch {}
  return new Set((await loadProjects(ownerRoot)).map((project) => project.id));
}

async function writeLock(ownerRoot: string, ids: Set<number>): Promise<void> {
  const path = join(ownerRoot, "state/apply.lock");
  if (!ids.size) { try { await unlink(path); } catch {} return; }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify({ locked_at: new Date().toISOString(), project_ids: [...ids].sort((a, b) => a - b) }));
}

async function readPinnedProjects(ownerRoot: string): Promise<Set<number>> {
  const path = join(ownerRoot, "state/project-pins.yaml");
  if (!await exists(path)) return new Set();
  try {
    const value = parse(await readFile(path, "utf8")) as { project_ids?: unknown };
    if (!Array.isArray(value?.project_ids)) return new Set();
    return new Set(value.project_ids.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0));
  } catch {
    return new Set();
  }
}

async function writePinnedProjects(ownerRoot: string, ids: Set<number>): Promise<void> {
  const path = join(ownerRoot, "state/project-pins.yaml");
  if (!ids.size) { try { await unlink(path); } catch {} return; }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify({ project_ids: [...ids].sort((a, b) => a - b) }));
}

export async function runOperation(ownerRoot: string, operation: Operation, ids: number[]): Promise<string[]> {
  const projects = selectProjects(await loadProjects(ownerRoot), ids);
  const lockedIds = await readLock(ownerRoot);
  const lockedTargets = projects.filter((project) => lockedIds.has(project.id));
  if (operation === "sync" && lockedTargets.length) throw new Error(`selected projects are applied: ${lockedTargets.map((project) => project.id).join(", ")}`);
  const output: string[] = [];
  const env = operation === "apply" ? await appEnv(ownerRoot) : "dev";
  const variables = operation === "apply" ? await loadVariables(ownerRoot) : {};
  for (const project of projects) for (const file of project.files) {
    const source = await targetFile(ownerRoot, project, file);
    const base = baseline(ownerRoot, project, file);
    if (operation === "sync") {
      await mkdir(dirname(base), { recursive: true });
      await copyFile(source, base);
    } else if (operation === "restore") {
      if (!await exists(base)) throw new Error(`baseline file not found: ${base}`);
      await mkdir(dirname(source), { recursive: true });
      await copyFile(base, source);
    } else {
      if (!await exists(base)) throw new Error(`baseline file not found: ${base}`);
      const local = join(localEnvironment(ownerRoot, project, env), file);
      if (await exists(local)) {
        try { await mergeConfigFile(base, local, source, variables); }
        catch (error) { throw new Error(`failed to apply ${project.id}/${file} from local file ${local}: ${(error as Error).message}`); }
      } else {
        await mkdir(dirname(source), { recursive: true });
        await copyFile(base, source);
      }
    }
    output.push(`${operation === "restore" ? "restored" : operation} ${project.id}/${file}`);
  }
  if (operation === "apply") projects.forEach((project) => lockedIds.add(project.id));
  if (operation === "restore") projects.forEach((project) => lockedIds.delete(project.id));
  if (operation !== "sync") await writeLock(ownerRoot, lockedIds);
  if (operation === "sync") {
    await mkdir(join(ownerRoot, "state"), { recursive: true });
    await writeFile(join(ownerRoot, "state/sync-meta.yaml"), stringify({ synced_at: new Date().toISOString(), files: output.map((line) => line.slice(5)) }));
  }
  return output;
}

async function ensureProjectLayout(ownerRoot: string, project: ProjectConfig, environment: string): Promise<void> {
  for (const file of project.files) {
    for (const path of [baseline(ownerRoot, project, file), join(localEnvironment(ownerRoot, project, environment), file)]) {
      if (!await exists(path)) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, ""); }
    }
  }
}

async function legacyEnvironment(ownerRoot: string): Promise<string> {
  const path = join(ownerRoot, ".env");
  if (!await exists(path)) return "dev";
  const line = (await readFile(path, "utf8")).split(/\r?\n/).find((item) => item.trim().startsWith("APP_ENV="));
  return normalizeEnvironment(line?.split("=", 2)[1].trim() || "dev");
}

async function discoveredEnvironments(ownerRoot: string): Promise<string[]> {
  const environments = new Set<string>();
  const legacyLocalRoot = join(ownerRoot, "data/local");
  if (await exists(legacyLocalRoot)) {
    for (const project of await readdir(legacyLocalRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const entry of await readdir(join(legacyLocalRoot, project.name), { withFileTypes: true })) if (entry.isDirectory()) environments.add(normalizeEnvironment(entry.name));
    }
  }
  const projectsRoot = join(ownerRoot, "data/projects");
  if (await exists(projectsRoot)) {
    for (const project of await readdir(projectsRoot, { withFileTypes: true })) {
      const localRoot = join(projectsRoot, project.name, "local");
      if (!project.isDirectory() || !await exists(localRoot)) continue;
      for (const entry of await readdir(localRoot, { withFileTypes: true })) if (entry.isDirectory()) environments.add(normalizeEnvironment(entry.name));
    }
  }
  return [...environments];
}

async function migrateLegacyProjectLayout(ownerRoot: string, projects: ProjectConfig[]): Promise<void> {
  for (const project of projects) {
    const legacyBaseline = join(ownerRoot, "data/baseline", String(project.id));
    const legacyLocal = join(ownerRoot, "data/local", String(project.id));
    const hasBaseline = await exists(legacyBaseline);
    const hasLocal = await exists(legacyLocal);
    if (!hasBaseline && !hasLocal) continue;
    const target = projectDataDir(ownerRoot, project);
    if (hasBaseline) await moveTree(legacyBaseline, join(target, "baseline"));
    if (hasLocal) await moveTree(legacyLocal, join(target, "local"));
  }
  await rmdir(join(ownerRoot, "data/baseline")).catch(() => undefined);
  await rmdir(join(ownerRoot, "data/local")).catch(() => undefined);
}

async function removeLegacyAppEnv(ownerRoot: string): Promise<void> {
  const path = join(ownerRoot, ".env");
  if (!await exists(path)) return;
  const lines = (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line && !line.trim().startsWith("APP_ENV="));
  if (lines.length) await writeFile(path, `${lines.join("\n")}\n`);
  else await unlink(path);
}

export async function ensureOwnerLayout(ownerRoot: string): Promise<void> {
  await mkdir(join(ownerRoot, "data"), { recursive: true });
  const raw = parse(await readFile(projectConfigPath(ownerRoot), "utf8")) as { env?: unknown };
  if (raw.env === undefined) {
    const current = await legacyEnvironment(ownerRoot);
    const options = [...new Set(["dev", current, ...await discoveredEnvironments(ownerRoot)])].sort();
    await writeEnvironmentConfig(ownerRoot, { current, options });
  }
  const projects = await loadProjects(ownerRoot);
  await migrateLegacyProjectLayout(ownerRoot, projects);
  await removeLegacyAppEnv(ownerRoot);
  const variables = join(ownerRoot, "data/variables.yaml");
  if (!await exists(variables)) await writeFile(variables, "{}\n");
  const jenkins = join(ownerRoot, "data/jenkins.yaml");
  if (!await exists(jenkins)) await writeFile(jenkins, "username: ''\ntoken: ''\n", { mode: 0o600 });
  const environment = await appEnv(ownerRoot);
  for (const project of projects) await ensureProjectLayout(ownerRoot, project, environment);
}

export async function getSummary(
  ownerRoot: string,
  composeRunner: CommandRunner = executeCommand,
  signal?: AbortSignal,
  options: { page?: number; pageSize?: number; query?: string } = {},
): Promise<ConfigSummary> {
  const projects = await loadProjects(ownerRoot);
  const lockedIds = await readLock(ownerRoot);
  const pinnedIds = await readPinnedProjects(ownerRoot);
  const tags = [...new Set(projects.flatMap((project) => project.tags))].sort();
  const query = options.query?.trim().toLocaleLowerCase() || "";
  const pageSize = options.pageSize ?? Math.max(1, projects.length);
  const filteredProjects = projects
    .filter((project) => !query || project.name.toLocaleLowerCase().includes(query))
    .sort((left, right) => Number(pinnedIds.has(right.id)) - Number(pinnedIds.has(left.id)) || left.id - right.id);
  const total = filteredProjects.length;
  const page = Math.min(options.page ?? 1, Math.max(1, Math.ceil(total / pageSize)));
  const pageProjects = filteredProjects.slice((page - 1) * pageSize, page * pageSize);
  const projectSummaries = await Promise.all(pageProjects.map(async (project) => ({
    ...project,
    pinned: pinnedIds.has(project.id),
    status: lockedIds.has(project.id) ? "applied" as const : "normal" as const,
    deploymentStatus: project.composeFile
      ? await getComposeDeployment(ownerRoot, project.id, composeRunner, signal).then((deployment) => deployment.status, (error) => {
        if (isExternalOperationTimeout(error) || signal?.aborted) throw signal?.reason || error;
        return "stopped" as const;
      })
      : null,
    updatedAt: await projectUpdatedAt(ownerRoot, project),
  })));
  return {
    tags: tags.map((name) => ({ name, projects: projects.filter((project) => project.tags.includes(name)).map((project) => project.id) })),
    projects: projectSummaries,
    total,
    page,
    pageSize,
  };
}

export function resolveOwnerRoot(value?: string): string {
  return resolve(value || join(dirname(fileURLToPath(import.meta.url)), "../.."));
}
