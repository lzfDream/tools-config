import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parse, stringify } from "yaml";
import { createApp } from "../src/server.js";
import { COMPOSE_OPERATION_TIMEOUT_MS, EXTERNAL_OPERATION_TIMEOUT_MS } from "../src/external.js";

async function fetchReady(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return await fetch(url); }
    catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

test("HTTP API exposes tag status and validates operations", async (context) => {
  const codeRoot = await mkdtemp(join(tmpdir(), "owner-config-server-"));
  const root = join(codeRoot, "owner_config");
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "web-dist/assets"), { recursive: true });
  await mkdir(join(root, "data/baseline/1"), { recursive: true });
  await mkdir(join(root, "data/local/1/dev"), { recursive: true });
  await mkdir(join(codeRoot, "apps/api/conf"), { recursive: true });
  await writeFile(join(root, "data/projects.yaml"), stringify({ env: { current: "dev", options: ["dev"] }, projects: [
    { id: 1, name: "api", conf_dir: "apps/api", compose_file: "apps/api/custom-stack.yml", files: ["dev.yaml"] },
  ] }));
  await writeFile(join(root, "data/variables.yaml"), "{}\n");
  await writeFile(join(root, "data/baseline/1/dev.yaml"), "server:\n  workers: 4\n");
  await writeFile(join(root, "data/local/1/dev/dev.yaml"), "server:\n  workers: 8\n");
  await writeFile(join(root, "web-dist/index.html"), "<div id=\"app\"></div>");
  await writeFile(join(root, "web-dist/assets/app.js"), "console.log('app');");
  await writeFile(join(root, "web-dist/favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  const defaultBackground = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  await writeFile(join(root, "web-dist/bg.png"), defaultBackground);
  await writeFile(join(codeRoot, "apps/api/custom-stack.yml"), "services:\n  api:\n    image: api:1\n");
  const openedDirectories: string[] = [];
  const openedTerminals: string[] = [];
  const openedCodeDirectories: string[] = [];
  const openedZedDirectories: string[] = [];
  const composeCalls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const composeLogRequests: Array<{ service?: string; tail?: number }> = [];
  const infoLogs: string[] = [];
  const errorLogs: string[] = [];
  const runningServices = new Set(["api"]);
  const server = createApp(root, {
    logger: {
      info: (message) => infoLogs.push(message),
      error: (message) => errorLogs.push(message),
    },
    directoryOpener: async (path) => { openedDirectories.push(path); },
    terminalOpener: async (path) => { openedTerminals.push(path); },
    codeOpener: async (path) => { openedCodeDirectories.push(path); },
    zedOpener: async (path) => { openedZedDirectories.push(path); },
    composeRunner: async (command, args, cwd) => {
      composeCalls.push({ command, args, cwd });
      if (args[3] === "config") return { stdout: "api\n", stderr: "" };
      if (args[3] === "ps") return { stdout: JSON.stringify([...runningServices].map((service) => ({
        Service: service,
        Publishers: [{ URL: "0.0.0.0", TargetPort: 3000, PublishedPort: 8080, Protocol: "tcp" }],
      }))), stderr: "" };
      if (args[3] === "up") runningServices.add(args[5] || "api");
      if (args[3] === "down") runningServices.clear();
      if (args[3] === "stop") runningServices.delete(args[4]);
      return { stdout: "done\n", stderr: "" };
    },
    composeLogSpawner: async (_ownerRoot, _id, service, tail) => {
      composeLogRequests.push({ service, tail });
      return spawn(process.execPath, ["-e", "process.stdout.write('compose log\\n')"], { stdio: "pipe" });
    },
  }).listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const status = await fetchReady(`${base}/api/status`);
  assert.equal(status.status, 200);
  const summary = await status.json() as { state?: unknown; tags: unknown; total: number; page: number; pageSize: number; projects: Array<{ status: string; deploymentStatus: string; pinned: boolean }> };
  assert.equal(summary.state, undefined);
  assert.deepEqual(summary.tags, []);
  assert.deepEqual({ total: summary.total, page: summary.page, pageSize: summary.pageSize }, { total: 1, page: 1, pageSize: 10 });
  assert.equal(summary.projects[0].pinned, false);
  assert.equal(summary.projects[0].status, "normal");
  assert.equal(summary.projects[0].deploymentStatus, "running");
  assert.equal((await fetch(`${base}/api/status?page=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/status?pageSize=101`)).status, 400);
  const invalidPin = await fetch(`${base}/api/projects/1/pin`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(invalidPin.status, 400);
  const pin = await fetch(`${base}/api/projects/1/pin`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ pinned: true }) });
  assert.equal(pin.status, 200);
  assert.equal(((await (await fetch(`${base}/api/status?page=1&pageSize=10&query=api`)).json()) as { projects: Array<{ pinned: boolean }> }).projects[0].pinned, true);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
  const favicon = await fetch(`${base}/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.match(favicon.headers.get("content-type") || "", /image\/svg\+xml/);
  const background = await fetch(`${base}/api/background`);
  assert.equal(background.status, 200);
  assert.equal(background.headers.get("content-type"), "image/png");
  assert.equal(background.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await background.arrayBuffer()), defaultBackground);
  const replacementBackground = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 8, 7, 6]);
  const replaceBackground = await fetch(`${base}/api/background`, { method: "PUT", body: new Blob([replacementBackground], { type: "image/png" }) });
  assert.equal(replaceBackground.status, 200);
  assert.deepEqual(new Uint8Array(await readFile(join(root, "state/background.png"))), replacementBackground);
  const downloadBackground = await fetch(`${base}/api/background?download=1`);
  assert.match(downloadBackground.headers.get("content-disposition") || "", /attachment; filename="owner-config-background\.png"/);
  assert.equal(downloadBackground.headers.get("x-background-filename"), "owner-config-background.png");
  const mismatchedBackground = await fetch(`${base}/api/background`, { method: "PUT", body: new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" }) });
  assert.equal(mismatchedBackground.status, 400);
  const unsupportedBackground = await fetch(`${base}/api/background`, { method: "PUT", body: new Blob(["image"], { type: "image/bmp" }) });
  assert.equal(unsupportedBackground.status, 415);
  const openDirectory = await fetch(`${base}/api/projects/1/open-directory`, { method: "POST" });
  assert.equal(openDirectory.status, 200);
  assert.deepEqual(openedDirectories, [join(codeRoot, "apps/api")]);
  const openChildDirectory = await fetch(`${base}/api/projects/1/open-directory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: "conf" }) });
  assert.equal(openChildDirectory.status, 200);
  assert.deepEqual(openedDirectories, [join(codeRoot, "apps/api"), join(codeRoot, "apps/api/conf")]);
  const invalidChildDirectory = await fetch(`${base}/api/projects/1/open-directory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: "../owner_config" }) });
  assert.equal(invalidChildDirectory.status, 400);
  const openTerminal = await fetch(`${base}/api/projects/1/open-terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: "conf" }) });
  assert.equal(openTerminal.status, 200);
  assert.deepEqual(openedTerminals, [join(codeRoot, "apps/api/conf")]);
  const openCode = await fetch(`${base}/api/projects/1/open-vscode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: "conf" }) });
  assert.equal(openCode.status, 200);
  assert.deepEqual(openedCodeDirectories, [join(codeRoot, "apps/api/conf")]);
  const openZed = await fetch(`${base}/api/projects/1/open-zed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ directory: "conf" }) });
  assert.equal(openZed.status, 200);
  assert.deepEqual(openedZedDirectories, [join(codeRoot, "apps/api/conf")]);
  const invalidCompose = await fetch(`${base}/api/projects/1/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "logs" }) });
  assert.equal(invalidCompose.status, 400);
  for (const operation of ["up", "down", "restart"]) {
    const compose = await fetch(`${base}/api/projects/1/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation }) });
    assert.equal(compose.status, 200);
  }
  assert.deepEqual(composeCalls.filter((call) => ["up", "down", "restart", "stop"].includes(call.args[3])).map((call) => call.args), [
    ["compose", "-f", "custom-stack.yml", "up", "-d"],
    ["compose", "-f", "custom-stack.yml", "down"],
    ["compose", "-f", "custom-stack.yml", "restart"],
  ]);
  assert(composeCalls.every((call) => call.command === "docker" && call.cwd === join(codeRoot, "apps/api")));
  const deployment = await fetch(`${base}/api/projects/1/compose`);
  assert.deepEqual(await deployment.json(), { deployment: { status: "stopped", services: [{ name: "api", status: "stopped", ports: [] }] } });
  const serviceUp = await fetch(`${base}/api/projects/1/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "up", service: "api" }) });
  assert.equal(serviceUp.status, 200);
  assert.equal(((await serviceUp.json()) as { deployment: { status: string } }).deployment.status, "running");
  const serviceDown = await fetch(`${base}/api/projects/1/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "down", service: "api" }) });
  assert.equal(serviceDown.status, 200);
  assert.equal(((await serviceDown.json()) as { deployment: { status: string } }).deployment.status, "stopped");
  const composeLogs = await fetch(`${base}/api/projects/1/compose/logs`);
  assert.match(composeLogs.headers.get("content-type") || "", /text\/event-stream/);
  assert.match(await composeLogs.text(), /data: "compose log\\n"/);
  const serviceLogs = await fetch(`${base}/api/projects/1/compose/logs?service=api&tail=1000`);
  assert.match(await serviceLogs.text(), /data: "compose log\\n"/);
  for (const tail of ["0", "10001", "all"]) {
    const invalidLogs = await fetch(`${base}/api/projects/1/compose/logs?tail=${tail}`);
    assert.equal(invalidLogs.status, 400);
  }
  assert.deepEqual(composeLogRequests, [{ service: undefined, tail: 200 }, { service: "api", tail: 1000 }]);
  const composeFile = await fetch(`${base}/api/projects/1/compose/file`);
  assert.equal(composeFile.status, 404);
  const saveComposeFile = await fetch(`${base}/api/projects/1/compose/file`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "services: {}\n", expectedContent: "" }) });
  assert.equal(saveComposeFile.status, 404);
  const directories = await fetch(`${base}/api/directories?path=apps`);
  assert.equal(directories.status, 200);
  assert.deepEqual((await directories.json() as { directories: Array<{ path: string }> }).directories.map((entry) => entry.path), ["apps/api"]);
  const files = await fetch(`${base}/api/directories?path=apps/api`);
  assert.equal(files.status, 200);
  assert.deepEqual((await files.json() as { files: Array<{ path: string }> }).files.map((entry) => entry.path), ["apps/api/custom-stack.yml"]);
  const settings = await fetch(`${base}/api/settings`);
  assert.equal(settings.status, 200);
  assert.deepEqual(await settings.json(), { environment: "dev", environments: ["dev"], variables: {}, jenkins: { username: "", tokenConfigured: false } });
  const createStaging = await fetch(`${base}/api/environments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "staging" }) });
  assert.equal(createStaging.status, 201);
  const saveSettings = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment: "staging", variables: { PORT: 3306, DEBUG: false } }) });
  assert.equal(saveSettings.status, 200);
  assert.deepEqual(await saveSettings.json(), { environment: "staging", environments: ["dev", "staging"], variables: { PORT: 3306, DEBUG: false }, jenkins: { username: "", tokenConfigured: false } });
  assert.deepEqual((parse(await readFile(join(root, "data/projects.yaml"), "utf8")) as { env: unknown }).env, { current: "staging", options: ["dev", "staging"] });
  const createEnvironment = await fetch(`${base}/api/environments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "inner-dev" }) });
  assert.equal(createEnvironment.status, 201);
  assert.deepEqual((await createEnvironment.json() as { environments: string[] }).environments, ["dev", "inner-dev", "staging"]);
  const renameEnvironment = await fetch(`${base}/api/environments/inner-dev`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "inner-test" }) });
  assert.equal(renameEnvironment.status, 200);
  assert.deepEqual((await renameEnvironment.json() as { environments: string[] }).environments, ["dev", "inner-test", "staging"]);
  const deleteEnvironment = await fetch(`${base}/api/environments/staging`, { method: "DELETE" });
  assert.equal(deleteEnvironment.status, 200);
  const environmentsAfterDelete = await deleteEnvironment.json() as { environment: string; environments: string[] };
  assert.equal(environmentsAfterDelete.environment, "dev");
  assert.deepEqual(environmentsAfterDelete.environments, ["dev", "inner-test"]);
  const invalidSettings = await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment: "../prod", variables: {} }) });
  assert.equal(invalidSettings.status, 400);
  await fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ environment: "dev", variables: { PORT: 3306, DEBUG: false } }) });
  const configs = await fetch(`${base}/api/projects/1/configs`);
  assert.equal(configs.status, 200);
  const configViews = await configs.json() as { files: Array<{ merged: string }> };
  assert.match(configViews.files[0].merged, /workers: 8/);
  const saveBaseline = await fetch(`${base}/api/projects/1/configs/baseline`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "dev.yaml", content: "server:\n  workers: 5\n", expectedContent: "server:\n  workers: 4\n" }) });
  assert.equal(saveBaseline.status, 404);
  const saveConfig = await fetch(`${base}/api/projects/1/configs`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "dev.yaml", content: "server:\n  workers: 7\n", expectedContent: "server:\n  workers: 8\n" }) });
  assert.equal(saveConfig.status, 404);
  const missingApi = await fetch(`${base}/api/missing`);
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), { error: "not found" });
  const invalid = await fetch(`${base}/api/operations`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(invalid.status, 400);
  for (const selector of [{ id: 1 }, { tag: "api" }, { name: "api" }, { ids: [1], tag: "api" }]) {
    const legacyTarget = await fetch(`${base}/api/operations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "sync", ...selector }) });
    assert.equal(legacyTarget.status, 400);
  }
  const legacyTags = await fetch(`${base}/api/projects/1/tags`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tags: ["backend"] }) });
  assert.equal(legacyTags.status, 404);
  const invalidIds = await fetch(`${base}/api/operations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "sync", ids: [] }) });
  assert.equal(invalidIds.status, 400);
  const multipleIds = await fetch(`${base}/api/operations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "sync", ids: [1, 2] }) });
  assert.equal(multipleIds.status, 400);
  const applyOne = await fetch(`${base}/api/operations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "apply", ids: [1] }) });
  assert.equal(applyOne.status, 200);
  assert.match(await readFile(join(codeRoot, "apps/api/conf/dev.yaml"), "utf8"), /workers: 8/);
  const restoreOne = await fetch(`${base}/api/operations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "restore", ids: [1] }) });
  assert.equal(restoreOne.status, 200);
  assert.match(await readFile(join(codeRoot, "apps/api/conf/dev.yaml"), "utf8"), /workers: 4/);

  await mkdir(join(codeRoot, "apps/renamed"), { recursive: true });
  await writeFile(join(codeRoot, "apps/renamed/development.yml"), "services: {}\n");
  const composeCallsBeforeUpdate = composeCalls.length;
  const updateProject = await fetch(`${base}/api/projects/1`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "renamed-api", confDir: "apps/renamed", composeFile: "apps/renamed/development.yml", files: [], tags: ["service"] }),
  });
  assert.equal(updateProject.status, 200);
  const projectResult = await updateProject.json() as { project: { id: number; name: string; confDir: string; composeFile?: string; files: string[]; tags: string[] } };
  assert.deepEqual(projectResult.project, { id: 1, name: "renamed-api", confDir: "apps/renamed", composeFile: "apps/renamed/development.yml", files: [], tags: ["service"] });
  assert.equal(composeCalls.length, composeCallsBeforeUpdate);
  const config = parse(await readFile(join(root, "data/projects.yaml"), "utf8")) as { projects: Array<Record<string, unknown>> };
  assert.deepEqual(config.projects[0], { id: 1, name: "renamed-api", conf_dir: "apps/renamed", compose_file: "apps/renamed/development.yml", files: [], tags: ["service"] });
  assert.deepEqual(parse(await readFile(join(root, "state/project-pins.yaml"), "utf8")), { project_ids: [1] });
  const statusAfterUpdate = await (await fetch(`${base}/api/status?page=1&pageSize=10&query=renamed`)).json() as { projects: Array<{ pinned: boolean }> };
  assert.equal(statusAfterUpdate.projects[0].pinned, true);

  const missingProject = await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "worker", confDir: "apps/worker", tags: ["backend"], files: ["worker.yaml"] }) });
  assert.equal(missingProject.status, 500);
  assert.match(((await missingProject.json()) as { error: string }).error, /project directory does not exist/);
  await mkdir(join(codeRoot, "apps/worker"), { recursive: true });
  const createProject = await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "worker", confDir: "apps/worker", tags: ["backend"], files: [] }) });
  assert.equal(createProject.status, 201);
  const created = await createProject.json() as { id: number; summary: { projects: unknown[] } };
  assert.equal(created.id, 2);
  assert.equal(created.summary.projects.length, 2);
  assert.deepEqual((created.summary.projects[1] as { files: string[] }).files, []);
  const secondPageResponse = await fetch(`${base}/api/status?page=2&pageSize=1`);
  const secondPage = await secondPageResponse.json() as { total: number; page: number; pageSize: number; projects: Array<{ id: number }> };
  assert.deepEqual({ total: secondPage.total, page: secondPage.page, pageSize: secondPage.pageSize }, { total: 2, page: 2, pageSize: 1 });
  assert.deepEqual(secondPage.projects.map((project) => project.id), [2]);
  const filteredPage = await (await fetch(`${base}/api/status?page=2&pageSize=1&query=worker`)).json() as { total: number; page: number; projects: Array<{ id: number }> };
  assert.deepEqual({ total: filteredPage.total, page: filteredPage.page, ids: filteredPage.projects.map((project) => project.id) }, { total: 1, page: 1, ids: [2] });
  const emptyConfigs = await fetch(`${base}/api/projects/2/configs`);
  assert.deepEqual(await emptyConfigs.json(), { files: [] });
  const invalidBulkDelete = await fetch(`${base}/api/projects`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [2, 2] }) });
  assert.equal(invalidBulkDelete.status, 400);
  const deleteProjects = await fetch(`${base}/api/projects`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [1, 2] }) });
  assert.equal(deleteProjects.status, 200);
  assert.equal(((await deleteProjects.json()) as { summary: { projects: unknown[] } }).summary.projects.length, 0);
  await assert.rejects(readFile(join(root, "data/projects/worker--2/baseline")), /ENOENT/);
  await new Promise((resolve) => setImmediate(resolve));
  assert(infoLogs.some((message) => /REQUEST START id=\d+ method=PUT path=\/api\/background/.test(message)));
  assert(infoLogs.some((message) => /REQUEST END id=\d+ method=GET path=\/api\/status status=200 outcome=completed duration_ms=\d+\.\d/.test(message)));
  assert(errorLogs.some((message) => /REQUEST ERROR[\s\S]*project directory does not exist/.test(message)));
});

test("external-resource APIs fail when their operation exceeds the timeout", async (context) => {
  assert.equal(EXTERNAL_OPERATION_TIMEOUT_MS, 3000);
  assert.equal(COMPOSE_OPERATION_TIMEOUT_MS, 30000);
  const codeRoot = await mkdtemp(join(tmpdir(), "owner-config-timeout-"));
  const root = join(codeRoot, "owner_config");
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(codeRoot, "apps/api"), { recursive: true });
  await writeFile(join(codeRoot, "apps/api/compose.yml"), "services:\n  api:\n    image: api:1\n");
  await writeFile(join(root, "data/projects.yaml"), stringify({ env: { current: "dev", options: ["dev"] }, projects: [
    { id: 1, name: "api", conf_dir: "apps/api", compose_file: "apps/api/compose.yml", jenkins_job_url: "http://jenkins/job/deploy/", files: [], tags: [] },
  ] }));
  await writeFile(join(root, "data/variables.yaml"), "{}\n");
  await writeFile(join(root, "data/jenkins.yaml"), "username: builder\ntoken: secret\n");
  const never = () => new Promise<never>(() => undefined);
  const errors: string[] = [];
  const server = createApp(root, {
    composeRunner: never,
    composeLogSpawner: never,
    jenkinsFetch: never as typeof fetch,
    directoryOpener: never,
    terminalOpener: never,
    codeOpener: never,
    zedOpener: never,
    externalOperationTimeoutMs: 20,
    composeOperationTimeoutMs: 80,
    logger: { info: () => undefined, error: (message) => errors.push(message) },
  }).listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const requests: Array<[string, RequestInit | undefined]> = [
    ["/api/status", undefined],
    ["/api/projects/1/open-directory", { method: "POST" }],
    ["/api/projects/1/open-terminal", { method: "POST" }],
    ["/api/projects/1/open-vscode", { method: "POST" }],
    ["/api/projects/1/open-zed", { method: "POST" }],
    ["/api/projects/1/jenkins", undefined],
    ["/api/projects/1/jenkins/builds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parameters: {} }) }],
    ["/api/projects/1/compose", undefined],
    ["/api/projects/1/compose/logs", undefined],
  ];
  for (const [path, init] of requests) {
    const startedAt = performance.now();
    let response: Response;
    try { response = init ? await fetch(`${base}${path}`, init) : await fetchReady(`${base}${path}`); }
    catch (error) { throw new Error(`${path} disconnected before returning a timeout response: ${errors.join("\n")}`, { cause: error }); }
    assert.equal(response.status, 504, path);
    assert.match(((await response.json()) as { error: string }).error, /超时（超过 20 毫秒）/);
    assert(performance.now() - startedAt < 500, `${path} did not fail promptly`);
  }
  const composeStartedAt = performance.now();
  const composeResponse = await fetch(`${base}/api/projects/1/compose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "up" }) });
  assert.equal(composeResponse.status, 504);
  assert.match(((await composeResponse.json()) as { error: string }).error, /Compose 操作超时（超过 80 毫秒）/);
  assert(performance.now() - composeStartedAt >= 60, "Compose operation used the shorter external-resource timeout");
});

test("Compose log processes are cleaned up when the client disconnects during setup", async (context) => {
  const codeRoot = await mkdtemp(join(tmpdir(), "owner-config-compose-log-disconnect-"));
  const root = join(codeRoot, "owner_config");
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "web-dist"), { recursive: true });
  await mkdir(join(codeRoot, "apps/api"), { recursive: true });
  await writeFile(join(root, "data/projects.yaml"), stringify({ env: { current: "dev", options: ["dev"] }, projects: [
    { id: 1, name: "api", conf_dir: "apps/api", compose_file: "apps/api/compose.yaml", files: [] },
  ] }));
  await writeFile(join(root, "data/variables.yaml"), "{}\n");
  await writeFile(join(root, "web-dist/index.html"), "<div id=\"app\"></div>");
  await writeFile(join(codeRoot, "apps/api/compose.yaml"), "services:\n  api:\n    image: api:1\n");

  let releaseSpawner: (() => void) | undefined;
  const spawnerGate = new Promise<void>((resolve) => { releaseSpawner = resolve; });
  let notifySpawnerStarted: (() => void) | undefined;
  const spawnerStarted = new Promise<void>((resolve) => { notifySpawnerStarted = resolve; });
  let spawnedChild: ChildProcessWithoutNullStreams | undefined;
  let notifyChildSpawned: (() => void) | undefined;
  const childSpawned = new Promise<void>((resolve) => { notifyChildSpawned = resolve; });
  const server = createApp(root, {
    composeRunner: async (_command, args) => {
      if (args[3] === "config") return { stdout: "api\n", stderr: "" };
      return { stdout: "[]", stderr: "" };
    },
    composeLogSpawner: async () => {
      notifySpawnerStarted?.();
      await spawnerGate;
      spawnedChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "pipe" });
      notifyChildSpawned?.();
      return spawnedChild;
    },
    logger: { info: () => undefined, error: () => undefined },
  }).listen(0, "127.0.0.1");
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  await (await fetchReady(`${base}/api/status`)).arrayBuffer();

  const abortController = new AbortController();
  const request = fetch(`${base}/api/projects/1/compose/logs?service=api`, { signal: abortController.signal }).then(
    () => undefined,
    (error: unknown) => error,
  );
  let spawnerTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      spawnerStarted,
      request.then((result) => { throw new Error("Compose log request ended before spawning", { cause: result }); }),
      new Promise<never>((_resolve, reject) => { spawnerTimeout = setTimeout(() => reject(new Error("Compose log request did not reach the spawner")), 2000); }),
    ]);
  } finally {
    if (spawnerTimeout) clearTimeout(spawnerTimeout);
  }
  abortController.abort();
  assert.equal(((await request) as Error).name, "AbortError");
  releaseSpawner?.();
  await childSpawned;
  assert(spawnedChild);
  if (spawnedChild.exitCode === null) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Compose log process was not cleaned up")), 2000);
    spawnedChild?.once("close", () => { clearTimeout(timer); resolve(); });
  });
});

test("process crashes are logged without suppressing the non-zero exit", async () => {
  const serverModule = pathToFileURL(join(process.cwd(), "dist/src/server.js")).href;
  const script = `import { installCrashLogging } from ${JSON.stringify(serverModule)}; installCrashLogging(); throw new Error("intentional crash");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /CRASH origin=(?:uncaughtException|unhandledRejection)[\s\S]*Error: intentional crash/);
});

test("server startup initializes missing environment and managed config files", async (context) => {
  const codeRoot = await mkdtemp(join(tmpdir(), "owner-config-empty-"));
  const root = join(codeRoot, "owner_config");
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "web-dist"), { recursive: true });
  await mkdir(join(codeRoot, "apps/api"), { recursive: true });
  await mkdir(join(root, "data/local/1/qa"), { recursive: true });
  await writeFile(join(root, "data/projects.yaml"), stringify({ projects: [
    { id: 1, name: "api", conf_dir: "apps/api", files: ["dev.yaml", "nested/worker.ini"] },
  ] }));
  await writeFile(join(root, ".env"), "APP_ENV=staging\n");
  await writeFile(join(root, "web-dist/index.html"), "<div id=\"app\"></div>");
  const server = createApp(root, { logger: { info: () => undefined, error: () => undefined } }).listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const response = await fetchReady(`http://127.0.0.1:${address.port}/api/status`);
  assert.equal(response.status, 200);
  assert.deepEqual((parse(await readFile(join(root, "data/projects.yaml"), "utf8")) as { env: unknown }).env, { current: "staging", options: ["dev", "qa", "staging"] });
  await assert.rejects(readFile(join(root, ".env")), /ENOENT/);
  assert.equal(await readFile(join(root, "data/variables.yaml"), "utf8"), "{}\n");
  for (const path of [
    "data/projects/api--1/baseline/dev.yaml", "data/projects/api--1/baseline/nested/worker.ini",
    "data/projects/api--1/local/staging/dev.yaml", "data/projects/api--1/local/staging/nested/worker.ini",
  ]) assert.equal(await readFile(join(root, path), "utf8"), "");
  await assert.rejects(readFile(join(root, "data/local/1/qa")), /ENOENT/);
});
