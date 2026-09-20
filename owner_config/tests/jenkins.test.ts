import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { getJenkinsJob, isJenkinsBuildRunning, readJenkinsLog, triggerJenkinsBuild } from "../src/jenkins.js";
import { createApp } from "../src/server.js";

const credentials = { username: "builder", token: "secret" };

async function fetchReady(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return await fetch(url); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw lastError;
}

test("Jenkins client maps builds and parameters with authenticated requests", async () => {
  let authorization = "";
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization") || "";
    if (new URL(String(input)).pathname.endsWith("/build")) return new Response(`
      <div name="parameter"><input name="name" type="hidden" value="service">
        <div class="dynamic_checkbox"><input name="value" type="checkbox" value="api" checked><input name="value" type="checkbox" value="worker"></div>
      </div>
    `, { status: 405, headers: { "content-type": "text/html;charset=utf-8" } });
    return Response.json({
      name: "Deploy",
      url: "http://jenkins/job/deploy/",
      buildable: true,
      builds: [{ number: 8, url: "http://jenkins/job/deploy/8/", displayName: "#8", result: null, building: true, timestamp: 1000, duration: 0 }],
      actions: [{ parameterDefinitions: [
        { name: "ENV", type: "ChoiceParameterDefinition", description: "Target", defaultParameterValue: { value: "dev" }, choices: ["dev", "prod"] },
        { name: "CLEAN", type: "BooleanParameterDefinition", defaultParameterValue: { value: false } },
      ] }],
      property: [{ parameterDefinitions: [
        { name: "service", type: "ChoiceParameter", defaultParameterValue: { value: "api" } },
      ] }],
    });
  }) as typeof fetch;
  const job = await getJenkinsJob("http://jenkins/job/deploy/", credentials, fetcher);
  assert.equal(authorization, `Basic ${Buffer.from("builder:secret").toString("base64")}`);
  assert.equal(job.builds[0].building, true);
  assert.deepEqual(job.parameters.map((parameter) => [parameter.name, parameter.defaultValue, parameter.choices]), [
    ["ENV", "dev", ["dev", "prod"]], ["CLEAN", false, []], ["service", ["api"], ["api", "worker"]],
  ]);
  assert.equal(job.parameters.find((parameter) => parameter.name === "service")?.multiple, true);
});

test("Jenkins client obtains a crumb, triggers parameter builds, and advances progressive logs", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method || "GET", headers: new Headers(init?.headers), body: String(init?.body || "") });
    if (url.includes("crumbIssuer")) return Response.json({ crumbRequestField: "Jenkins-Crumb", crumb: "crumb-value" });
    if (url.includes("progressiveText")) return new Response("line\n", { headers: { "x-text-size": "5", "x-more-data": "true" } });
    if (url.includes("/8/api/json")) return Response.json({ building: false });
    return new Response(null, { status: 201, headers: { location: "/queue/item/12/" } });
  }) as typeof fetch;
  assert.deepEqual(await triggerJenkinsBuild("http://jenkins/job/deploy/", credentials, { ENV: "prod", CLEAN: true }, fetcher), { queueUrl: "http://jenkins/queue/item/12/" });
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[1].headers.get("jenkins-crumb"), "crumb-value");
  assert.equal(requests[1].body, "ENV=prod&CLEAN=true");
  assert.deepEqual(await readJenkinsLog("http://jenkins/job/deploy/", 8, credentials, 0, fetcher), { text: "line\n", nextOffset: 5, more: true });
  assert.equal(await isJenkinsBuildRunning("http://jenkins/job/deploy/", 8, credentials, fetcher), false);
});

test("Jenkins client rejects malformed tokens and explains authentication failures", async () => {
  const unusedFetcher = (async () => {
    assert.fail("malformed credentials must be rejected before the request");
  }) as typeof fetch;
  await assert.rejects(getJenkinsJob("http://jenkins/job/deploy/", { username: "builder", token: "bad│token" }, unusedFetcher), /Token 只能包含无空格的 ASCII 可打印字符/);

  const unauthorizedFetcher = (async () => new Response("<html>Unauthorized</html>", { status: 401, statusText: "Unauthorized" })) as typeof fetch;
  await assert.rejects(getJenkinsJob("http://jenkins/job/deploy/", credentials, unauthorizedFetcher), /参数 > Jenkins 凭据.*Jenkins 用户 ID.*API Token/);
});

test("HTTP Jenkins module returns jobs, triggers builds, and streams progressive logs over SSE", async (context) => {
  const codeRoot = await mkdtemp(join(tmpdir(), "owner-config-jenkins-"));
  const root = join(codeRoot, "owner_config");
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(codeRoot, "apps/api"), { recursive: true });
  await writeFile(join(root, "data/projects.yaml"), stringify({ env: { current: "dev", options: ["dev"] }, projects: [
    { id: 1, name: "api", conf_dir: "apps/api", jenkins_job_url: "http://jenkins/job/deploy/", files: [], tags: [] },
  ] }));
  await writeFile(join(root, "data/variables.yaml"), "{}\n");
  await writeFile(join(root, "data/jenkins.yaml"), "username: builder\ntoken: secret\n");
  let logRequest = 0;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/crumbIssuer/api/json") return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/buildWithParameters")) return new Response(null, { status: 201, headers: { location: "/queue/item/2/" } });
    if (url.pathname.endsWith("/progressiveText")) {
      logRequest += 1;
      return new Response(logRequest === 1 ? "hello " : "world\n", { headers: {
        "x-text-size": logRequest === 1 ? "6" : "12",
        "x-more-data": logRequest === 1 ? "true" : "false",
      } });
    }
    if (url.pathname.endsWith("/2/api/json")) return Response.json({ building: logRequest < 2 });
    assert.match(new Headers(init?.headers).get("authorization") || "", /^Basic /);
    return Response.json({ name: "Deploy", url: "http://jenkins/job/deploy/", buildable: true, builds: [{ number: 2, url: "http://jenkins/job/deploy/2/", building: true, result: null, displayName: "#2", timestamp: 1000, duration: 0 }], actions: [] });
  }) as typeof fetch;
  const server = createApp(root, { jenkinsFetch: fetcher, jenkinsLogPollInterval: 0, logger: { info: () => undefined, error: () => undefined } }).listen(0, "127.0.0.1");
  context.after(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const job = await fetchReady(`${base}/api/projects/1/jenkins`);
  assert.equal(job.status, 200);
  assert.equal(((await job.json()) as { job: { builds: Array<{ number: number }> } }).job.builds[0].number, 2);
  const build = await fetch(`${base}/api/projects/1/jenkins/builds`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parameters: { ENV: "dev", service: ["api", "worker"] } }) });
  assert.equal(build.status, 201);
  assert.equal((await build.json() as { queueUrl: string }).queueUrl, "http://jenkins/queue/item/2/");
  const logs = await fetch(`${base}/api/projects/1/jenkins/builds/2/logs`);
  assert.match(logs.headers.get("content-type") || "", /text\/event-stream/);
  const stream = await logs.text();
  assert.match(stream, /data: "hello "/);
  assert.match(stream, /data: "world\\n"/);
  assert.match(stream, /event: end/);
});

test("web Jenkins module appears in the workbench pane list only for configured projects", async () => {
  const app = await import("node:fs/promises").then(({ readFile }) => readFile(join(process.cwd(), "web/src/App.vue"), "utf8"));
  const styles = await import("node:fs/promises").then(({ readFile }) => readFile(join(process.cwd(), "web/src/styles.css"), "utf8"));
  assert.equal(app.match(/<el-form-item label="Jenkins Job URL">/g)?.length, 2);
  assert.match(app, /const jenkinsTokenMask = "\*\*\*\*\*";[\s\S]*?jenkinsToken\.value = result\.jenkins\?\.tokenConfigured \? jenkinsTokenMask : ""/);
  assert.match(app, /const token = jenkinsToken\.value\.trim\(\);[\s\S]*?jenkins: \{[\s\S]*?username: jenkinsUsername\.value[\s\S]*?token && token !== jenkinsTokenMask \? \{ token } : \{\}[\s\S]*?clearToken: !token/);
  assert.match(app, /<label><span>Token<\/span><el-input v-model="jenkinsToken" type="password" show-password autocomplete="new-password" placeholder="Jenkins API Token" \/><\/label>/);
  assert.doesNotMatch(app, /clearJenkinsToken|Token 已配置|Token 未配置|清除已保存 Token|留空保留当前 Token/);
  assert.match(app, /class="jenkins-workspace-body"[\s\S]*?class="jenkins-build-list"[\s\S]*?class="jenkins-log-panel"/);
  assert.match(app, /v-if="workspaceProject\.jenkinsJobUrl"[\s\S]*?data-workbench-pane="jenkins"/);
  assert.match(app, /isWorkbenchPaneExpanded\('jenkins'\)[\s\S]*?toggleWorkbenchPane\('jenkins'\)/);
  assert.doesNotMatch(app, /workspaceModule|workspace-module-switch|<el-radio-button/);
  assert.match(app, /const jenkinsJobLabel = computed\(\(\) => \{[\s\S]*?decodeURIComponent\(segments\.at\(-1\) \|\| jobUrl\)/);
  assert.match(app, /class="jenkins-job-link" :href="workspaceProject\.jenkinsJobUrl" target="_blank" rel="noopener noreferrer"[\s\S]*?\{\{ jenkinsJobLabel }}/);
  assert.match(styles, /\.jenkins-job-link \{[^}]*color: var\(--accent\);[^}]*text-overflow: ellipsis/);
  assert.match(app, /async function openJenkinsBuildDialog\(\)[\s\S]*?!jenkinsJob\.value && workspaceProject\.value\?\.jenkinsJobUrl[\s\S]*?await loadJenkinsJob\(workspaceProject\.value\)[\s\S]*?jenkinsBuildDialogOpen\.value = true/);
  assert.match(app, /parameter\.multiple\s*\? \[\][\s\S]*?parameter\.type === "BooleanParameterDefinition"\s*\? false[\s\S]*?: parameter\.defaultValue \?\? parameter\.choices\[0\] \?\? ""/);
  assert.match(app, /<el-button :icon="Hammer" :loading="jenkinsBuildBusy \|\| jenkinsLoading" :disabled="jenkinsJob\?\.buildable === false" @click="openJenkinsBuildDialog">构建<\/el-button>/);
  assert.doesNotMatch(app, /<el-button[^>]*(?:v-if="isWorkbenchPaneExpanded\('jenkins'\)"|type="primary")[^>]*@click="openJenkinsBuildDialog"/);
  assert.match(app, /new EventSource\(`\/api\/projects\/\$\{project\.id}\/jenkins\/builds\/\$\{build\.number}\/logs`\)/);
  assert.match(app, /import \{ ansiToHtml \} from "\.\/ansi\.js";/);
  assert.match(app, /const jenkinsLogHtml = computed\(\(\) => ansiToHtml\(jenkinsLog\.value\)\);/);
  assert.match(app, /<code v-if="jenkinsLog" v-html="jenkinsLogHtml"><\/code>/);
  assert.match(app, /class="jenkins-log"[^>]*@copy="copyLogAsPlainText"/);
  assert.doesNotMatch(app, /<code>\{\{ jenkinsLog \}\}<\/code>/);
  assert.match(app, /<el-dialog v-model="jenkinsBuildDialogOpen"[\s\S]*?parameter\.multiple[\s\S]*?<el-checkbox[^>]*:value="choice"[\s\S]*?parameter\.type === 'BooleanParameterDefinition'[\s\S]*?parameter\.choices\.length[\s\S]*?triggerJenkinsBuild/);
  assert.match(app, /source\.addEventListener\("end", \(\) => \{[\s\S]*?source\.close\(\)[\s\S]*?loadJenkinsJob\(project\)/);
  assert.match(styles, /\.jenkins-workspace-body \{[^}]*grid-template-columns: 210px minmax\(0, 1fr\)/);
});
