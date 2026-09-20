import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { extname, join } from "node:path";
import { createEnvironment, createProject, deleteEnvironment, deleteProject, deleteProjects, ensureOwnerLayout, getComposeDeployment, getGlobalSettings, getJenkinsCredentials, getProjectConfigs, getProjectDirectory, getSummary, listCodeDirectories, loadProjects, renameEnvironment, resolveOwnerRoot, runComposeOperation, runOperation, spawnComposeLogs, updateGlobalSettings, updateProject, updateProjectPin } from "./core.js";
import type { CommandRunner } from "./core.js";
import { COMPOSE_OPERATION_TIMEOUT_MS, EXTERNAL_OPERATION_TIMEOUT_MS, isExternalOperationTimeout, withExternalOperationTimeout } from "./external.js";
import { getJenkinsJob, isJenkinsBuildRunning, readJenkinsLog, triggerJenkinsBuild, type JenkinsFetch } from "./jenkins.js";
import { openCode, openDirectory, openGameClient, openGameServer, openTerminal, openZed } from "./platform.js";
import type { ComposeOperation, NewProject, Operation, Scalar } from "./types.js";

const ownerRoot = resolveOwnerRoot(process.env.OWNER_CONFIG_ROOT);
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const backgroundTypes = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/avif", ".avif"],
]);
const maxBackgroundBytes = 20 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function positiveIntegerParameter(value: string | null, fallback: number, name: string, maximum?: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (maximum !== undefined && parsed > maximum)) throw new HttpError(400, `${name} must be a positive integer${maximum ? ` no greater than ${maximum}` : ""}`);
  return parsed;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function readBinaryBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > limit) throw new HttpError(413, "background image must not exceed 20 MB");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    length += value.length;
    if (length > limit) throw new HttpError(413, "background image must not exceed 20 MB");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function isBackgroundImage(content: Buffer, extension: string): boolean {
  if (extension === ".png") return content.length >= 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (extension === ".jpg") return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (extension === ".webp") return content.length >= 12 && content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP";
  if (extension === ".gif") return content.length >= 6 && ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii"));
  if (extension === ".avif") return content.length >= 12 && content.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(content.subarray(8, 12).toString("ascii"));
  return false;
}

async function currentBackground(root: string): Promise<{ content: Buffer; extension: string }> {
  for (const extension of backgroundTypes.values()) {
    try {
      return { content: await readFile(join(root, "state", `background${extension}`)), extension };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { content: await readFile(join(root, "web-dist", "bg.png")), extension: ".png" };
}

async function saveBackground(root: string, extension: string, content: Buffer): Promise<void> {
  const stateDirectory = join(root, "state");
  const temporaryPath = join(stateDirectory, `.background-${process.pid}-${Date.now()}.tmp`);
  const targetPath = join(stateDirectory, `background${extension}`);
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(temporaryPath, content);
  await rename(temporaryPath, targetPath);
  await Promise.all([...new Set(backgroundTypes.values())]
    .filter((item) => item !== extension)
    .map((item) => unlink(join(stateDirectory, `background${item}`)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    })));
}

interface AppLogger {
  info(message: string): void;
  error(message: string): void;
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function logLine(event: string, details: string): string {
  return `[${new Date().toISOString()}] ${event} ${details}`;
}

export function installCrashLogging(logger: AppLogger = console): () => void {
  const handler = (error: Error, origin: string) => logger.error(logLine("CRASH", `origin=${origin}\n${errorDetails(error)}`));
  process.on("uncaughtExceptionMonitor", handler);
  return () => process.off("uncaughtExceptionMonitor", handler);
}

interface AppDependencies {
  directoryOpener?: (path: string) => Promise<void>;
  terminalOpener?: (path: string) => Promise<void>;
  codeOpener?: (path: string) => Promise<void>;
  zedOpener?: (path: string) => Promise<void>;
  gameClientOpener?: (path: string) => Promise<void>;
  gameServerOpener?: (path: string) => Promise<void>;
  composeRunner?: CommandRunner;
  composeLogSpawner?: (ownerRoot: string, id: number, service?: string, tail?: number) => Promise<ChildProcessWithoutNullStreams>;
  jenkinsFetch?: JenkinsFetch;
  jenkinsLogPollInterval?: number;
  externalOperationTimeoutMs?: number;
  composeOperationTimeoutMs?: number;
  logger?: AppLogger;
}

async function jenkinsContext(root: string, id: number): Promise<{ jobUrl: string; credentials: Awaited<ReturnType<typeof getJenkinsCredentials>> }> {
  const project = (await loadProjects(root)).find((item) => item.id === id);
  if (!project) throw new HttpError(404, `unknown project id: ${id}`);
  if (!project.jenkinsJobUrl) throw new HttpError(400, `project ${id} does not configure a Jenkins job`);
  return { jobUrl: project.jenkinsJobUrl, credentials: await getJenkinsCredentials(root) };
}

async function streamJenkinsOutput(response: ServerResponse, context: Awaited<ReturnType<typeof jenkinsContext>>, buildNumber: number, fetcher: JenkinsFetch, pollInterval: number): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const abortController = new AbortController();
  let closed = false;
  response.on("close", () => { closed = true; abortController.abort(); });
  const send = (event: string, value: unknown) => {
    if (!closed && !response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  let offset = 0;
  try {
    while (!closed) {
      const result = await readJenkinsLog(context.jobUrl, buildNumber, context.credentials, offset, fetcher, abortController.signal);
      offset = result.nextOffset;
      if (result.text) send("message", result.text);
      if (!result.more || !await isJenkinsBuildRunning(context.jobUrl, buildNumber, context.credentials, fetcher, abortController.signal)) {
        send("end", { offset });
        response.end();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, pollInterval);
        abortController.signal.addEventListener("abort", () => { clearTimeout(timer); reject(abortController.signal.reason); }, { once: true });
      });
    }
  } catch (error) {
    if (closed || abortController.signal.aborted) return;
    send("jenkins-error", (error as Error).message);
    response.end();
  }
}

function stopComposeLogProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  child.kill();
  const forceKillTimer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 1000);
  forceKillTimer.unref();
  child.once("close", () => clearTimeout(forceKillTimer));
}

function streamComposeOutput(response: ServerResponse, child: ChildProcessWithoutNullStreams): void {
  response.once("close", () => stopComposeLogProcess(child));
  if (response.destroyed) {
    stopComposeLogProcess(child);
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  let finished = false;
  const send = (event: string, value: unknown) => {
    if (!response.destroyed && !response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  };
  const finish = (event: string, value: unknown) => {
    if (finished) return;
    finished = true;
    send(event, value);
    response.end();
  };
  child.stdout.on("data", (chunk) => send("message", chunk.toString()));
  child.stderr.on("data", (chunk) => send("message", chunk.toString()));
  child.on("error", (error) => finish("compose-error", error.message));
  child.on("close", (code) => finish("end", { code }));
}

export function createApp(root = ownerRoot, dependencies: AppDependencies = {}) {
  let queue = Promise.resolve();
  let requestSequence = 0;
  const ready = ensureOwnerLayout(root);
  const directoryOpener = dependencies.directoryOpener ?? openDirectory;
  const terminalOpener = dependencies.terminalOpener ?? openTerminal;
  const codeOpener = dependencies.codeOpener ?? openCode;
  const zedOpener = dependencies.zedOpener ?? openZed;
  const gameClientOpener = dependencies.gameClientOpener ?? openGameClient;
  const gameServerOpener = dependencies.gameServerOpener ?? openGameServer;
  const composeLogSpawner = dependencies.composeLogSpawner ?? spawnComposeLogs;
  const jenkinsFetch = dependencies.jenkinsFetch ?? fetch;
  const jenkinsLogPollInterval = dependencies.jenkinsLogPollInterval ?? 1000;
  const externalOperationTimeoutMs = dependencies.externalOperationTimeoutMs ?? EXTERNAL_OPERATION_TIMEOUT_MS;
  const composeOperationTimeoutMs = dependencies.composeOperationTimeoutMs ?? COMPOSE_OPERATION_TIMEOUT_MS;
  const logger = dependencies.logger ?? console;
  return createServer(async (request, response) => {
    const requestId = ++requestSequence;
    const startedAt = performance.now();
    const method = request.method || "UNKNOWN";
    const target = request.url || "/";
    const requestLifetime = new AbortController();
    const abortRequest = () => {
      if (!requestLifetime.signal.aborted) requestLifetime.abort(new Error("客户端连接已断开"));
    };
    request.once("aborted", abortRequest);
    response.once("close", abortRequest);
    const externalOperation = <T>(name: string, operation: (signal: AbortSignal) => Promise<T>, timeoutMs = externalOperationTimeoutMs) => withExternalOperationTimeout(name, operation, { timeoutMs, parentSignal: requestLifetime.signal });
    let requestFinished = false;
    logger.info(logLine("REQUEST START", `id=${requestId} method=${method} path=${target}`));
    const finishRequestLog = (outcome: string) => {
      if (requestFinished) return;
      requestFinished = true;
      logger.info(logLine("REQUEST END", `id=${requestId} method=${method} path=${target} status=${response.statusCode} outcome=${outcome} duration_ms=${(performance.now() - startedAt).toFixed(1)}`));
    };
    response.once("finish", () => finishRequestLog("completed"));
    response.once("close", () => finishRequestLog(response.writableFinished ? "completed" : "aborted"));
    try {
      await ready;
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/background") {
        const background = await currentBackground(root);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-disposition": url.searchParams.get("download") === "1" ? `attachment; filename="owner-config-background${background.extension}"` : "inline",
          "content-type": contentTypes[background.extension],
          "x-background-filename": `owner-config-background${background.extension}`,
        });
        response.end(background.content);
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/background") {
        const contentType = (request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
        const extension = backgroundTypes.get(contentType);
        if (!extension) return json(response, 415, { error: "background must be PNG, JPEG, WebP, GIF, or AVIF" });
        const content = await readBinaryBody(request, maxBackgroundBytes);
        if (!content.length || !isBackgroundImage(content, extension)) return json(response, 400, { error: "background content does not match its image format" });
        const task = queue.then(() => saveBackground(root, extension, content));
        queue = task.then(() => undefined, () => undefined);
        await task;
        return json(response, 200, { ok: true, filename: `owner-config-background${extension}` });
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        const page = positiveIntegerParameter(url.searchParams.get("page"), 1, "page");
        const pageSize = positiveIntegerParameter(url.searchParams.get("pageSize"), 10, "pageSize", 100);
        const query = url.searchParams.get("query") || "";
        return json(response, 200, await externalOperation("Compose 状态查询", (signal) => getSummary(root, dependencies.composeRunner, signal, { page, pageSize, query })));
      }
      if (request.method === "GET" && url.pathname === "/api/directories") return json(response, 200, await listCodeDirectories(root, url.searchParams.get("path") || ""));
      if (request.method === "GET" && url.pathname === "/api/settings") return json(response, 200, await getGlobalSettings(root));
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        const input = await readBody(request) as { environment?: unknown; variables?: unknown; jenkins?: unknown };
        if (typeof input.environment !== "string" || !input.variables || typeof input.variables !== "object" || Array.isArray(input.variables)) return json(response, 400, { error: "environment and variables mapping are required" });
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(input.environment.trim())) return json(response, 400, { error: "invalid environment" });
        if (Object.entries(input.variables).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value === null || !["string", "number", "boolean"].includes(typeof value))) return json(response, 400, { error: "variables must use valid names and scalar values" });
        if (input.jenkins !== undefined && (!input.jenkins || typeof input.jenkins !== "object" || Array.isArray(input.jenkins))) return json(response, 400, { error: "Jenkins settings must be a mapping" });
        const jenkins = input.jenkins as { username?: unknown; token?: unknown; clearToken?: unknown } | undefined;
        if (jenkins && ((jenkins.username !== undefined && typeof jenkins.username !== "string") || (jenkins.token !== undefined && typeof jenkins.token !== "string") || (jenkins.clearToken !== undefined && typeof jenkins.clearToken !== "boolean"))) return json(response, 400, { error: "Jenkins username, token, and clearToken are invalid" });
        const task = queue.then(() => updateGlobalSettings(root, input.environment as string, input.variables as Record<string, Scalar>, jenkins as { username?: string; token?: string; clearToken?: boolean } | undefined));
        queue = task.then(() => undefined, () => undefined);
        return json(response, 200, await task);
      }
      if (request.method === "POST" && url.pathname === "/api/environments") {
        const input = await readBody(request) as { name?: unknown };
        if (typeof input.name !== "string") return json(response, 400, { error: "environment name is required" });
        const task = queue.then(() => createEnvironment(root, input.name as string));
        queue = task.then(() => undefined, () => undefined);
        return json(response, 201, await task);
      }
      const environmentMatch = url.pathname.match(/^\/api\/environments\/([A-Za-z0-9_-]+)$/);
      if (request.method === "PUT" && environmentMatch) {
        const input = await readBody(request) as { name?: unknown };
        if (typeof input.name !== "string") return json(response, 400, { error: "environment name is required" });
        const task = queue.then(() => renameEnvironment(root, environmentMatch[1], input.name as string));
        queue = task.then(() => undefined, () => undefined);
        return json(response, 200, await task);
      }
      if (request.method === "DELETE" && environmentMatch) {
        const task = queue.then(() => deleteEnvironment(root, environmentMatch[1]));
        queue = task.then(() => undefined, () => undefined);
        return json(response, 200, await task);
      }
      if (request.method === "POST" && url.pathname === "/api/projects") {
        const input = await readBody(request) as Partial<NewProject>;
        if (typeof input.name !== "string" || typeof input.confDir !== "string" || (input.composeFile !== undefined && typeof input.composeFile !== "string") || (input.jenkinsJobUrl !== undefined && typeof input.jenkinsJobUrl !== "string") || !Array.isArray(input.files) || !Array.isArray(input.tags) || input.files.some((file) => typeof file !== "string") || input.tags.some((tag) => typeof tag !== "string")) return json(response, 400, { error: "name, confDir, optional composeFile, optional jenkinsJobUrl, files, and tags are required" });
        const task = queue.then(() => createProject(root, input as NewProject));
        queue = task.then(() => undefined, () => undefined);
        const id = await task;
        return json(response, 201, { ok: true, id, summary: await externalOperation("Compose 状态查询", (signal) => getSummary(root, dependencies.composeRunner, signal)) });
      }
      if (request.method === "DELETE" && url.pathname === "/api/projects") {
        const input = await readBody(request) as { ids?: unknown };
        const validIds = Array.isArray(input.ids) && input.ids.length > 0 && input.ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0) && new Set(input.ids).size === input.ids.length;
        if (!validIds) return json(response, 400, { error: "unique positive project ids are required" });
        const task = queue.then(() => deleteProjects(root, input.ids as number[]));
        queue = task.then(() => undefined, () => undefined);
        await task;
        return json(response, 200, { ok: true, summary: await externalOperation("Compose 状态查询", (signal) => getSummary(root, dependencies.composeRunner, signal)) });
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/(\d+)$/);
      const projectPinMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/pin$/);
      const openDirectoryMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/open-directory$/);
      const openTerminalMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/open-terminal$/);
      const openCodeMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/open-vscode$/);
      const openZedMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/open-zed$/);
      const openGameClientMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/open-game-client$/);
      const openGameServerMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/open-game-server$/);
      if (request.method === "PUT" && projectPinMatch) {
        const input = await readBody(request) as { pinned?: unknown };
        if (typeof input.pinned !== "boolean") return json(response, 400, { error: "pinned boolean is required" });
        const task = queue.then(() => updateProjectPin(root, Number(projectPinMatch[1]), input.pinned as boolean));
        queue = task.then(() => undefined, () => undefined);
        await task;
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && openDirectoryMatch) {
        const input = await readBody(request) as { directory?: unknown };
        if (input.directory !== undefined && (typeof input.directory !== "string" || !input.directory.trim() || input.directory.trim() === "." || input.directory.trim() === ".." || input.directory.includes("/") || input.directory.includes("\\"))) return json(response, 400, { error: "directory must be a direct child name" });
        const path = await getProjectDirectory(root, Number(openDirectoryMatch[1]), input.directory as string | undefined);
        await externalOperation("打开项目目录", () => directoryOpener(path));
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && openTerminalMatch) {
        const input = await readBody(request) as { directory?: unknown };
        if (input.directory !== undefined && (typeof input.directory !== "string" || !input.directory.trim() || input.directory.trim() === "." || input.directory.trim() === ".." || input.directory.includes("/") || input.directory.includes("\\"))) return json(response, 400, { error: "directory must be a direct child name" });
        const path = await getProjectDirectory(root, Number(openTerminalMatch[1]), input.directory as string | undefined);
        await externalOperation("打开项目终端", () => terminalOpener(path));
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && openCodeMatch) {
        const input = await readBody(request) as { directory?: unknown };
        if (input.directory !== undefined && (typeof input.directory !== "string" || !input.directory.trim() || input.directory.trim() === "." || input.directory.trim() === ".." || input.directory.includes("/") || input.directory.includes("\\"))) return json(response, 400, { error: "directory must be a direct child name" });
        const path = await getProjectDirectory(root, Number(openCodeMatch[1]), input.directory as string | undefined);
        await externalOperation("打开 VS Code", () => codeOpener(path));
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && openZedMatch) {
        const input = await readBody(request) as { directory?: unknown };
        if (input.directory !== undefined && (typeof input.directory !== "string" || !input.directory.trim() || input.directory.trim() === "." || input.directory.trim() === ".." || input.directory.includes("/") || input.directory.includes("\\"))) return json(response, 400, { error: "directory must be a direct child name" });
        const path = await getProjectDirectory(root, Number(openZedMatch[1]), input.directory as string | undefined);
        await externalOperation("打开 Zed", () => zedOpener(path));
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && (openGameClientMatch || openGameServerMatch)) {
        const id = Number((openGameClientMatch || openGameServerMatch)?.[1]);
        const project = (await loadProjects(root)).find((item) => item.id === id);
        if (!project) return json(response, 404, { error: `unknown project id: ${id}` });
        if (!project.tags.includes("game")) return json(response, 400, { error: "project must include the game tag" });
        const path = await getProjectDirectory(root, id);
        await externalOperation(openGameClientMatch ? "启动游戏客户端" : "启动游戏服务器", () => (openGameClientMatch ? gameClientOpener(path) : gameServerOpener(path)));
        return json(response, 200, { ok: true });
      }
      if (request.method === "PUT" && projectMatch) {
        const input = await readBody(request) as Partial<NewProject>;
        if (typeof input.name !== "string" || typeof input.confDir !== "string" || (input.composeFile !== undefined && typeof input.composeFile !== "string") || (input.jenkinsJobUrl !== undefined && typeof input.jenkinsJobUrl !== "string") || !Array.isArray(input.files) || !Array.isArray(input.tags) || input.files.some((file) => typeof file !== "string") || input.tags.some((tag) => typeof tag !== "string")) return json(response, 400, { error: "name, confDir, optional composeFile, optional jenkinsJobUrl, files, and tags are required" });
        const task = queue.then(() => updateProject(root, Number(projectMatch[1]), input as NewProject));
        queue = task.then(() => undefined, () => undefined);
        return json(response, 200, { ok: true, project: await task });
      }
      if (request.method === "DELETE" && projectMatch) {
        const task = queue.then(() => deleteProject(root, Number(projectMatch[1])));
        queue = task.then(() => undefined, () => undefined);
        await task;
        return json(response, 200, { ok: true, summary: await externalOperation("Compose 状态查询", (signal) => getSummary(root, dependencies.composeRunner, signal)) });
      }
      const configsMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/configs$/);
      if (request.method === "GET" && configsMatch) return json(response, 200, { files: await getProjectConfigs(root, Number(configsMatch[1])) });
      const jenkinsMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/jenkins$/);
      const jenkinsBuildsMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/jenkins\/builds$/);
      const jenkinsLogsMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/jenkins\/builds\/(\d+)\/logs$/);
      if (request.method === "GET" && jenkinsMatch) {
        const context = await jenkinsContext(root, Number(jenkinsMatch[1]));
        return json(response, 200, { job: await externalOperation("Jenkins Job 查询", (signal) => getJenkinsJob(context.jobUrl, context.credentials, jenkinsFetch, signal)) });
      }
      if (request.method === "POST" && jenkinsBuildsMatch) {
        const input = await readBody(request) as { parameters?: unknown };
        if (!input.parameters || typeof input.parameters !== "object" || Array.isArray(input.parameters) || Object.entries(input.parameters).some(([key, value]) => !key || value === null || (!Array.isArray(value) && !["string", "number", "boolean"].includes(typeof value)) || (Array.isArray(value) && value.some((item) => typeof item !== "string")))) return json(response, 400, { error: "Jenkins build parameters must contain scalars or string arrays" });
        const context = await jenkinsContext(root, Number(jenkinsBuildsMatch[1]));
        return json(response, 201, { ok: true, ...await externalOperation("Jenkins 构建", (signal) => triggerJenkinsBuild(context.jobUrl, context.credentials, input.parameters as Record<string, string | number | boolean | string[]>, jenkinsFetch, signal)) });
      }
      if (request.method === "GET" && jenkinsLogsMatch) {
        const context = await jenkinsContext(root, Number(jenkinsLogsMatch[1]));
        await streamJenkinsOutput(response, context, Number(jenkinsLogsMatch[2]), jenkinsFetch, jenkinsLogPollInterval);
        return;
      }
      const composeMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/compose$/);
      const composeLogsMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/compose\/logs$/);
      if (request.method === "GET" && composeMatch) return json(response, 200, { deployment: await externalOperation("Compose 状态查询", (signal) => getComposeDeployment(root, Number(composeMatch[1]), dependencies.composeRunner, signal)) });
      if (request.method === "GET" && composeLogsMatch) {
        const tailValue = url.searchParams.get("tail") || "200";
        const tail = /^\d+$/.test(tailValue) ? Number(tailValue) : NaN;
        if (!Number.isSafeInteger(tail) || tail < 1 || tail > 10000) return json(response, 400, { error: "compose log tail must be an integer from 1 to 10000" });
        const service = url.searchParams.get("service")?.trim() || undefined;
        try {
          const child = await externalOperation("Compose 日志连接", async (signal) => {
            if (service) {
              const deployment = await getComposeDeployment(root, Number(composeLogsMatch[1]), dependencies.composeRunner, signal);
              if (!deployment.services.some((item) => item.name === service)) throw new HttpError(400, `unknown compose service: ${service}`);
            }
            const spawnedChild = await composeLogSpawner(root, Number(composeLogsMatch[1]), service, tail);
            if (signal.aborted) {
              stopComposeLogProcess(spawnedChild);
              throw signal.reason;
            }
            return spawnedChild;
          });
          if (requestLifetime.signal.aborted || response.destroyed) {
            stopComposeLogProcess(child);
            return;
          }
          streamComposeOutput(response, child);
        } catch (error) {
          if (!requestLifetime.signal.aborted) throw error;
        }
        return;
      }
      if (request.method === "POST" && composeMatch) {
        const input = await readBody(request) as { operation?: unknown; service?: unknown };
        if (!(["up", "down", "restart"] as unknown[]).includes(input.operation)) return json(response, 400, { error: "compose operation must be up, down, or restart" });
        if (input.service !== undefined && (typeof input.service !== "string" || !input.service.trim())) return json(response, 400, { error: "compose service must be a non-empty string" });
        const service = typeof input.service === "string" ? input.service.trim() : undefined;
        const task = queue.then(() => externalOperation("Compose 操作", async (signal) => {
          const output = await runComposeOperation(root, Number(composeMatch[1]), input.operation as ComposeOperation, dependencies.composeRunner, service, signal);
          const deployment = await getComposeDeployment(root, Number(composeMatch[1]), dependencies.composeRunner, signal);
          return { output, deployment };
        }, composeOperationTimeoutMs));
        queue = task.then(() => undefined, () => undefined);
        return json(response, 200, { ok: true, ...await task });
      }
      if (request.method === "POST" && url.pathname === "/api/operations") {
        const input = await readBody(request) as { operation?: unknown; ids?: unknown; tag?: unknown; name?: unknown; id?: unknown };
        const validIds = Array.isArray(input.ids) && input.ids.length === 1 && typeof input.ids[0] === "number" && Number.isSafeInteger(input.ids[0]) && input.ids[0] > 0;
        const hasLegacySelector = ["tag", "name", "id"].some((key) => Object.prototype.hasOwnProperty.call(input, key));
        if (!(["sync", "apply", "restore"] as unknown[]).includes(input.operation) || !validIds || hasLegacySelector) return json(response, 400, { error: "operation and exactly one positive project id are required" });
        const task = queue.then(() => runOperation(root, input.operation as Operation, input.ids as number[]));
        queue = task.then(() => undefined, () => undefined);
        const output = await task;
        return json(response, 200, { ok: true, output, summary: await externalOperation("Compose 状态查询", (signal) => getSummary(root, dependencies.composeRunner, signal)) });
      }
      if (request.method !== "GET") return json(response, 404, { error: "not found" });
      if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "not found" });
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.split("/").includes("..")) return json(response, 404, { error: "not found" });
      const content = await readFile(join(root, "web-dist", file));
      response.writeHead(200, { "content-type": contentTypes[extname(file)] || "application/octet-stream" });
      response.end(content);
    } catch (error) {
      if (requestLifetime.signal.aborted) return;
      logger.error(logLine("REQUEST ERROR", `id=${requestId} method=${method} path=${target}\n${errorDetails(error)}`));
      if (!response.headersSent) json(response, error instanceof HttpError ? error.status : isExternalOperationTimeout(error) ? 504 : 500, { error: (error as Error).message });
      else response.destroy();
    }
  });
}

export function startServer() {
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || "127.0.0.1";
  return createApp().listen(port, host, () => console.log(`owner_config web: http://${host}:${port}`));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  installCrashLogging();
  startServer();
}
