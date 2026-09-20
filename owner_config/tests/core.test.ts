import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { composeCommandArgs, createEnvironment, createProject, deleteEnvironment, deleteProject, deleteProjects, ensureOwnerLayout, getComposeDeployment, getGlobalSettings, getProjectConfigs, getProjectDirectory, getSummary, listCodeDirectories, loadProjects, projectDataName, renameEnvironment, runComposeOperation, runOperation, selectProjects, updateGlobalSettings, updateProject, updateProjectPin } from "../src/core.js";
import { mergeConfigFile, mergeStructured, resolveVariables } from "../src/merge.js";
import { diffLinesWithContext, modifiedLines } from "../src/diff.js";
import { codeOpenCommand, directoryOpenCommand, maximizedWindowsOpenCommand, terminalOpenCommand, zedOpenCommand } from "../src/platform.js";
import iconv from "iconv-lite";

async function fixture() {
  const codeRoot = await mkdtemp(join(tmpdir(), "owner-config-"));
  const ownerRoot = join(codeRoot, "owner_config");
  const projects = [
    { id: 101, name: "task-api", tags: ["task", "backend"], conf_dir: "apps/a", compose_file: "apps/a/local-stack.yml", files: ["dev.yaml"] },
    { id: 102, name: "task-api", tags: ["task"], conf_dir: "apps/b", files: ["dev.yaml"] },
    { id: 103, name: "portal", conf_dir: "apps/portal", files: ["dev.yaml"] },
  ];
  await mkdir(join(ownerRoot, "data"), { recursive: true });
  await writeFile(join(ownerRoot, "data/projects.yaml"), stringify({ env: { current: "dev", options: ["dev"] }, projects }));
  for (const project of projects) {
    await mkdir(join(codeRoot, project.conf_dir, "conf"), { recursive: true });
    await writeFile(join(codeRoot, project.conf_dir, "conf/dev.yaml"), stringify({ server: { workers: 4, enabled: false } }));
    if (project.compose_file) await writeFile(join(codeRoot, project.compose_file), "services:\n  api:\n    image: api:1\n");
  }
  return { codeRoot, ownerRoot };
}

test("loads unique ids, permits duplicate names, and keeps only explicit tags", async () => {
  const { ownerRoot } = await fixture();
  const projects = await loadProjects(ownerRoot);
  assert.deepEqual(projects.map((project) => project.id), [101, 102, 103]);
  assert.deepEqual(projects[0].tags, ["task", "backend"]);
  assert.deepEqual(projects[2].tags, []);
  assert.deepEqual(selectProjects(projects, [103, 101]).map((project) => project.id), [101, 103]);
  assert.throws(() => selectProjects(projects, [101, 999]), /unknown project ids/);
  assert.throws(() => selectProjects(projects, [101, 101]), /unknown project ids/);
});

test("rejects duplicate project ids", async () => {
  const { ownerRoot } = await fixture();
  await writeFile(join(ownerRoot, "data/projects.yaml"), stringify({ projects: [
    { id: 1, name: "one", conf_dir: "a", files: [], tags: ["x"] },
    { id: 1, name: "two", conf_dir: "b", files: [], tags: ["y"] },
  ] }));
  await assert.rejects(loadProjects(ownerRoot), /duplicate project id/);
});

test("resolves project roots and direct child directories safely", async () => {
  const { codeRoot, ownerRoot } = await fixture();
  assert.equal(await getProjectDirectory(ownerRoot, 101), join(codeRoot, "apps/a"));
  assert.equal(await getProjectDirectory(ownerRoot, 101, "conf"), join(codeRoot, "apps/a/conf"));
  await assert.rejects(getProjectDirectory(ownerRoot, 101, "conf/nested"), /invalid project child directory/);
  await assert.rejects(getProjectDirectory(ownerRoot, 101, "missing"), /project directory does not exist/);
});

test("creates and deletes projects with their managed data", async () => {
  const { codeRoot, ownerRoot } = await fixture();
  await assert.rejects(createProject(ownerRoot, { name: "new-api", confDir: "apps/new", files: ["dev.yaml"], tags: ["backend"] }), /project directory does not exist/);
  await mkdir(join(codeRoot, "apps/new"), { recursive: true });
  await assert.rejects(createProject(ownerRoot, { name: "new-api", confDir: "apps/new", composeFile: "apps/new", files: ["dev.yaml"], tags: ["backend"] }), /compose file does not exist/);
  await assert.rejects(createProject(ownerRoot, { name: "new-api", confDir: "apps/new", composeFile: "apps/new/missing.yml", files: ["dev.yaml"], tags: ["backend"] }), /compose file does not exist/);
  await writeFile(join(codeRoot, "apps/new/development.stack.yml"), "services: {}\n");
  const id = await createProject(ownerRoot, { name: "new-api", confDir: "apps/new", composeFile: "apps/new/development.stack.yml", files: ["dev.yaml"], tags: ["backend"] });
  assert.equal(id, 104);
  const created = (await loadProjects(ownerRoot)).find((project) => project.id === id);
  assert.equal(created?.name, "new-api");
  assert.equal(created?.composeFile, "apps/new/development.stack.yml");
  assert.equal(await readFile(join(ownerRoot, `data/projects/new-api--${id}/baseline/dev.yaml`), "utf8"), "");
  assert.equal(await readFile(join(ownerRoot, `data/projects/new-api--${id}/local/dev/dev.yaml`), "utf8"), "");
  await deleteProject(ownerRoot, id);
  assert.equal((await loadProjects(ownerRoot)).some((project) => project.id === id), false);
  await assert.rejects(readFile(join(ownerRoot, `data/projects/new-api--${id}/baseline/dev.yaml`)), /ENOENT/);
});

test("creates projects without managed config files", async () => {
  const { codeRoot, ownerRoot } = await fixture();
  await mkdir(join(codeRoot, "apps/no-config"), { recursive: true });
  const id = await createProject(ownerRoot, { name: "no-config", confDir: "apps/no-config", files: [], tags: [] });
  assert.deepEqual((await loadProjects(ownerRoot)).find((project) => project.id === id)?.files, []);
  assert.deepEqual(await getProjectConfigs(ownerRoot, id), []);
});

test("deletes multiple projects and clears their apply locks", async () => {
  const { ownerRoot } = await fixture();
  await ensureOwnerLayout(ownerRoot);
  await updateProjectPin(ownerRoot, 101, true);
  await updateProjectPin(ownerRoot, 103, true);
  await runOperation(ownerRoot, "sync", [101]);
  await runOperation(ownerRoot, "apply", [101]);
  await assert.rejects(deleteProjects(ownerRoot, [101, 101]), /unknown project ids/);
  await assert.rejects(deleteProjects(ownerRoot, [999]), /unknown project ids/);
  await deleteProjects(ownerRoot, [101, 102]);
  assert.deepEqual((await loadProjects(ownerRoot)).map((project) => project.id), [103]);
  await assert.rejects(readFile(join(ownerRoot, "data/projects/task-api--101/baseline/dev.yaml")), /ENOENT/);
  await assert.rejects(readFile(join(ownerRoot, "data/projects/task-api--102/baseline/dev.yaml")), /ENOENT/);
  assert((await getSummary(ownerRoot)).projects.every((project) => project.status === "normal"));
  assert.deepEqual(parse(await readFile(join(ownerRoot, "state/project-pins.yaml"), "utf8")), { project_ids: [103] });
});

test("updates all editable project fields without changing its id", async () => {
  const { codeRoot, ownerRoot } = await fixture();
  await mkdir(join(codeRoot, "apps/renamed"), { recursive: true });
  await writeFile(join(codeRoot, "apps/renamed/compose.dev.yml"), "services: {}\n");
  await mkdir(join(ownerRoot, "data/projects/task-api--101/baseline"), { recursive: true });
  await writeFile(join(ownerRoot, "data/projects/task-api--101/baseline/dev.yaml"), "keep: true\n");
  await updateProjectPin(ownerRoot, 101, true);
  await updateProject(ownerRoot, 101, { name: "renamed-api", confDir: "apps/renamed", composeFile: "apps/renamed/compose.dev.yml", files: ["app.yaml", "worker.ini"], tags: ["service", "backend"] });
  assert.deepEqual((await loadProjects(ownerRoot)).find((project) => project.id === 101), {
    id: 101,
    name: "renamed-api",
    confDir: "apps/renamed",
    composeFile: "apps/renamed/compose.dev.yml",
    files: ["app.yaml", "worker.ini"],
    tags: ["service", "backend"],
  });
  assert.equal((await getSummary(ownerRoot)).projects.find((project) => project.id === 101)?.pinned, true);
  assert.deepEqual(parse(await readFile(join(ownerRoot, "state/project-pins.yaml"), "utf8")), { project_ids: [101] });
  assert.equal(await readFile(join(ownerRoot, "data/projects/renamed-api--101/baseline/dev.yaml"), "utf8"), "keep: true\n");
  await assert.rejects(readFile(join(ownerRoot, "data/projects/task-api--101/baseline/dev.yaml")), /ENOENT/);
  await assert.rejects(updateProject(ownerRoot, 999, { name: "missing", confDir: "apps/missing", files: ["dev.yaml"], tags: [] }), /unknown project id/);
});

test("uses readable project data names and migrates legacy id directories", async () => {
  const { ownerRoot } = await fixture();
  assert.equal(projectDataName({ id: 101, name: " task/api. " }), "task_api--101");
  await mkdir(join(ownerRoot, "data/baseline/101"), { recursive: true });
  await mkdir(join(ownerRoot, "data/local/101/dev"), { recursive: true });
  await writeFile(join(ownerRoot, "data/baseline/101/dev.yaml"), "baseline\n");
  await writeFile(join(ownerRoot, "data/local/101/dev/dev.yaml"), "local\n");
  await ensureOwnerLayout(ownerRoot);
  assert.equal(await readFile(join(ownerRoot, "data/projects/task-api--101/baseline/dev.yaml"), "utf8"), "baseline\n");
  assert.equal(await readFile(join(ownerRoot, "data/projects/task-api--101/local/dev/dev.yaml"), "utf8"), "local\n");
  await assert.rejects(readFile(join(ownerRoot, "data/baseline/101/dev.yaml")), /ENOENT/);
  await assert.rejects(readFile(join(ownerRoot, "data/local/101/dev/dev.yaml")), /ENOENT/);
});

test("legacy migration detects conflicts before moving files", async () => {
  const { ownerRoot } = await fixture();
  await mkdir(join(ownerRoot, "data/baseline/101"), { recursive: true });
  await mkdir(join(ownerRoot, "data/projects/task-api--101/baseline"), { recursive: true });
  await writeFile(join(ownerRoot, "data/baseline/101/a.yaml"), "same\n");
  await writeFile(join(ownerRoot, "data/baseline/101/z.yaml"), "legacy\n");
  await writeFile(join(ownerRoot, "data/projects/task-api--101/baseline/a.yaml"), "same\n");
  await writeFile(join(ownerRoot, "data/projects/task-api--101/baseline/z.yaml"), "current\n");
  await assert.rejects(ensureOwnerLayout(ownerRoot), /migration would overwrite different data/);
  assert.equal(await readFile(join(ownerRoot, "data/baseline/101/a.yaml"), "utf8"), "same\n");
  assert.equal(await readFile(join(ownerRoot, "data/baseline/101/z.yaml"), "utf8"), "legacy\n");
});

test("sync, apply, and restore operate on the selected target only", async () => {
  const { codeRoot, ownerRoot } = await fixture();
  await runOperation(ownerRoot, "sync", [101, 102]);
  await assert.rejects(readFile(join(ownerRoot, "data/projects/portal--103/baseline/dev.yaml")), /ENOENT/);
  await mkdir(join(ownerRoot, "data/projects/task-api--101/local/dev"), { recursive: true });
  await writeFile(join(ownerRoot, "data/projects/task-api--101/local/dev/dev.yaml"), stringify({ server: { workers: 9 } }));
  const output = await runOperation(ownerRoot, "apply", [101]);
  assert.equal(output.length, 1);
  const applied = await readFile(join(codeRoot, "apps/a/conf/dev.yaml"), "utf8");
  assert.match(applied, /workers: 9/);
  await runOperation(ownerRoot, "restore", [101]);
  const restored = await readFile(join(codeRoot, "apps/a/conf/dev.yaml"), "utf8");
  assert.match(restored, /workers: 4/);
});

test("operations accept multiple project ids", async () => {
  const { ownerRoot } = await fixture();
  const output = await runOperation(ownerRoot, "sync", [101, 103]);
  assert.deepEqual(output, ["sync 101/dev.yaml", "sync 103/dev.yaml"]);
  await assert.rejects(readFile(join(ownerRoot, "data/projects/task-api--102/baseline/dev.yaml")), /ENOENT/);
});

test("sync overwrites the baseline even when a local override needs manual updates", async () => {
  const { codeRoot, ownerRoot } = await fixture();
  await ensureOwnerLayout(ownerRoot);
  await runOperation(ownerRoot, "sync", [101]);
  const baselinePath = join(ownerRoot, "data/projects/task-api--101/baseline/dev.yaml");
  await writeFile(join(ownerRoot, "data/projects/task-api--101/local/dev/dev.yaml"), "server:\n  enabled: true\n");
  await writeFile(join(codeRoot, "apps/a/conf/dev.yaml"), "server:\n  workers: 6\n");

  await runOperation(ownerRoot, "sync", [101]);
  assert.equal(await readFile(baselinePath, "utf8"), "server:\n  workers: 6\n");
  await assert.rejects(runOperation(ownerRoot, "apply", [101]), /failed to apply 101\/dev\.yaml from local file .*unknown key at server\.enabled/);
});

test("compose deployment exposes services in stable name order, statuses, and scoped operations", async () => {
  const { codeRoot, ownerRoot } = await fixture();
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner = async (command: string, args: string[], cwd: string) => {
    calls.push({ command, args, cwd });
    if (args.includes("config")) return { stdout: "worker\napi\n", stderr: "" };
    if (args.includes("ps")) return { stdout: `${JSON.stringify({ Service: "api", Publishers: [
      { URL: "0.0.0.0", TargetPort: 3000, PublishedPort: 8080, Protocol: "tcp" },
      { URL: "127.0.0.1", TargetPort: 9000, PublishedPort: 9001, Protocol: "tcp" },
    ] })}\n`, stderr: "" };
    return { stdout: "done\n", stderr: "" };
  };
  assert.deepEqual(await runComposeOperation(ownerRoot, 101, "up", runner), ["done"]);
  await runComposeOperation(ownerRoot, 101, "down", runner);
  await runComposeOperation(ownerRoot, 101, "restart", runner);
  await runComposeOperation(ownerRoot, 101, "up", runner, "api");
  await runComposeOperation(ownerRoot, 101, "down", runner, "api");
  await runComposeOperation(ownerRoot, 101, "restart", runner, "api");
  assert.deepEqual(await getComposeDeployment(ownerRoot, 101, runner), {
    status: "running",
    services: [
      { name: "api", status: "running", ports: [
        { hostIp: "0.0.0.0", targetPort: 3000, publishedPort: 8080, protocol: "tcp" },
        { hostIp: "127.0.0.1", targetPort: 9000, publishedPort: 9001, protocol: "tcp" },
      ] },
      { name: "worker", status: "stopped", ports: [] },
    ],
  });
  assert.deepEqual(calls, [
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "up", "-d"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "down"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "restart"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "config", "--services"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "up", "-d", "api"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "config", "--services"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "stop", "api"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "config", "--services"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "restart", "api"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "config", "--services"], cwd: join(codeRoot, "apps/a") },
    { command: "docker", args: ["compose", "-f", "local-stack.yml", "ps", "--format", "json", "--status", "running"], cwd: join(codeRoot, "apps/a") },
  ]);
  assert.deepEqual(composeCommandArgs("logs", "local-stack.yml"), ["compose", "--ansi", "always", "-f", "local-stack.yml", "logs", "-f", "-n", "200"]);
  assert.deepEqual(composeCommandArgs("logs", "local-stack.yml", "api"), ["compose", "--ansi", "always", "-f", "local-stack.yml", "logs", "-f", "-n", "200", "api"]);
  assert.deepEqual(composeCommandArgs("logs", "local-stack.yml", "api", 1000), ["compose", "--ansi", "always", "-f", "local-stack.yml", "logs", "-f", "-n", "1000", "api"]);
  await assert.rejects(runComposeOperation(ownerRoot, 101, "up", runner, "missing"), /unknown compose service/);
  await assert.rejects(runComposeOperation(ownerRoot, 102, "up", runner), /does not configure a compose file/);
});

test("config views expose baseline, local override, and merged preview", async () => {
  const { ownerRoot } = await fixture();
  await mkdir(join(ownerRoot, "data/projects/task-api--101/baseline"), { recursive: true });
  await mkdir(join(ownerRoot, "data/projects/task-api--101/local/dev"), { recursive: true });
  await writeFile(join(ownerRoot, "data/projects/task-api--101/baseline/dev.yaml"), stringify({ server: { workers: 4, enabled: false } }));
  await writeFile(join(ownerRoot, "data/projects/task-api--101/local/dev/dev.yaml"), stringify({ server: { workers: 9 } }));
  const [view] = await getProjectConfigs(ownerRoot, 101);
  assert.match(view.baseline, /workers: 4/);
  assert.match(view.local || "", /workers: 9/);
  assert.match(view.merged, /workers: 9/);
  assert.match(view.merged, /enabled: false/);
});

test("global settings manage scalar variables and the active environment", async () => {
  const { ownerRoot } = await fixture();
  await writeFile(join(ownerRoot, "data/variables.yaml"), stringify({ HOST: "127.0.0.1", DEBUG: false }));
  assert.deepEqual(await getGlobalSettings(ownerRoot), {
    environment: "dev",
    environments: ["dev"],
    variables: { HOST: "127.0.0.1", DEBUG: false },
    jenkins: { username: "", tokenConfigured: false },
  });
  await createEnvironment(ownerRoot, "inner-test");
  const updated = await updateGlobalSettings(ownerRoot, "inner-test", { PORT: 3306, ENABLED: true });
  assert.equal(updated.environment, "inner-test");
  assert.deepEqual(updated.variables, { PORT: 3306, ENABLED: true });
  assert.deepEqual((parse(await readFile(join(ownerRoot, "data/projects.yaml"), "utf8")) as { env: unknown }).env, { current: "inner-test", options: ["dev", "inner-test"] });
  assert.deepEqual(parse(await readFile(join(ownerRoot, "data/variables.yaml"), "utf8")), { PORT: 3306, ENABLED: true });
  const withJenkins = await updateGlobalSettings(ownerRoot, "inner-test", { PORT: 3306 }, { username: "builder", token: "secret" });
  assert.deepEqual(withJenkins.jenkins, { username: "builder", tokenConfigured: true });
  assert.deepEqual(parse(await readFile(join(ownerRoot, "data/jenkins.yaml"), "utf8")), { username: "builder", token: "secret" });
  assert.deepEqual((await updateGlobalSettings(ownerRoot, "inner-test", {}, { username: "release" })).jenkins, { username: "release", tokenConfigured: true });
  assert.deepEqual((await updateGlobalSettings(ownerRoot, "inner-test", {}, { clearToken: true })).jenkins, { username: "release", tokenConfigured: false });
  await assert.rejects(updateGlobalSettings(ownerRoot, "dev", { BROKEN: 1 }, { token: "bad│token" }), /Token 只能包含无空格的 ASCII 可打印字符/);
  assert.deepEqual(await getGlobalSettings(ownerRoot), { environment: "inner-test", environments: ["dev", "inner-test"], variables: {}, jenkins: { username: "release", tokenConfigured: false } });
  await assert.rejects(updateGlobalSettings(ownerRoot, "../prod", {}), /environment/);
  await assert.rejects(updateGlobalSettings(ownerRoot, "dev", { "BAD-NAME": "x" }), /invalid variable name/);
});

test("creates, renames, and deletes environments across projects", async () => {
  const { ownerRoot } = await fixture();
  assert.deepEqual((await createEnvironment(ownerRoot, "inner-dev")).environments, ["dev", "inner-dev"]);
  await writeFile(join(ownerRoot, "data/projects/task-api--101/local/inner-dev/dev.yaml"), "server:\n  workers: 8\n");
  await updateGlobalSettings(ownerRoot, "inner-dev", {});
  const renamed = await renameEnvironment(ownerRoot, "inner-dev", "staging");
  assert.equal(renamed.environment, "staging");
  assert.deepEqual(renamed.environments, ["dev", "staging"]);
  assert.match(await readFile(join(ownerRoot, "data/projects/task-api--101/local/staging/dev.yaml"), "utf8"), /workers: 8/);
  const deleted = await deleteEnvironment(ownerRoot, "staging");
  assert.equal(deleted.environment, "dev");
  assert.deepEqual(deleted.environments, ["dev"]);
  await assert.rejects(readFile(join(ownerRoot, "data/projects/task-api--101/local/staging/dev.yaml")), /ENOENT/);
  await assert.rejects(renameEnvironment(ownerRoot, "dev", "local"), /cannot be renamed/);
  await assert.rejects(deleteEnvironment(ownerRoot, "dev"), /cannot be deleted/);
});

test("web restore action uses the server restore operation name", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /@click="operateConfig\('restore'\)"[^>]*>恢复<\/el-button>/);
  assert.doesNotMatch(app, /operateConfig\('re'\)/);
});

test("web layout keeps the full-height workbench responsive", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(styles, /html, body, #app \{ min-width: 0; min-height: 720px; \}/);
  assert.match(styles, /\.workspace\.is-project-workspace \{[^}]*padding: 16px 20px 24px/);
  assert.match(styles, /\.project-workbench \{[^}]*height: calc\(100vh - 40px\);[^}]*flex-direction: column/);
  assert.match(styles, /\.workbench-layout \{[^}]*min-height: 0;[^}]*flex: 1/);
  assert.match(styles, /@media \(max-width: 1180px\)[\s\S]*?\.workbench-grid \{ min-height: 720px; }/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.config-workspace-body \{ grid-template-columns: 1fr; }/);
  assert.doesNotMatch(app, /class="project-table"/);
  assert.match(app, /<el-pagination[\s\S]*?class="workbench-project-pagination"/);
});

test("web theme defaults to system and persists explicit modes", async () => {
  const themeModule = await import(pathToFileURL(join(process.cwd(), "web/src/theme.js")).href);
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const classes = new Set<string>();
  const root = {
    dataset: {} as Record<string, string>,
    classList: { toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) },
  };

  assert.equal(themeModule.readTheme(storage), "system");
  assert.equal(themeModule.applyTheme("system", { root, prefersDark: true }), "system");
  assert(classes.has("dark"));
  assert.equal(root.dataset.theme, "system");
  themeModule.applyTheme("light", { root, prefersDark: true });
  assert(!classes.has("dark"));
  assert.equal(themeModule.saveTheme("dark", storage, { root, prefersDark: false }), "dark");
  assert.equal(values.get("owner-config-theme"), "dark");
  assert(classes.has("dark"));
});

test("web page exposes system, light, and dark theme controls", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const main = await readFile(join(process.cwd(), "web/src/main.js"), "utf8");
  const theme = await readFile(join(process.cwd(), "web/src/theme.js"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  const globalSettingsDialog = app.match(/<el-dialog v-model="settingsDialogOpen"[\s\S]*?<\/el-dialog>/)?.[0] || "";
  assert.match(theme, /跟随系统[\s\S]*白天[\s\S]*夜间/);
  assert.match(app, /<el-popover trigger="hover" placement="bottom"[^>]*popper-class="settings-popover">[\s\S]*?class="settings-menu-trigger"[^>]*:icon="SettingsIcon"[^>]*aria-label="设置"/);
  const settingsMenu = app.match(/<div class="settings-menu"[\s\S]*?<\/div>/)?.[0] || "";
  assert.equal(settingsMenu.match(/class="settings-menu-item"/g)?.length, 3);
  assert.match(settingsMenu, /:icon="Palette">主题<[\s\S]*?:icon="ImageIcon" @click="openBackgroundSettings">背景<[\s\S]*?:icon="SlidersHorizontal" @click="openSettings">参数/);
  assert.match(app, /<el-dropdown trigger="click" placement="bottom-start" popper-class="theme-dropdown" @command="updateTheme">/);
  assert.match(app, /<el-dropdown-menu aria-label="主题模式">[\s\S]*?<el-dropdown-item v-for="option in themeOptions"[^>]*:command="option\.value"[^>]*:class="\{ 'is-active': theme === option\.value \}"[\s\S]*?<Check v-if="theme === option\.value"/);
  assert.doesNotMatch(app, /themeDialogOpen|<el-radio/);
  assert.doesNotMatch(globalSettingsDialog, /主题|theme/);
  assert.match(app, /addEventListener\("change", handleSystemThemeChange\)/);
  assert.match(app, /removeEventListener\("change", handleSystemThemeChange\)/);
  assert(main.indexOf("applyTheme(readTheme())") < main.indexOf("createApp(App)"));
  assert.match(main, /element-plus\/theme-chalk\/dark\/css-vars\.css/);
  assert.doesNotMatch(main, /framebase/);
  for (const component of ["ElDropdown", "ElDropdownItem", "ElDropdownMenu", "ElIcon"]) assert.match(main, new RegExp(`\\b${component}\\b`));
  assert.doesNotMatch(main, /\bElRadio(?:Button|Group)?\b/);
  assert.match(styles, /\.theme-dropdown \.el-dropdown-menu__item\.is-active \{[^}]*color: var\(--accent\)/);
  assert.match(styles, /\.settings-popover\.el-popper \{ width: max-content !important; min-width: 0;/);
  assert.match(styles, /html\.dark \{/);
});

test("web light and dark modes use dedicated themes with one shared background", async () => {
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  const viteConfig = await readFile(join(process.cwd(), "vite.config.ts"), "utf8");
  const light = styles.slice(styles.indexOf(":root {"), styles.indexOf("html.dark {"));
  const dark = styles.slice(styles.indexOf("html.dark {"), styles.indexOf("* { box-sizing"));

  assert.match(light, /--theme-bg-image: url\("\/api\/background"\)/);
  assert.match(light, /--page-bg: #edf1f6;[\s\S]*--surface-base: rgb\(246 248 251 \/ 72%\);[\s\S]*--surface-window: rgb\(255 255 255 \/ 72%\);[\s\S]*--dialog-bg: rgb\(250 252 255 \/ 88%\);[\s\S]*--surface-solid: rgb\(252 253 255 \/ 78%\);[\s\S]*--accent: #007aff;/);
  assert.doesNotMatch(dark, /--theme-bg-image/);
  assert.match(dark, /--page-bg: #101114;[\s\S]*--surface-base: rgb\(28 28 30 \/ 72%\);[\s\S]*--surface-window: rgb\(36 36 38 \/ 76%\);[\s\S]*--dialog-bg: rgb\(44 44 46 \/ 90%\);[\s\S]*--surface-solid: rgb\(42 42 44 \/ 78%\);[\s\S]*--accent: #0a84ff;[\s\S]*--signal: #30d158;[\s\S]*--warm: #ff9f0a;[\s\S]*--danger: #ff453a;/);
  for (const variable of ["surface", "surface-solid", "surface-raised", "soft-bg", "code-bg", "log-bg", "el-bg-color", "el-bg-color-overlay", "el-fill-color-blank"]) {
    assert.match(light, new RegExp(`--${variable}: rgb\\([^;]+ / \\d+%\\);`));
    assert.match(dark, new RegExp(`--${variable}: rgb\\([^;]+ / \\d+%\\);`));
  }
  assert.match(styles, /html:not\(\.dark\) \.shell::before \{[^}]*animation: none/);
  assert.match(styles, /html:not\(\.dark\) \.brand-mark::after \{ display: none; }/);
  assert.match(styles, /html:not\(\.dark\) \.el-dialog,[^}]*backdrop-filter: saturate\(1\.18\) blur\(28px\)/);
  assert.match(styles, /html:not\(\.dark\) body \{[\s\S]*"PingFang SC"[\s\S]*-webkit-font-smoothing: antialiased/);
  assert.match(styles, /html:not\(\.dark\) \.workbench-project-nav \{[\s\S]*backdrop-filter: saturate\(1\.12\) blur\(22px\)/);
  assert.match(styles, /html:not\(\.dark\) \.project-workbench \{[\s\S]*background: rgb\(244 247 251 \/ 54%\);[\s\S]*backdrop-filter: saturate\(1\.12\) blur\(18px\)/);
  assert.match(styles, /html:not\(\.dark\) \.workbench-project-item\.is-active::before \{[^}]*background: var\(--accent\)/);
  assert.match(styles, /html:not\(\.dark\) \.el-button\.el-button--primary[^}]*background: var\(--accent\)/);
  assert.match(styles, /html:not\(\.dark\) \.config-tabs \.el-tabs__item\.is-active \{[^}]*font-weight: 650/);
  assert.match(styles, /html\.dark body \{[^}]*animation: none;[^}]*-webkit-font-smoothing: antialiased/);
  assert.match(styles, /html\.dark \.shell::before \{[^}]*animation: none/);
  assert.match(styles, /html\.dark \.brand-mark::after \{ display: none; }/);
  assert.match(styles, /html\.dark \.project-workbench \{[^}]*background: rgb\(28 28 30 \/ 66%\);[^}]*backdrop-filter: saturate\(1\.12\) blur\(24px\)/);
  assert.match(styles, /html\.dark \.el-dialog, html\.dark \.el-popper\.is-light,[^}]*backdrop-filter: saturate\(1\.1\) blur\(28px\)/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*html:not\(\.dark\) \.workbench-pane\.is-collapsed \{ min-height: auto; flex-basis: auto; }[\s\S]*html:not\(\.dark\) \.workbench-pane-heading-controls \{ display: grid/);
  assert.match(styles, /@keyframes light-pane-enter[\s\S]*@keyframes light-content-enter/);
  assert.match(viteConfig, /cssMinify: false,[\s\S]*cssTarget: "chrome107"/);
  const cssAsset = (await readdir(join(process.cwd(), "web-dist/assets"))).find((name) => name.endsWith(".css"));
  assert(cssAsset);
  const builtStyles = await readFile(join(process.cwd(), "web-dist/assets", cssAsset), "utf8");
  assert.match(builtStyles, /backdrop-filter: saturate\(1\.18\) blur\(30px\)/);
  assert.match(styles, /\.project-workbench \{[^}]*background: var\(--surface-base\)/);
  assert.match(styles, /\.workbench-pane \{[^}]*background: var\(--surface-window\)/);
  assert.match(styles, /\.workspace-logs \{[^}]*background: var\(--surface-window\)/);
  assert.match(styles, /\.el-dialog \{[^}]*background: var\(--dialog-bg\)/);
  assert.match(styles, /\.el-popper\.is-light, \.el-select__popper\.el-popper \{[^}]*background: var\(--dialog-bg\)/);
  assert.match(styles, /\.workbench-heading \{[^}]*background: var\(--surface-raised\)/);
  assert.match(styles, /\.workbench-project-nav \{[^}]*background: var\(--soft-bg\)/);
  assert.match(styles, /html\.dark \.project-workbench \{[^}]*border-color: rgb\(255 255 255 \/ 16%\)/);
  assert.match(styles, /html\.dark \.workbench-project-nav \{[^}]*background:/);
  assert.match(styles, /@keyframes ambient-drift[\s\S]*@keyframes signal-pulse[\s\S]*@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.brand-mark[\s\S]*\.status-beacon\.is-live/);
});

test("web theme background is a valid full-HD PNG asset", async () => {
  const image = await readFile(join(process.cwd(), "web/public/bg.png"));
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.readUInt32BE(16), 1920);
  assert.equal(image.readUInt32BE(20), 1080);
  assert(image.length > 100_000);
});

test("web project creation and current-project deletion stay in the navigator", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /class="workbench-nav-actions"[\s\S]*?:icon="Plus"[^>]*@click="createDialogOpen = true"[\s\S]*?:icon="Delete"[^>]*:disabled="!workspaceProject"[^>]*@click="removeWorkspaceProject"/);
  assert.match(app, /async function removeWorkspaceProject\(\)[\s\S]*?const ids = \[project\.id];[\s\S]*?fetch\("\/api\/projects", {[\s\S]*?method: "DELETE"[\s\S]*?body: JSON\.stringify\(\{ ids }\)/);
  assert.match(app, /async function removeWorkspaceProject\(\)[\s\S]*?closeProjectWorkspace\(\);[\s\S]*?loadProjectPage\(\{ selectFirst: true }\)/);
  assert.match(app, /const workspaceProjectPageSize = ref\(10\);[\s\S]*?const workspaceProjectPageSizes = \[10, 20, 50, 100];/);
  assert.match(app, /v-model:current-page="workspaceProjectPage"[\s\S]*?v-model:page-size="workspaceProjectPageSize"[\s\S]*?:page-sizes="workspaceProjectPageSizes"[\s\S]*?:total="summary\?\.total \|\| 0"[\s\S]*?@current-change="handleProjectPageChange"[\s\S]*?@size-change="handleProjectPageSizeChange"/);
  assert.match(app, /const workspaceProjects = computed\(\(\) => summary\.value\?\.projects \|\| \[\]\)/);
  assert.match(app, /async function loadProjectPage[\s\S]*?new URLSearchParams\(\{[\s\S]*?page: String\(workspaceProjectPage\.value\)[\s\S]*?pageSize: String\(workspaceProjectPageSize\.value\)[\s\S]*?fetch\(`\/api\/status\?\$\{parameters}`\)/);
  assert.doesNotMatch(app, /type="selection"|deleteProjectIds|updateDeleteSelection/);
});

test("web project pins use the backend before reloading the first server page", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /async function togglePinnedProject\(project\)[\s\S]*?fetch\(`\/api\/projects\/\$\{project\.id}\/pin`[\s\S]*?body: JSON\.stringify\(\{ pinned: !project\.pinned }\)[\s\S]*?workspaceProjectPage\.value = 1;[\s\S]*?await loadProjectPage\(\)/);
  assert.match(app, /class="workbench-project-pin workbench-pin-button"[\s\S]*?:aria-pressed="project\.pinned"[\s\S]*?@click="togglePinnedProject\(project\)/);
  assert.doesNotMatch(app, /project-pins|pinnedProjectIds|owner-config-pinned-projects/);
  assert.match(styles, /\.workbench-project-pin\.el-button \{[^}]*top: 3px;[^}]*right: 3px;[^}]*opacity: 0/);
  assert.match(styles, /\.workbench-project-item:hover \.workbench-project-pin\.el-button[^}]*opacity: 1;[^}]*pointer-events: auto/);
  assert.match(styles, /\.workbench-nav-collapse\.el-button \.lucide-pin, \.workbench-project-pin\.el-button\.is-pinned \.lucide-pin \{ fill: currentColor; }/);
});

test("web config operations target one project inside the unified workbench", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /async function operateConfig\(operation\)[\s\S]*?body: JSON\.stringify\(\{ operation, ids: \[configProject\.value\.id] }\)/);
  assert.match(app, /async function openProjectWorkspace\(project\)[\s\S]*?configProject\.value = current;[\s\S]*?deploymentProject\.value = current;[\s\S]*?loadProjectConfigs\(current\)[\s\S]*?loadComposeDeployment\(current\)/);
  assert.match(app, /class="workbench-grid"[\s\S]*?class="workbench-pane config-workbench-pane"[\s\S]*?class="workbench-pane deployment-workbench-pane"[\s\S]*?class="workspace-logs"/);
  assert.match(app, /class="workbench-heading-actions"[\s\S]*?class="settings-menu-trigger"[\s\S]*?@click="openSettings">参数/);
  assert.doesNotMatch(app, /class="workbench-environment"|>全局参数设置</);
  assert.match(app, /class="workbench-pane-actions"[\s\S]*?operateConfig\('sync'\)">备份<[\s\S]*?operateConfig\('restore'\)">恢复<[\s\S]*?operateConfig\('apply'\)">应用/);
  assert.doesNotMatch(app, /configDialogOpen|deploymentDialogOpen|switchConfigToDeployment|switchDeploymentToConfig/);
});

test("web workbench keeps project navigation, config files, and deployment controls visible together", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /class="workbench-project-nav"[\s\S]*?class="workbench-project-list"[\s\S]*?openProjectWorkspace\(project\)/);
  assert.match(app, /class="config-file-list"[\s\S]*?v-for="file in configFiles"[\s\S]*?selectedConfigName = file\.name/);
  assert.match(app, /class="deployment-target-toolbar"[\s\S]*?v-model="workspaceSelectedService"[\s\S]*?class="deployment-operation-toolbar"[\s\S]*?>启动<[\s\S]*?>停止<[\s\S]*?>重启<[\s\S]*?>日志/);
  assert.match(styles, /\.workbench-layout \{[^}]*grid-template-columns: var\(--project-nav-width, 224px\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.workbench-grid \{[^}]*display: flex;[^}]*flex-direction: column/);
  assert.match(styles, /\.config-workspace-body \{[^}]*grid-template-columns: 210px minmax\(0, 1fr\)/);
  assert.match(styles, /\.config-tabs \.el-tabs__nav-scroll \{[^}]*justify-content: flex-start/);
  assert.match(app, /<el-tab-pane label="模板配置" name="baseline">[\s\S]*?<el-tab-pane label="本地配置" name="local">[\s\S]*?<el-tab-pane label="合并预览" name="merged">/);
  assert.match(app, /<section[\s\S]*?v-if="workspaceProject\.files\.length"[\s\S]*?class="workbench-pane config-workbench-pane"/);
  assert.match(app, /const visibleWorkbenchPanes = computed\(\(\) => workspaceProject\.value \? \[[\s\S]*?workspaceProject\.value\.files\.length \? \["config"\][\s\S]*?workspaceProject\.value\.composeFile \? \["deployment"\]/);
  assert.match(app, /async function loadProjectConfigs\(project[\s\S]*?if \(!project\.files\.length\) {[\s\S]*?configLoading\.value = false;[\s\S]*?return;/);
  assert.match(app, /const activeConfigTab = ref\("baseline"\);[\s\S]*?const previewContextCollapsed = ref\(true\);/);
  assert.match(app, /v-if="isWorkbenchPaneExpanded\('config'\) && activeConfigTab === 'merged'"[\s\S]*?previewContextCollapsed = !previewContextCollapsed[\s\S]*?previewContextCollapsed \? '展开' : '折叠'[\s\S]*?operateConfig\('sync'\)">备份/);
  assert.match(app, /const visiblePreviewLines = computed\(\(\) => previewContextCollapsed\.value[\s\S]*?diffLinesWithContext\(previewLines\.value\)[\s\S]*?: previewLines\.value\);/);
  assert.match(app, /class="diff-line" :class="`is-\$\{line\.kind}`"[\s\S]*?class="line-content">\{\{ line\.text \|\| ' ' }}/);
  assert.match(styles, /\.diff-line\.is-gap \{[^}]*grid-template-columns: 1fr;[^}]*text-align: center/);
  assert.match(styles, /\.diff-line\.is-gap \.line-number, \.diff-line\.is-gap \.line-marker \{ display: none; }/);
});

test("web workbench keeps a wrapping module switcher above the expanded pane", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /const expandedWorkbenchPanes = ref\(new Set\(\)\);/);
  assert.match(app, /import \{[^}]*ElTooltip[^}]*\} from "element-plus";/);
  assert.match(app, /const activeWorkbenchPane = computed\(\(\) => visibleWorkbenchPanes\.value\.find\(\(name\) => expandedWorkbenchPanes\.value\.has\(name\)\) \|\| ""\);/);
  assert.match(app, /function closeProjectWorkspace\(\)[\s\S]*?expandedWorkbenchPanes\.value = new Set\(\);/);
  assert.match(app, /function openWorkbenchPane\(name\)[\s\S]*?expandedWorkbenchPanes\.value = new Set\(\[name]\)[\s\S]*?name === "jenkins"/);
  assert.match(app, /function toggleWorkbenchPane\(name\)[\s\S]*?expandedWorkbenchPanes\.value\.has\(name\)[\s\S]*?expandedWorkbenchPanes\.value = new Set\(\);[\s\S]*?openWorkbenchPane\(name\)/);
  assert.match(app, /function toggleWorkbenchPaneFromHeading\(event, name\)[\s\S]*?event\.composedPath\(\)\.some\(\(target\) => target instanceof Element && target\.matches\(interactiveSelector\)\)[\s\S]*?toggleWorkbenchPane\(name\)/);
  assert.equal(app.match(/@click\.stop="toggleWorkbenchPane\('(?:directories|config|deployment|jenkins)'\)"/g)?.length, 4);
  assert.equal(app.match(/@click="toggleWorkbenchPaneFromHeading\(\$event, '(?:directories|config|deployment|jenkins)'\)"/g)?.length, 4);
  assert.match(app, /function workbenchPaneClasses\(name\)[\s\S]*?activeWorkbenchPane\.value === name \? \{ "is-active-expanded": true } : \{ "is-collapsed": true }/);
  assert.match(app, /class="workbench-grid"[\s\S]*?'has-expanded-pane': activeWorkbenchPane/);
  assert.match(app, /v-if="activeWorkbenchPane" class="workbench-pane-switcher" aria-label="模块切换"[\s\S]*?<el-tooltip v-for="item in visibleWorkbenchPaneItems"[^>]*:content="item\.label"[^>]*placement="bottom"[\s\S]*?:class="\{ 'is-selected': activeWorkbenchPane === item\.name \}"[\s\S]*?:aria-pressed="activeWorkbenchPane === item\.name"[\s\S]*?@click="openWorkbenchPane\(item\.name\)"/);
  assert.match(app, /directories: \{ name: "directories", label: "详情", icon: FolderOpened \}[\s\S]*?config: \{ name: "config", label: "配置", icon: Document \}[\s\S]*?deployment: \{ name: "deployment", label: "服务", icon: VideoPlay \}[\s\S]*?jenkins: \{ name: "jenkins", label: "Jenkins 部署", icon: Hammer \}/);
  assert.doesNotMatch(app, /workbench-edge-trigger|is-edge-pane|is-before-expanded|is-after-expanded|workbenchPaneStyle|workbenchEdgeOffsets/);
  assert.equal(app.match(/:class="workbenchPaneClasses\('(?:directories|config|deployment|jenkins)'\)"/g)?.length, 4);
  assert.match(app, /class="workbench-pane-heading-main"[\s\S]*?toggleWorkbenchPane\('directories'\)[\s\S]*?<h2>详情<\/h2>/);
  assert.match(app, /class="workbench-pane-heading-main"[\s\S]*?toggleWorkbenchPane\('config'\)[\s\S]*?<h2>配置<\/h2>/);
  assert.match(app, /<template v-if="!isWorkbenchPaneExpanded\('directories'\)">[\s\S]*?openProjectDirectory\(workspaceProject\)">打开<[\s\S]*?openProjectTerminal\(workspaceProject\)">终端打开<[\s\S]*?openProjectCode\(workspaceProject\)">VS Code 打开<[\s\S]*?openProjectZed\(workspaceProject\)">Zed 打开<[\s\S]*?aria-label="编辑项目"/);
  assert.doesNotMatch(app, /workbenchPaneWeights|startWorkbenchResize|handleWorkbenchResizeKeydown|workbench-pane-resizer/);
  assert.match(styles, /\.workbench-pane \{[^}]*box-shadow: var\(--shadow-window\);[^}]*transition:[^}]*transform \.2s ease;[^}]*flex: 1 1 0;[^}]*flex-direction: column/);
  assert.match(styles, /\.workbench-grid\.has-expanded-pane \.workbench-pane:not\(\.is-active-expanded\) \{ display: none; }/);
  assert.match(styles, /\.workbench-pane-switcher \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(auto-fill, 34px\);[^}]*grid-auto-rows: 34px;[^}]*gap: 5px/);
  assert.match(styles, /\.workbench-pane-switch \{[^}]*width: 34px;[^}]*height: 34px/);
  assert.match(styles, /\.workbench-pane-switch \.el-icon \{[^}]*width: 16px;[^}]*height: 16px;[^}]*font-size: 16px/);
  assert.match(styles, /\.workbench-pane-switch\.is-selected \{[^}]*border-color:[^}]*background: var\(--accent-soft\);[^}]*color: var\(--accent-strong\)/);
  assert.match(styles, /\.workbench-grid\.has-expanded-pane \.workbench-pane\.is-active-expanded \{[^}]*position: relative;[^}]*flex: 1 1 0/);
  assert.doesNotMatch(styles, /workbench-edge-trigger|is-edge-pane|is-before-expanded|is-after-expanded|workbench-edge-offset/);
  assert.match(styles, /\.workbench-pane-heading \{[^}]*cursor: pointer/);
  assert.match(styles, /\.workbench-pane-heading \.el-button \{ font-weight: 700; }/);
  const jenkinsHeading = app.match(/<div class="workbench-pane-heading jenkins-pane-heading"[\s\S]*?<div v-show="isWorkbenchPaneExpanded\('jenkins'\)"/)?.[0] || "";
  assert.match(jenkinsHeading, /class="workbench-pane-heading-controls"[\s\S]*?<el-button :icon="Hammer"[\s\S]*?>构建<\/el-button>/);
  assert.doesNotMatch(jenkinsHeading, /v-if="[^\"]*isWorkbenchPaneExpanded\('jenkins'\)|type="primary"/);
  assert.match(styles, /\.workbench-pane-heading-main > div > span, \.workspace-logs-heading > div > span \{[^}]*font: 12px ui-monospace, monospace/);
  assert.doesNotMatch(styles, /\.workbench-pane-heading span/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.workbench-pane-heading-controls \{ width: 100%; flex-wrap: wrap; }[\s\S]*?\.workbench-pane-heading-controls \.el-button \{ flex: 1 1 auto; }/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.project-directory-actions \{ width: 100%; flex-wrap: wrap; }/);
});

test("web workbench config viewer fills its pane", async () => {
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(styles, /\.config-tabs \.el-tabs__content, \.config-tabs \.el-tab-pane \{[^}]*min-height: 0;[^}]*flex: 1/);
  assert.match(styles, /\.config-code, \.diff-code \{ height: auto; min-height: 0;[^}]*flex: 1/);
});

test("web apply and service start actions use the default button color", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /<el-button :loading="configOperationBusy === 'apply'" @click="operateConfig\('apply'\)">应用<\/el-button>/);
  assert.match(app, /<el-button :icon="VideoPlay" :loading="composeBusyTarget === `\$\{workspaceServiceTarget \|\| '\*'}:up`" @click="runCompose\(deploymentProject, 'up', workspaceServiceTarget\)">启动<\/el-button>/);
  assert.doesNotMatch(app, /<el-button type="primary"[^>]*operateConfig\('apply'\)/);
  assert.doesNotMatch(app, /<el-button type="primary"[^>]*workspaceServiceTarget/);
});

test("web parameters open from the settings menu without leaving the workbench", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /const settingsDialogOpen = ref\(false\);/);
  assert.match(app, /async function openSettings\(\) {[\s\S]*?settingsDialogOpen\.value = true;[\s\S]*?await loadSettings\(\)/);
  assert.match(app, /class="settings-menu"[\s\S]*?@click="openSettings">参数/);
  assert.match(app, /<el-dialog v-model="settingsDialogOpen" title="参数"[^>]*align-center[\s\S]*?class="settings-label">当前环境[\s\S]*?class="variables-table"[\s\S]*?@click="saveSettings">保存参数/);
  assert.match(app, /<section class="project-workbench">[\s\S]*?<template v-if="workspaceProject">[\s\S]*?<div class="workbench-grid"[\s\S]*?<div v-else class="workbench-unselected"><span>未选择项目<\/span><\/div>/);
  assert.doesNotMatch(app, /<template v-if="!workspaceProject">|<section v-else class="project-workbench">/);
});

test("web background settings preview, download, and replace supported image formats", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /const backgroundDialogOpen = ref\(false\);[\s\S]*?const backgroundUrl = computed\(\(\) => `\/api\/background\?v=\$\{backgroundVersion\.value}`\)/);
  assert.match(app, /async function replaceBackgroundImage\(event\)[\s\S]*?new Set\(\["image\/png", "image\/jpeg", "image\/webp", "image\/gif", "image\/avif"\]\)[\s\S]*?fetch\("\/api\/background", \{[\s\S]*?method: "PUT"[\s\S]*?document\.documentElement\.style\.setProperty\("--theme-bg-image"/);
  assert.match(app, /async function downloadBackgroundImage\(\)[\s\S]*?fetch\("\/api\/background\?download=1"[\s\S]*?response\.headers\.get\("x-background-filename"\)/);
  assert.match(app, /<el-dialog v-model="backgroundDialogOpen" title="背景"[^>]*>[\s\S]*?class="background-preview"[\s\S]*?:src="backgroundUrl"[\s\S]*?推荐分辨率 1920 x 1080，最大 20 MB[\s\S]*?accept="image\/png,image\/jpeg,image\/webp,image\/gif,image\/avif"[\s\S]*?:icon="Download"[^>]*>下载<[\s\S]*?:icon="Upload"[^>]*>更换/);
  assert.match(styles, /\.background-preview \{[^}]*aspect-ratio: 16 \/ 9/);
});

test("web config and compose files are read-only", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const server = await readFile(join(process.cwd(), "src/server.ts"), "utf8");
  assert.doesNotMatch(app, /openConfigFileEditor|configFileDialogOpen/);
  assert.doesNotMatch(app, /saveConfigBaseline|configs\/baseline/);
  assert.match(app, /<el-tab-pane label="模板配置" name="baseline">[\s\S]*?<pre class="config-code">\{\{ selectedConfig\.baseline }}/);
  assert.match(app, /<el-tab-pane label="本地配置" name="local">[\s\S]*?<pre class="config-code">\{\{ selectedConfig\.local \?\? "" }}/);
  assert.doesNotMatch(app, /saveConfigFile|openComposeFile|saveComposeFile|编辑文件|compose\/file/);
  assert.doesNotMatch(server, /configs\/baseline|compose\/file|updateProjectConfig|updateProjectBaseline|updateComposeFile/);
  for (const label of ["模板配置", "本地配置"]) {
    const pane = app.match(new RegExp(`<el-tab-pane label="${label}"[^>]*>[\\s\\S]*?<\\/el-tab-pane>`))?.[0] || "";
    assert.doesNotMatch(pane, /<el-input/);
  }
});

test("every web dialog supports backdrop and close-icon dismissal with a footer hint", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const dialog = await readFile(join(process.cwd(), "web/src/WindowDialog.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  const dialogs = [...app.matchAll(/<el-dialog\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(dialogs.length, 7);
  assert.match(app, /import ElDialog from "\.\/WindowDialog\.vue";/);
  for (const dialog of dialogs) {
    assert.match(dialog, /:close-on-click-modal="true"/);
    assert.match(dialog, /\bshow-close\b/);
  }
  assert.match(dialog, /:show-close="false"/);
  assert.match(dialog, /:fullscreen="fullscreen"[\s\S]*?align-center[\s\S]*?:show-close="false"/);
  assert.match(dialog, /class="window-dialog-control is-close"[\s\S]*?:icon="Close"[\s\S]*?@click\.stop="close"/);
  assert.match(styles, /\.window-dialog\.el-dialog:not\(\.is-fullscreen\) \{[^}]*max-height: min\(90vh, 820px\);[^}]*margin: auto;[^}]*flex-direction: column/);
  assert.match(styles, /\.window-dialog\.el-dialog:not\(\.is-fullscreen\) \.el-dialog__body \{[^}]*min-height: 0;[^}]*overflow: auto/);
  assert.equal(app.match(/class="dialog-close-hint">点击任意空白区域关闭<\/small>/g)?.length, dialogs.length);
  assert.doesNotMatch(app, /v-model="(?:configDialogOpen|deploymentDialogOpen|composeLogsOpen)"/);
});

test("web project forms select and submit an exact compose file", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /fileEntries\.value = result\.files/);
  assert.match(app, /function chooseComposeFile\(path\)[\s\S]*?project\.composeFile = path/);
  assert.match(app, /const initialPath = targetName\.endsWith\("compose"\) \? composeParent \|\| projectDirectory : projectDirectory;/);
  assert.match(app, /body: JSON\.stringify\(\{[\s\S]*?composeFile: (?:editedProject|newProject)\.value\.composeFile/);
  assert.match(app, /v-for="entry in isDirectoryFileTarget\(\) \? fileEntries : \[\]"/);
  assert.equal(app.match(/<el-form-item label="项目目录"/g)?.length, 2);
  assert.doesNotMatch(app, /<el-form-item label="配置目录"/);
  assert.doesNotMatch(app, /composeDir/);
});

test("web project forms select config files relative to the project directory", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /browseProjectDirectory\('new-files'\)/);
  assert.match(app, /browseProjectDirectory\('edit-files'\)/);
  assert.match(app, /function chooseProjectConfigFile\(path\)[\s\S]*?path\.startsWith\(prefix\)[\s\S]*?const relativePath = path\.slice\(prefix\.length\)/);
  assert.match(app, /if \(!project\.files\.includes\(relativePath\)\) project\.files\.push\(relativePath\)/);
  assert.match(app, /directoryTarget\.endsWith\('files'\) \? '选择配置文件'/);
});

test("web subproject pane opens project roots and nested directories in Explorer, Terminal, VS Code, or Zed", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /function projectSubdirectories\(project\)[\s\S]*?file\.replace\(\/\\\\\/g, "\/"\)\.split\("\/"\)[\s\S]*?new Set\(directories\)/);
  assert.match(app, /data-workbench-pane="directories"[\s\S]*?<h2>详情<\/h2>[\s\S]*?v-for="item in workspaceDirectories"[\s\S]*?openProjectDirectory\(workspaceProject, item\.directory\)[\s\S]*?openProjectTerminal\(workspaceProject, item\.directory\)[\s\S]*?openProjectCode\(workspaceProject, item\.directory\)[\s\S]*?openProjectZed\(workspaceProject, item\.directory\)/);
  assert.match(app, /async function openProjectTerminal\(project, directory = ""\)[\s\S]*?\/open-terminal[\s\S]*?body: JSON\.stringify\(\{ directory \}\)/);
  assert.match(app, /async function openProjectCode\(project, directory = ""\)[\s\S]*?\/open-vscode[\s\S]*?body: JSON\.stringify\(\{ directory \}\)/);
  assert.match(app, /async function openProjectZed\(project, directory = ""\)[\s\S]*?\/open-zed[\s\S]*?body: JSON\.stringify\(\{ directory \}\)/);
  assert.doesNotMatch(app, /expandedProjectDirectoryIds|toggleProjectDirectories/);
});

test("web project forms show selected tags and files beside aligned pickers", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /const newProject = ref\(\{ name: "", confDir: "", composeFile: "", jenkinsJobUrl: "", tags: \[\], files: \[\] }\)/);
  assert.match(app, /tags: newProject\.value\.tags\.map\([\s\S]*?files: newProject\.value\.files\.map\(/);
  assert.equal(app.match(/class="project-value-list tag-value-list"/g)?.length, 2);
  assert.equal(app.match(/class="project-value-list project-file-list"/g)?.length, 2);
  assert.equal(app.match(/class="project-tag-picker" popper-class="project-tag-dropdown" multiple filterable allow-create default-first-option placeholder="添加 Tag"/g)?.length, 2);
  assert.equal(app.match(/<template #tag="\{ data }"><span v-if="data\.length" class="project-tag-input-placeholder">添加 Tag<\/span><\/template>/g)?.length, 2);
  assert.doesNotMatch(app, /collapse-tags/);
  assert.equal(app.match(/<el-option v-for="tag in summary\?\.tags \|\| \[\]"/g)?.length, 2);
  assert.match(app, /function removeProjectTag\(project, tag\)[\s\S]*?project\.tags = project\.tags\.filter/);
  assert.match(app, /function removeProjectFile\(project, file\)[\s\S]*?project\.files = project\.files\.filter/);
  assert.equal(app.match(/class="project-form-picker"/g)?.length, 6);
  assert.equal(app.match(/class="project-form-picker" @click="browseProjectDirectory\('[^']+-conf'\)">选择目录/g)?.length, 2);
  assert.equal(app.match(/class="project-form-picker" @click="browseProjectDirectory\('[^']+-(?:compose|files)'\)">选择文件/g)?.length, 4);
  assert.equal(app.match(/<el-form-item label="配置文件">/g)?.length, 2);
  assert.doesNotMatch(app, /<el-form-item label="配置文件" required>/);
  assert.match(app, /:disabled="!newProject\.name\.trim\(\) \|\| !newProject\.confDir\.trim\(\)" @click="createNewProject">创建/);
  assert.match(app, /:disabled="!editedProject\.name\.trim\(\) \|\| !editedProject\.confDir\.trim\(\)" @click="saveEditedProject">保存/);
  assert.match(styles, /\.project-form-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) 136px/);
  assert.match(styles, /\.project-form-picker \{ width: 100%; }/);
  assert.match(styles, /\.project-tag-dropdown, \.project-tag-dropdown \.el-select-dropdown \{ background: var\(--dialog-bg\) !important; }/);
  assert.match(styles, /\.project-tag-dropdown \{ z-index: 10000 !important; }/);
  assert.match(styles, /\.project-tag-picker:focus-within \.project-tag-input-placeholder \{ display: none; }/);
  assert.doesNotMatch(app, /多个 tag 使用逗号分隔|每行一个文件，或使用逗号分隔|>浏览<\/el-button>/);
});

test("web deployment workbench exposes scoped service operations and logs", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /class="workbench-project-list"[\s\S]*?@click="openProjectWorkspace\(project\)"/);
  assert.match(app, /class="deployment-target-toolbar"[\s\S]*?aria-label="操作目标"[\s\S]*?runCompose\(deploymentProject, 'up', workspaceServiceTarget\)[\s\S]*?runCompose\(deploymentProject, 'down', workspaceServiceTarget\)[\s\S]*?runCompose\(deploymentProject, 'restart', workspaceServiceTarget\)[\s\S]*?openComposeLogs\(deploymentProject, workspaceServiceTarget\)/);
  const serviceTable = app.match(/<el-table\s+v-loading="deploymentLoading"[\s\S]*?class="service-table"[\s\S]*?<\/el-table>/)?.[0] || "";
  assert.match(serviceTable, /:data="deploymentServices"[\s\S]*?:row-class-name="serviceRowClassName"[\s\S]*?@row-click="selectWorkspaceService\(\$event\.name\)"/);
  assert.doesNotMatch(serviceTable, /openComposeLogs|label="日志"/);
  assert.match(app, /body: JSON\.stringify\(\{ operation, \.\.\.\(service \? \{ service } : \{}\) }\)/);
  assert.doesNotMatch(app, /if \(operation === "down"\) await ElMessageBox\.confirm/);
  assert.match(app, /v-if="!isWorkbenchPaneExpanded\('deployment'\)"[\s\S]*?runCompose\(deploymentProject, 'up'\)"[^>]*>启动<[\s\S]*?runCompose\(deploymentProject, 'down'\)"[^>]*>停止<[\s\S]*?runCompose\(deploymentProject, 'restart'\)"[^>]*>重启<[\s\S]*?openComposeLogs\(deploymentProject\)"[^>]*>日志/);
  assert.match(app, /composeBusyTarget === '\*:up'[\s\S]*?composeBusyTarget === '\*:down'[\s\S]*?composeBusyTarget === '\*:restart'/);
});

test("web deployment operations preserve the current Compose service order", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /function applyDeployment\(deployment, preserveServiceOrder = false\)[\s\S]*?new Map\(deployment\.services\.map\(\(service\) => \[service\.name, service\]\)\)[\s\S]*?deploymentServices\.value\.map\(\(service\) => nextServices\.get\(service\.name\)\)\.filter\(Boolean\)[\s\S]*?deployment\.services\.filter\(\(service\) => !currentNames\.has\(service\.name\)\)/);
  assert.match(app, /async function loadComposeDeployment\(project\)[\s\S]*?applyDeployment\(result\.deployment\)/);
  assert.match(app, /async function runCompose\(project, operation, service = ""\)[\s\S]*?applyDeployment\(result\.deployment, true\)/);
  assert.doesNotMatch(app.match(/<el-table\s+v-loading="deploymentLoading"[\s\S]*?class="service-table"[\s\S]*?<\/el-table>/)?.[0] || "", /sortable|default-sort|sort-change/);
});

test("web project navigator keeps project state visible", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /function projectNavigationStatuses\(project\)[\s\S]*?key: "config"[\s\S]*?label: applied \? "已应用" : "已恢复"[\s\S]*?key: "deployment"[\s\S]*?label: running \? "运行中" : "已停止"[\s\S]*?return statuses/);
  assert.doesNotMatch(app, /labels\.join\(" \| "\)/);
  assert.match(app, /class="workbench-project-name">\{\{ project\.name }}[\s\S]*?v-if="projectNavigationStatuses\(project\)\.length" class="workbench-project-states"[\s\S]*?v-for="status in projectNavigationStatuses\(project\)"[^>]*class="workbench-project-state status-beacon"[^>]*status\.className[\s\S]*?status\.label/);
  assert.match(app, /class="workbench-heading-statuses"[\s\S]*?<el-tag v-for="status in workspaceProject \? projectHeaderStatuses\(workspaceProject\)[^>]*class="status-beacon"[^>]*status\.className[^>]*status\.type/);
  assert.match(app, /effect="light">\{\{ status\.label }}<\/el-tag>/);
  assert.match(styles, /\.workbench-project-states \{[^}]*display: flex;[^}]*gap: 8px/);
  assert.match(app, /<el-tag class="status-beacon"[^>]*row\.status === 'running' \? 'is-live' : 'is-idle'/);
  assert.match(app, /row\.status === 'running' \? '运行中' : '已停止'/);
  assert.match(app, /import zhCn from "element-plus\/es\/locale\/lang\/zh-cn"[\s\S]*?pagesize: "\/页"[\s\S]*?total: "共 \{total} 个"/);
  assert.match(app, /<el-config-provider :locale="workspaceLocale">[\s\S]*?<el-pagination[\s\S]*?layout="sizes, total, prev, next"/);
  assert.match(styles, /\.workbench-project-pagination \{[^}]*display: grid;[^}]*grid-template-columns: 64px auto 19px 19px;[^}]*gap: 3px/);
  assert.match(styles, /\.workbench-project-pagination \.el-pagination__sizes \.el-select \{ width: 64px; }/);
  assert.match(styles, /\.workbench-project-pagination \.el-pagination__total \{[^}]*grid-column: 2;[^}]*white-space: nowrap/);
  assert.match(styles, /\.workbench-project-pagination \.btn-prev \{ grid-column: 3; margin: 0; }/);
  assert.match(styles, /\.workbench-project-pagination \.btn-next \{ grid-column: 4; margin: 0; }/);
  assert.match(styles, /\.status-beacon\.is-live::before \{[^}]*animation: signal-pulse/);
  assert.match(styles, /\.status-beacon\.is-config::before \{[^}]*animation: config-pulse/);
  assert.match(styles, /\.status-beacon\.is-idle::before \{[^}]*animation: status-breathe/);
});

test("web project navigator defaults open and becomes a hover overlay when collapsed", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  const navigator = app.match(/<aside class="workbench-project-nav">[\s\S]*?<\/aside>/)?.[0] || "";
  assert.match(app, /const projectNavCollapsed = ref\(false\)/);
  assert.match(app, /const projectNavWidth = ref\(224\)/);
  assert.match(app, /function toggleProjectNav\(event\)[\s\S]*?projectNavCollapsed\.value = !projectNavCollapsed\.value[\s\S]*?event\.detail > 0[\s\S]*?event\.currentTarget\.blur\(\)/);
  assert.match(app, /function setProjectNavWidth\(width\)[\s\S]*?Math\.min\(420, Math\.max\(184, width\)\)/);
  assert.match(app, /function startProjectNavResize\(event\)[\s\S]*?handlePointerMove[\s\S]*?addEventListener\("pointermove", handlePointerMove\)[\s\S]*?addEventListener\("pointercancel", stopResize/);
  assert.match(app, /function startProjectNavResize\(event\)[\s\S]*?event\.currentTarget\.focus\(\)/);
  assert.match(app, /class="workbench-layout"[^>]*'is-project-nav-collapsed': projectNavCollapsed[^>]*'--project-nav-width': `\$\{projectNavWidth}px`/);
  assert.match(app, /import \{[^}]*\bPin\b[^}]*} from "@lucide\/vue"/);
  assert.match(navigator, /class="workbench-nav-heading"[\s\S]*?>项目<[\s\S]*?:icon="Pin"[\s\S]*?@click="toggleProjectNav"[\s\S]*?class="workbench-nav-actions"[\s\S]*?:icon="Plus"[\s\S]*?:icon="Delete"/);
  assert.match(navigator, /class="workbench-project-nav-resizer"[\s\S]*?role="separator"[\s\S]*?aria-label="调整项目侧栏宽度"[\s\S]*?@pointerdown="startProjectNavResize"[\s\S]*?@keydown="handleProjectNavResizeKeydown"/);
  assert.match(styles, /\.workbench-layout \{[^}]*grid-template-columns: var\(--project-nav-width, 224px\) minmax\(0, 1fr\)/);
  assert.match(styles, /\.workbench-layout\.is-project-nav-collapsed \{ grid-template-columns: 0 minmax\(0, 1fr\); }/);
  assert.match(styles, /\.workbench-layout\.is-project-nav-collapsed \.workbench-project-nav \{[^}]*position: absolute;[^}]*width: var\(--project-nav-width, 224px\);[^}]*translateX\(calc\(-100% \+ 12px\)\)/);
  assert.match(styles, /\.workbench-layout\.is-project-nav-collapsed \.workbench-project-nav:hover[^}]*transform: translateX\(0\)/);
  assert.match(styles, /\.workbench-nav-collapse\.el-button \.lucide-pin, \.workbench-project-pin\.el-button\.is-pinned \.lucide-pin \{ fill: currentColor; }/);
  assert.match(styles, /\.is-project-nav-collapsed \.workbench-nav-collapse\.el-button \.lucide-pin \{ fill: none; }/);
  assert.match(styles, /\.workbench-project-item \{[^}]*transition:[^}]*transform \.18s ease/);
  assert.match(styles, /\.workbench-project-item:hover \{[^}]*box-shadow:[^}]*transform: scale\(1\.015\)/);
});

test("web compose logs follow the latest output and support larger tail ranges", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const ansiModule = await import(pathToFileURL(join(process.cwd(), "web/src/ansi.js")).href);
  const worker = await readFile(join(process.cwd(), "web/src/compose-log.worker.js"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /const composeLogLines = ref\(100\);/);
  assert.match(app, /const composeLogLineOptions = \[100, 200, 500, 1000, 2000, 5000];/);
  assert.match(worker, /const maxLines = 10000;/);
  assert.match(worker, /const maxChars = 1_000_000;/);
  assert.match(worker, /const maxSegments = 10000;/);
  assert.match(worker, /const flushDelay = 250;/);
  assert.match(app, /new URLSearchParams\(\{ tail: String\(composeLogLines\.value\) }\)/);
  assert.match(app, /new Worker\(new URL\("\.\/compose-log\.worker\.js", import\.meta\.url\), \{ type: "module" }\)/);
  assert.match(app, /function appendComposeLog\(event\)[\s\S]*?composeLogWorker\.postMessage\(\{ type: "append"/);
  assert.match(worker, /tailLogOutput\(pendingOutput, limits\)[\s\S]*?setTimeout\(flush, flushDelay\)/);
  assert.match(app, /function flushComposeLogDom\(\)[\s\S]*?performance\.now\(\) \+ 8[\s\S]*?document\.createElement\("span"\)[\s\S]*?code\.appendChild\(element\)/);
  assert.match(app, /function applyComposeLogPatch\(event\)[\s\S]*?patch\.generation !== composeLogGeneration[\s\S]*?composeLogDomQueue\.push/);
  assert.match(app, /function closeComposeLogs\(\)[\s\S]*?composeLogSource\.value\?\.close\(\)[\s\S]*?resetComposeLogOutput\(\)[\s\S]*?composeLogsProject\.value = null;[\s\S]*?composeLogsOpen\.value = false/);
  assert.match(app, /function updateComposeLogsFollowing\(\)[\s\S]*?scrollHeight - element\.scrollTop - element\.clientHeight <= 24/);
  assert.match(app, /aria-label="日志行数" @change="startComposeLogStream"/);
  assert.match(app, /ref="composeLogsRef" class="compose-logs"[^>]*@scroll="updateComposeLogsFollowing"/);
  assert.match(app, /function copyLogAsPlainText\(event\)[\s\S]*?event\.clipboardData\.clearData\(\)[\s\S]*?setData\("text\/plain", selection\.toString\(\)\)/);
  assert.match(app, /class="compose-logs" @copy="copyLogAsPlainText"/);
  assert.match(app, /<code ref="composeLogsCodeRef"><\/code><span v-if="!composeLogHasOutput">等待日志/);
  assert.doesNotMatch(app, /composeLogHtml|composeLogSegments|v-html="composeLogHtml"|v-for="segment in composeLogSegments"/);
  assert.match(ansiModule.ansiToHtml("\u001b[31merror\u001b[0m"), /<span style="color:#A00">error<\/span>/);
  assert.equal(ansiModule.ansiToHtml("visible \u001b[8mconsole-note\u001b[0m"), "visible <span style=\"display:none\">console-note</span>");
  assert.equal(ansiModule.ansiToHtml("<unsafe>"), "&lt;unsafe&gt;");
  assert.deepEqual(ansiModule.splitLogOutput("one\ntwo\nthree\n", 2), ["one\ntwo\n", "three\n"]);
  assert.deepEqual(ansiModule.splitLogOutput("1234567", 100, 3), ["123", "456", "7"]);
  const streamConverter = ansiModule.createAnsiStreamConverter();
  assert.equal(streamConverter.toHtml("\u001b[31mred\n"), '<span style="color:#A00">red\n</span>');
  assert.equal(streamConverter.toHtml("still red\u001b[0m\n"), '<span style="color:#A00">still red</span>\n');
  const bufferConverter = ansiModule.createAnsiStreamConverter();
  const oversizedLog = Array.from({ length: 10002 }, (_, index) => `line-${index}`).join("\n");
  const boundedBuffer = ansiModule.appendLogSegments(ansiModule.createLogSegmentBuffer(), oversizedLog, bufferConverter);
  assert(boundedBuffer.lineBreaks + (boundedBuffer.segments.at(-1)?.endsWithLineBreak ? 0 : 1) <= 10000);
  assert.match(boundedBuffer.segments.at(-1)?.html || "", /line-10001$/);
  const stableSegment = boundedBuffer.segments.at(-1);
  const appendedBuffer = ansiModule.appendLogSegments(boundedBuffer, "\nnext\n", bufferConverter);
  assert(appendedBuffer.segments.includes(stableSegment));
  const patchConverter = ansiModule.createAnsiStreamConverter();
  const initialPatch = ansiModule.appendLogSegmentPatch(ansiModule.createLogSegmentBuffer(), "one\ntwo\n", patchConverter, { maxLines: 2 });
  const nextPatch = ansiModule.appendLogSegmentPatch(initialPatch.buffer, "three\n", patchConverter, { maxLines: 2 });
  assert.equal(nextPatch.removedCount, 1);
  assert.deepEqual(nextPatch.segments.map((segment: { id: number }) => segment.id), [2]);
  assert.deepEqual(ansiModule.tailLogOutput("one\ntwo\nthree\n", { maxLines: 2, maxChars: 100 }), { value: "two\nthree\n", truncated: true });
  assert.deepEqual(ansiModule.tailLogOutput("12345\n67890", { maxLines: 10, maxChars: 7 }), { value: "67890", truncated: true });
  assert.match(styles, /\.compose-logs-toolbar \{[^}]*flex-wrap: wrap;[^}]*justify-content: space-between/);
});

test("web compose logs expose scoped deployment operations and reconnect after success", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  const toolbar = app.match(/<div class="compose-logs-toolbar">[\s\S]*?<\/div>\s*<\/div>/)?.[0] || "";
  const openLogs = app.match(/function openComposeLogs\(project, service = ""\) \{[\s\S]*?\n}/)?.[0] || "";
  assert.match(app, /v-model="workspaceSelectedService" aria-label="操作目标"/);
  assert.match(app, /v-model="composeLogsService" aria-label="日志服务"[^>]*@change="startComposeLogStream"/);
  assert.doesNotMatch(openLogs, /workspaceSelectedService/);
  assert.doesNotMatch(app, /function changeComposeLogsService/);
  assert.match(app, /async function runComposeFromLogs\(operation\)[\s\S]*?runCompose\(composeLogsProject\.value, operation, composeLogsService\.value\)[\s\S]*?if \(succeeded && composeLogsOpen\.value\) startComposeLogStream\(\)/);
  assert.match(toolbar, /class="compose-logs-range"[\s\S]*?class="compose-logs-operations"[\s\S]*?runComposeFromLogs\('up'\)[\s\S]*?runComposeFromLogs\('down'\)[\s\S]*?runComposeFromLogs\('restart'\)/);
  assert.match(app, /composeBusyTarget === `\$\{composeLogsService \|\| '\*'\}:up`[\s\S]*?composeBusyTarget === `\$\{composeLogsService \|\| '\*'\}:down`[\s\S]*?composeBusyTarget === `\$\{composeLogsService \|\| '\*'\}:restart`/);
  assert.match(styles, /\.compose-logs-operations, \.compose-logs-range \{[^}]*display: flex;[^}]*align-items: center/);
  assert.match(styles, /\.compose-logs-operations \{ margin-left: auto; \}/);
});

test("dark Compose logs use a dedicated high-contrast ANSI palette", async () => {
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(styles, /html\.dark \{[\s\S]*?--log-bg: rgb\(24 24 27 \/ 90%\);[\s\S]*?--log-text: #f2f2f7;[\s\S]*?--log-border: rgb\(255 255 255 \/ 17%\);/);
  assert.match(styles, /\.compose-logs \{[^}]*background: var\(--log-bg\);[^}]*color: var\(--log-text\);/);
  assert.match(styles, /\.compose-logs \{[^}]*font: 13px\/1\.55 "Cascadia Mono", "Cascadia Code", Consolas, "Liberation Mono", monospace;[^}]*text-rendering: geometricPrecision;[^}]*-webkit-font-smoothing: antialiased;/);
  assert.match(styles, /\.compose-logs > code, \.compose-logs > code \* \{ filter: none; text-shadow: none; }/);

  const colors = ["#b7c0ca", "#ff7b72", "#7ee787", "#d9c97c", "#79c0ff", "#d2a8ff", "#56d4dd", "#d0d7de", "#9da7b3", "#a5b4fc"];
  for (const [ansi, color] of [["000", colors[0]], ["A00", colors[1]], ["0A0", colors[2]], ["A50", colors[3]], ["00A", colors[4]], ["A0A", colors[5]], ["0AA", colors[6]], ["AAA", colors[7]], ["555", colors[8]], ["55F", colors[9]]]) {
    assert.match(styles, new RegExp(`html\\.dark \\.compose-logs \\[style\\*="color:#${ansi}"\\] \\{ color: ${color} !important; \\}`));
  }

  const luminance = (hex: string) => {
    const channels = hex.slice(1).match(/../g)?.map((value) => Number.parseInt(value, 16) / 255) || [];
    const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const background = luminance("#18181b");
  for (const color of colors) assert((luminance(color) + 0.05) / (background + 0.05) >= 4.5);
});

test("web Compose logs are docked in the workbench and can fill the viewport", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /v-if="composeLogsOpen"[\s\S]*?class="workspace-logs"[\s\S]*?:class="\{ 'is-fullscreen': composeLogsFullscreen, 'is-resizing': composeLogsResizing }"/);
  assert.match(app, /class="workspace-logs-resizer"[\s\S]*?role="separator"[\s\S]*?aria-label="调整日志窗口高度"[\s\S]*?tabindex="0"[\s\S]*?@pointerdown="startComposeLogsResize"/);
  assert.doesNotMatch(app, /@keydown="handleComposeLogsResizeKeydown"/);
  assert.match(app, /function startComposeLogsResize\(event\)[\s\S]*?const startY = event\.clientY[\s\S]*?startHeight \+ startY - moveEvent\.clientY[\s\S]*?addEventListener\("pointermove", handlePointerMove\)[\s\S]*?addEventListener\("pointercancel", stopResize/);
  assert.match(app, /function handleComposeLogsResizeKeydown\(event\)[\s\S]*?!composeLogsOpen\.value \|\| composeLogsFullscreen\.value[\s\S]*?event\.key === "ArrowUp" \? 32 : -32/);
  assert.match(app, /onBeforeUnmount\(\(\) => \{[\s\S]*?composeLogsResizeCleanup\?\.\(\)/);
  assert.match(app, /function handleWorkspaceKeydown\(event\)[\s\S]*?event\.key === "Escape"[\s\S]*?composeLogsFullscreen\.value = false[\s\S]*?event\.key === "ArrowUp" \|\| event\.key === "ArrowDown"[\s\S]*?handleComposeLogsResizeKeydown\(event\)[\s\S]*?event\.key\.length === 1[\s\S]*?event\.key\.trim\(\)[\s\S]*?composeLogsFollowing\.value = true;[\s\S]*?nextTick\(scrollComposeLogsToEnd\)/);
  assert.match(app, /event\.defaultPrevented \|\| event\.isComposing \|\| hasCommandModifier \|\| isEditing \|\| !isPlainKey/);
  assert.match(styles, /\.workspace-logs \{[^}]*position: absolute;[^}]*bottom: 16px;[^}]*border: 1px solid var\(--log-border\)/);
  assert.match(styles, /\.workspace-logs-resizer \{[^}]*top: 0;[^}]*height: 10px;[^}]*cursor: row-resize;[^}]*touch-action: none/);
  assert.match(styles, /body\.is-compose-logs-resizing, body\.is-compose-logs-resizing \* \{[^}]*cursor: row-resize !important;[^}]*user-select: none !important/);
  assert.match(styles, /\.workspace-logs \.compose-logs \{ height: var\(--compose-logs-height, min\(34vh, 380px\)\); min-height: 260px; \}/);
  assert.match(styles, /\.workspace-logs\.is-fullscreen \{[^}]*position: fixed;[^}]*inset: 0;[^}]*border-radius: 0/);
  assert.match(styles, /\.workspace-logs\.is-fullscreen \.workspace-logs-resizer \{ display: none; \}/);
  assert.match(styles, /\.workspace-logs\.is-fullscreen \.compose-logs \{[^}]*min-height: 0;[^}]*flex: 1/);
});

test("every web dialog can fill the viewport and Escape restores the window", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const dialog = await readFile(join(process.cwd(), "web/src/WindowDialog.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.equal(app.match(/<el-dialog\b/g)?.length, 7);
  assert.match(dialog, /import \{ Close, FullScreen, ScaleToOriginal } from "@element-plus\/icons-vue";/);
  assert.match(dialog, /const fullscreen = ref\(false\);/);
  assert.match(dialog, /function toggleFullscreen\(\) \{[\s\S]*?setFullscreen\(!fullscreen\.value\)/);
  assert.match(dialog, /function isTopmostDialog\(\) \{[\s\S]*?querySelectorAll\("\.window-dialog"\)[\s\S]*?candidateZIndex >= currentZIndex[\s\S]*?dataset\.windowDialogId === dialogId/);
  assert.match(dialog, /function handleEscape\(event\) \{[\s\S]*?event\.key !== "Escape"[\s\S]*?!isTopmostDialog\(\)[\s\S]*?setFullscreen\(false\)/);
  assert.doesNotMatch(dialog, /querySelectorAll\("\.window-dialog\.is-fullscreen"\)/);
  assert.match(dialog, /window\.addEventListener\("keydown", handleEscape, true\)/);
  assert.match(dialog, /window\.removeEventListener\("keydown", handleEscape, true\)/);
  assert.match(dialog, /:fullscreen="fullscreen"[\s\S]*?:close-on-press-escape="!fullscreen"/);
  assert.match(dialog, /class="window-dialog-control"[\s\S]*?:icon="fullscreen \? ScaleToOriginal : FullScreen"[\s\S]*?@click\.stop="toggleFullscreen"/);
  assert.match(styles, /\.window-dialog-controls \{[^}]*gap: 2px/);
  assert.match(styles, /\.window-dialog-control\.el-button \{[^}]*width: 32px;[^}]*height: 32px;[^}]*margin: 0/);
  assert.match(styles, /\.window-dialog\.el-dialog\.is-fullscreen \{[^}]*width: 100vw;[^}]*height: 100vh;[^}]*margin: 0;[^}]*border: 0;[^}]*border-radius: 0;[^}]*box-shadow: none/);
  assert.match(styles, /\.window-dialog\.el-dialog\.is-fullscreen \.el-dialog__body \{[^}]*flex: 1;[^}]*overflow: auto/);
  assert.match(styles, /\.window-dialog\.el-dialog\.is-fullscreen \.dialog-close-hint, \.window-dialog\.el-dialog\.is-fullscreen \.dialog-footer-close \{ display: none; }/);
  assert.match(styles, /\.window-dialog\.el-dialog\.is-fullscreen \.el-dialog__footer:not\(:has\(\.dialog-footer-actions\)\) \{ display: none; }/);
  assert.equal(app.match(/class="dialog-footer-close"/g)?.length, 2);
  assert.match(styles, /\.workspace-logs\.is-fullscreen \.compose-logs \{[^}]*flex: 1;/);
});

test("web deployment service table keeps only service, ports, and status columns", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /prop="name" label="Service" min-width="150"/);
  assert.match(app, /function servicePortItems\(ports\) {[\s\S]*?new Map\(\)[\s\S]*?href: port\.publishedPort \? `http:\/\/127\.0\.0\.1:\$\{port\.publishedPort}` : ""[\s\S]*?items\.values\(\)/);
  assert.match(app, /label="端口" min-width="180"[\s\S]*?servicePortItems\(row\.ports\)[\s\S]*?v-if="row\.status === 'running' && port\.href"[\s\S]*?:href="port\.href"[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?@click\.stop/);
  assert.match(styles, /\.service-port-link \{[^}]*color: var\(--accent\);[^}]*text-decoration: underline/);
  assert.match(app, /label="状态" width="96"/);
  assert.doesNotMatch(app, /label="日志" width="64"|openComposeLogs\(deploymentProject, row\.name\)/);
  assert.match(styles, /\.service-table \.el-table__row\.is-selected-service td \{ background: var\(--accent-soft\) !important; }/);
});

test("web selected-project identity and operations stay in their working context", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const styles = await readFile(join(process.cwd(), "web/src/styles.css"), "utf8");
  assert.match(app, /function formatProjectId\(id\) \{[\s\S]*?return `id \$\{id}`/);
  assert.match(app, /function projectHeaderStatuses\(project\)[\s\S]*?key: "config"[\s\S]*?key: "deployment"/);
  assert.match(app, /<span class="brand-mark" aria-hidden="true">[\s\S]*?<h1>工作台<\/h1>[\s\S]*?class="workbench-project-title"[\s\S]*?workspaceProject\?\.name[\s\S]*?class="workbench-project-id">\{\{ workspaceProject \? formatProjectId\(workspaceProject\.id\)[\s\S]*?class="workbench-heading-statuses"[\s\S]*?projectHeaderStatuses/);
  assert.match(styles, /\.workbench-title-row \{[^}]*grid-template-columns: 68px 76px 5ch 142px/);
  assert.match(styles, /\.workbench-project-title \{[^}]*text-align: center/);
  assert.match(styles, /\.workbench-project-id \{[^}]*width: 5ch;[^}]*max-width: 5ch/);
  assert.match(styles, /\.workbench-heading-statuses \{[^}]*grid-template-columns: repeat\(2, 68px\)/);
  assert.match(app, /<h2>详情<\/h2>[\s\S]*?<el-button aria-label="编辑项目" @click="openProjectEditor\(workspaceProject\)">编辑<\/el-button>/);
  assert.match(app, /class="workbench-pane-actions"[\s\S]*?operateConfig\('sync'\)[\s\S]*?operateConfig\('apply'\)/);
  assert.doesNotMatch(app, /runCompose\(deploymentProject, 'edit'\)|composeFileDialogOpen/);
  assert.doesNotMatch(app, /v-if="isWorkbenchPaneExpanded\('(?:directories|config|deployment)'\)"[^>]*class="workbench-pane-actions"|v-if="isWorkbenchPaneExpanded\('deployment'\)"[^>]*runCompose/);
  assert.doesNotMatch(app, /<span>环境 \{\{ environment }}/);
  assert.doesNotMatch(app, /class="workbench-environment"|>全局参数设置<|:icon="ArrowLeft"/);
  assert.match(app, /aria-label="删除当前项目"[^>]*@click="removeWorkspaceProject"/);
  const serviceTable = app.match(/<el-table\s+v-loading="deploymentLoading"[\s\S]*?class="service-table"[\s\S]*?<\/el-table>/)?.[0] || "";
  assert.doesNotMatch(serviceTable, /<el-table-column label="操作"/);
});

test("web keeps the empty-project fallback inside the management workbench", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  const index = await readFile(join(process.cwd(), "web/index.html"), "utf8");
  assert.match(app, /<h1>工作台<\/h1>[\s\S]*?workspaceProject\?\.name \|\| "未选择"[\s\S]*?workspaceProject \? formatProjectId\(workspaceProject\.id\) : "--"/);
  assert.match(app, /<div v-else class="workbench-unselected"><span>未选择项目<\/span><\/div>/);
  assert.doesNotMatch(app, /<el-header|class="app-header"|class="brand"/);
  assert.match(app, /<span class="brand-mark" aria-hidden="true">/);
  assert.match(await readFile(join(process.cwd(), "web/src/styles.css"), "utf8"), /\.el-button:not\(\.is-disabled\):hover \.el-icon,[^}]*transform: scale\(1\.14\)/);
  assert.doesNotMatch(app, /project-table|paginatedProjects|currentPage/);
  assert.match(index, /<title>个人工作台<\/title>/);
  assert.doesNotMatch(`${app}\n${index}`, /Owner Config|项目配置|配置管理/i);
});

test("web selects the first project after loading status", async () => {
  const app = await readFile(join(process.cwd(), "web/src/App.vue"), "utf8");
  assert.match(app, /async function loadProjectPage\(\{ selectFirst = false } = \{}\)[\s\S]*?summary\.value = result;[\s\S]*?if \(selectFirst && !workspaceProject\.value\)[\s\S]*?if \(result\.projects\[0]\) await openProjectWorkspace\(result\.projects\[0]\);[\s\S]*?else await loadSettings\(\);/);
  assert.match(app, /async function load\(\)[\s\S]*?loadProjectPage\(\{ selectFirst: true }\)/);
  assert.match(app, /onMounted\(\(\) => \{[\s\S]*?load\(\)\.catch/);
  assert.doesNotMatch(app.match(/onMounted\(\(\) => \{[\s\S]*?\n}\);/)?.[0] || "", /loadSettings\(\)\.catch/);
});

test("web page publishes a project configuration favicon", async () => {
  const index = await readFile(join(process.cwd(), "web/index.html"), "utf8");
  const favicon = await readFile(join(process.cwd(), "web/public/favicon.svg"), "utf8");
  assert.match(index, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(favicon, /<svg[^>]*viewBox="0 0 64 64"/);
  assert.equal(favicon.match(/<circle /g)?.length, 3);
});

test("chooses the native directory opener for Windows, WSL, macOS, and Linux", () => {
  assert.deepEqual(directoryOpenCommand("/project", "win32", {}), { command: "explorer.exe", args: ["/project"] });
  assert.deepEqual(directoryOpenCommand("/mnt/d/code/apps/api", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "explorer.exe", args: ["D:\\code\\apps\\api"] });
  assert.deepEqual(directoryOpenCommand("/home/user/project", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "explorer.exe", args: ["\\\\wsl.localhost\\Ubuntu\\home\\user\\project"] });
  assert.deepEqual(directoryOpenCommand("D:\\code\\apps\\api", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "explorer.exe", args: ["D:\\code\\apps\\api"] });
  assert.deepEqual(directoryOpenCommand("\\\\wsl.localhost\\Ubuntu\\home\\user\\project", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "explorer.exe", args: ["\\\\wsl.localhost\\Ubuntu\\home\\user\\project"] });
  assert.deepEqual(directoryOpenCommand("/project", "darwin", {}), { command: "open", args: ["/project"] });
  assert.deepEqual(directoryOpenCommand("/project", "linux", {}), { command: "xdg-open", args: ["/project"] });
  assert.deepEqual(terminalOpenCommand("/project", "win32", {}), { command: "wt.exe", args: ["-w", "0", "new-tab", "-d", "/project"] });
  assert.deepEqual(terminalOpenCommand("/mnt/d/code/apps/api", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "wt.exe", args: ["-w", "0", "new-tab", "wsl.exe", "-d", "Ubuntu", "--cd", "/mnt/d/code/apps/api"] });
  assert.deepEqual(terminalOpenCommand("/mnt/d/code/apps/api/conf", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "wt.exe", args: ["-w", "0", "new-tab", "wsl.exe", "-d", "Ubuntu", "--cd", "/mnt/d/code/apps/api/conf"] });
  assert.deepEqual(terminalOpenCommand("/home/user/project", "linux", { WSL_INTEROP: "/run/WSL/1_interop" }), { command: "wt.exe", args: ["-w", "0", "new-tab", "wsl.exe", "--cd", "/home/user/project"] });
  assert.deepEqual(codeOpenCommand("D:\\code\\apps\\api", "win32", {}), { command: "code.exe", args: ["--new-window", "D:\\code\\apps\\api"] });
  assert.deepEqual(codeOpenCommand("D:\\code\\apps\\api", "win32", { Path: "C:\\Windows;D:\\software\\Microsoft VS Code\\bin" }), { command: "D:\\software\\Microsoft VS Code\\Code.exe", args: ["--new-window", "D:\\code\\apps\\api"] });
  assert.deepEqual(codeOpenCommand("/mnt/d/code/apps/api", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "code.exe", args: ["--new-window", "D:\\code\\apps\\api"] });
  assert.deepEqual(codeOpenCommand("/mnt/d/code/apps/api", "linux", { WSL_DISTRO_NAME: "Ubuntu", PATH: "/usr/bin:/mnt/d/software/Microsoft VS Code/bin" }), { command: "/mnt/d/software/Microsoft VS Code/Code.exe", args: ["--new-window", "D:\\code\\apps\\api"] });
  assert.deepEqual(codeOpenCommand("/home/user/project", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "code.exe", args: ["--new-window", "\\\\wsl.localhost\\Ubuntu\\home\\user\\project"] });
  assert.deepEqual(codeOpenCommand("/project", "linux", {}), { command: "code", args: ["--new-window", "/project"] });
  assert.deepEqual(zedOpenCommand("D:\\code\\apps\\api", "win32", {}), { command: "zed.exe", args: ["--existing", "D:\\code\\apps\\api"] });
  assert.deepEqual(zedOpenCommand("/mnt/d/code/apps/api", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "zed.exe", args: ["--existing", "D:\\code\\apps\\api"] });
  assert.deepEqual(zedOpenCommand("/home/user/project", "linux", { WSL_DISTRO_NAME: "Ubuntu" }), { command: "zed.exe", args: ["--existing", "\\\\wsl.localhost\\Ubuntu\\home\\user\\project"] });
  assert.deepEqual(zedOpenCommand("/project", "linux", {}), { command: "zed", args: ["--existing", "/project"] });
});

test("maximizes newly opened or reused Windows editor windows", () => {
  const code = maximizedWindowsOpenCommand(
    { command: "/mnt/d/software/Microsoft VS Code/Code.exe", args: ["--new-window", "D:\\code\\apps\\api"] },
    "Code",
    "D:\\code\\apps\\api",
    { WSL_DISTRO_NAME: "Ubuntu" },
  );
  assert.equal(code.command, "powershell.exe");
  assert.deepEqual(code.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command"]);
  assert.match(code.args[5], /Get-Process -Name 'Code'/);
  assert.match(code.args[5], /\$startInfo\.FileName = 'D:\\software\\Microsoft VS Code\\Code\.exe'/);
  assert.match(code.args[5], /\$startInfo\.Arguments = '"--new-window" "D:\\code\\apps\\api"'/);
  assert.match(code.args[5], /Process\]::Start\(\$startInfo\)/);
  assert.match(code.args[5], /\$before -notcontains \$_\.MainWindowHandle/);
  assert.match(code.args[5], /MainWindowTitle\.IndexOf\('api'/);
  assert.match(code.args[5], /ShowWindowAsync\(\$target\.MainWindowHandle, 3\)/);

  const zed = maximizedWindowsOpenCommand(
    { command: "zed.exe", args: ["--existing", "\\\\wsl.localhost\\Ubuntu\\home\\user\\owner's project"] },
    "Zed",
    "/home/user/owner's project",
  );
  assert.match(zed.args[5], /Get-Process -Name 'Zed'/);
  assert.match(zed.args[5], /MainWindowTitle\.IndexOf\('owner''s project'/);
  assert.match(zed.args[5], /\$startInfo\.Arguments = '"--existing" "\\\\wsl\.localhost\\Ubuntu\\home\\user\\owner''s project"'/);
});

test("deploy script keeps the current owner root when the checkout has an aliased mount path", async () => {
  const deploy = await readFile(join(process.cwd(), "deploy.sh"), "utf8");
  assert.match(deploy, /for drive_root in \/mnt\/\[a-z\]; do[\s\S]*?candidate="\$drive_root\$ROOT_DIR"[\s\S]*?ROOT_DIR="\$\(cd -- "\$candidate" && pwd -P\)"/);
  assert.match(deploy, /stat -Lc '%d:%i' \"\/proc\/\$pid\/cwd\"/);
  assert.match(deploy, /OWNER_CONFIG_ROOT=\"\$ROOT_DIR\"/);
});

test("lists selectable directories and files within the code root", async () => {
  const { ownerRoot } = await fixture();
  const root = await listCodeDirectories(ownerRoot);
  assert(root.directories.some((entry) => entry.path === "apps"));
  const apps = await listCodeDirectories(ownerRoot, "apps");
  assert.deepEqual(apps.directories.map((entry) => entry.name), ["a", "b", "portal"]);
  assert.equal(apps.parent, "");
  const project = await listCodeDirectories(ownerRoot, "apps/a");
  assert.deepEqual(project.files.map((entry) => entry.path), ["apps/a/local-stack.yml"]);
  await assert.rejects(listCodeDirectories(ownerRoot, "../outside"), /invalid directory path/);
});

test("structured merge remains strict and resolves scalar variables", () => {
  assert.deepEqual(mergeStructured({ server: { workers: 4, enabled: false } }, { server: { workers: 2 } }), { server: { workers: 2, enabled: false } });
  assert.throws(() => mergeStructured({ server: {} }, { server: { extra: true } }), /unknown key/);
  assert.deepEqual(resolveVariables({ port: "@{PORT}", url: "db:@{PORT}" }, { PORT: 3306 }), { port: 3306, url: "db:3306" });
});

test("merged preview marks inserted and replaced lines", () => {
  assert.deepEqual(modifiedLines("one\ntwo\nthree\n", "one\nchanged\nthree\nfour\n"), [
    { number: 1, text: "one", kind: "unchanged" },
    { number: 2, text: "two", kind: "removed" },
    { number: 2, text: "changed", kind: "added" },
    { number: 3, text: "three", kind: "unchanged" },
    { number: 4, text: "four", kind: "added" },
  ]);
});

test("merged preview context keeps changed lines and two surrounding lines", () => {
  const lines = modifiedLines(
    "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n",
    "one\ntwo\nthree\nfour\nchanged\nsix\nseven\neight\nnine\n",
  );
  assert.deepEqual(diffLinesWithContext(lines).map((line) => line.text), [
    "three", "four", "five", "changed", "six", "seven",
  ]);
  assert.deepEqual(diffLinesWithContext(lines, 0).map((line) => line.text), ["five", "changed"]);
  assert.deepEqual(diffLinesWithContext(modifiedLines("same\n", "same\n")), []);
});

test("merged preview context marks omitted lines between separate changes", () => {
  const lines = modifiedLines(
    "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n",
    "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\ntwelve\n",
  );
  assert.deepEqual(diffLinesWithContext(lines, 1).map((line) => ({ number: line.number, text: line.text, kind: line.kind })), [
    { number: 2, text: "two", kind: "unchanged" },
    { number: 3, text: "three", kind: "removed" },
    { number: 3, text: "THREE", kind: "added" },
    { number: 4, text: "four", kind: "unchanged" },
    { number: null, text: "...", kind: "gap" },
    { number: 9, text: "nine", kind: "unchanged" },
    { number: 10, text: "ten", kind: "removed" },
    { number: 10, text: "TEN", kind: "added" },
    { number: 11, text: "eleven", kind: "unchanged" },
  ]);
});

test("YAML merge preserves baseline formatting and boolean styles", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-config-yaml-"));
  const baseline = join(root, "baseline.yaml");
  const local = join(root, "local.yaml");
  const output = join(root, "output.yaml");
  await writeFile(baseline, "# service\nname: template\n\nlower: false\ntitle: False\nupper: FALSE\n");
  await writeFile(local, "lower: true\ntitle: true\nupper: true\n");
  await mergeConfigFile(baseline, local, output, {});
  assert.equal(await readFile(output, "utf8"), "# service\nname: template\n\nlower: true\ntitle: True\nupper: TRUE\n");
});

test("INI merge preserves GB18030, CRLF, comments, and formatting", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-config-ini-"));
  const baseline = join(root, "baseline.ini");
  const local = join(root, "local.ini");
  const output = join(root, "output.ini");
  const baselineRaw = iconv.encode("; 应用配置\r\n[App]\r\nName = 默认  \r\nEnabled=True\r\n", "gb18030");
  await writeFile(baseline, baselineRaw);
  await writeFile(local, "[App]\nName=本地\n");
  await mergeConfigFile(baseline, local, output, {});
  assert.equal(iconv.decode(await readFile(output), "gb18030"), "; 应用配置\r\n[App]\r\nName = 本地  \r\nEnabled=True\r\n");
  await writeFile(local, "[App]\nName=默认\n");
  await mergeConfigFile(baseline, local, output, {});
  assert.deepEqual(await readFile(output), baselineRaw);
});

test("structured merges preserve source line endings, final newline, encoding, and BOM", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-config-format-"));
  const yamlBaseline = join(root, "baseline.yaml");
  const yamlLocal = join(root, "local.yaml");
  const yamlOutput = join(root, "output.yaml");
  await writeFile(yamlBaseline, iconv.encode("# 配置\r\nname: 默认\r\nenabled: false", "gb18030"));
  await writeFile(yamlLocal, "enabled: true\n");
  await mergeConfigFile(yamlBaseline, yamlLocal, yamlOutput, {});
  assert.equal(iconv.decode(await readFile(yamlOutput), "gb18030"), "# 配置\r\nname: 默认\r\nenabled: true");

  const jsonBaseline = join(root, "baseline.json");
  const jsonLocal = join(root, "local.json");
  const jsonOutput = join(root, "output.json");
  await writeFile(jsonBaseline, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{\r\n  "name": "default",\r\n  "enabled": false\r\n}\r\n')]));
  await writeFile(jsonLocal, '{"enabled":true}\n');
  await mergeConfigFile(jsonBaseline, jsonLocal, jsonOutput, {});
  const jsonRaw = await readFile(jsonOutput);
  assert.deepEqual(jsonRaw.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(jsonRaw.subarray(3).toString("utf8"), '{\r\n    "name": "default",\r\n    "enabled": true\r\n}\r\n');
});

test("merged preview ignores line-ending-only differences", () => {
  assert.deepEqual(modifiedLines("one\r\ntwo\r\n", "one\ntwo\n"), [
    { number: 1, text: "one", kind: "unchanged" },
    { number: 2, text: "two", kind: "unchanged" },
  ]);
});

test("summary sorts pinned projects before applying server pagination", async () => {
  const { codeRoot, ownerRoot } = await fixture();
  const configPath = join(ownerRoot, "data/projects.yaml");
  const config = parse(await readFile(configPath, "utf8")) as { projects: Array<Record<string, unknown>> };
  config.projects = [config.projects[2], config.projects[0], config.projects[1]];
  await writeFile(configPath, stringify(config));
  await updateProjectPin(ownerRoot, 103, true);
  await updateProjectPin(ownerRoot, 102, true);
  await utimes(join(codeRoot, "apps/a/conf/dev.yaml"), new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T00:00:00Z"));
  await utimes(join(codeRoot, "apps/b/conf/dev.yaml"), new Date("2024-03-01T00:00:00Z"), new Date("2024-03-01T00:00:00Z"));
  await utimes(join(codeRoot, "apps/portal/conf/dev.yaml"), new Date("2024-02-01T00:00:00Z"), new Date("2024-02-01T00:00:00Z"));
  const summary = await getSummary(ownerRoot, undefined, undefined, { page: 1, pageSize: 2 });
  assert.deepEqual(summary.tags.map((tag) => tag.name), ["backend", "task"]);
  assert.deepEqual(summary.projects.map((project) => project.id), [102, 103]);
  assert.deepEqual(summary.projects.map((project) => project.pinned), [true, true]);
  assert.deepEqual({ total: summary.total, page: summary.page, pageSize: summary.pageSize }, { total: 3, page: 1, pageSize: 2 });
  assert.deepEqual(summary.projects.find((project) => project.id === 103)?.tags, []);
  assert.deepEqual(summary.projects.map((project) => project.status), ["normal", "normal"]);
  assert(summary.projects.every((project) => project.updatedAt !== null));
  const secondPage = await getSummary(ownerRoot, undefined, undefined, { page: 2, pageSize: 2 });
  assert.deepEqual(secondPage.projects.map((project) => project.id), [101]);
  const filtered = await getSummary(ownerRoot, undefined, undefined, { page: 2, pageSize: 1, query: "task" });
  assert.deepEqual(filtered.projects.map((project) => project.id), [101]);
  assert.deepEqual({ total: filtered.total, page: filtered.page }, { total: 2, page: 2 });
});

test("summary exposes each project's current apply status", async () => {
  const { ownerRoot } = await fixture();
  await runOperation(ownerRoot, "sync", [101, 102]);
  await runOperation(ownerRoot, "apply", [101]);
  assert.equal((await getSummary(ownerRoot)).projects.find((project) => project.id === 101)?.status, "applied");
  await runOperation(ownerRoot, "restore", [101]);
  assert.deepEqual((await getSummary(ownerRoot)).projects.map((project) => project.status), ["normal", "normal", "normal"]);
});

test("locks and sync checks apply only to selected projects", async () => {
  const { ownerRoot } = await fixture();
  await runOperation(ownerRoot, "sync", [101, 102]);
  await runOperation(ownerRoot, "apply", [101, 102]);
  await runOperation(ownerRoot, "apply", [103]).catch(() => undefined);
  await runOperation(ownerRoot, "restore", [101]);
  await runOperation(ownerRoot, "sync", [103]);
  await assert.rejects(runOperation(ownerRoot, "sync", [102]), /selected projects are applied/);
  assert.equal((await getSummary(ownerRoot)).projects.find((project) => project.id === 102)?.status, "applied");
  await runOperation(ownerRoot, "restore", [101, 102]);
  assert((await getSummary(ownerRoot)).projects.every((project) => project.status === "normal"));
});
