<script setup>
import {
  ArrowDown,
  ArrowUp,
  Check,
  Close,
  Delete,
  Document,
  EditPen,
  FolderOpened,
  FullScreen,
  Monitor,
  Plus,
  RefreshRight,
  ScaleToOriginal,
  VideoPause,
  VideoPlay,
} from "@element-plus/icons-vue";
import { Download, Hammer, Image as ImageIcon, Palette, Pin, Settings as SettingsIcon, SlidersHorizontal, Upload } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ElCheckbox, ElCheckboxGroup, ElConfigProvider, ElMessage, ElMessageBox, ElPopover, ElSwitch, ElTooltip } from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { diffLinesWithContext, modifiedLines } from "../../src/diff.js";
import { ansiToHtml } from "./ansi.js";
import { applyTheme, readTheme, saveTheme, themeOptions } from "./theme.js";
import ElDialog from "./WindowDialog.vue";

const summary = ref(null);
const workspaceProject = ref(null);
const workspaceProjectFilter = ref("");
const workspaceProjectPage = ref(1);
const workspaceProjectPageSize = ref(10);
const workspaceProjectPageSizes = [10, 20, 50, 100];
const projectNavCollapsed = ref(false);
const projectNavResizing = ref(false);
const projectNavWidth = ref(224);
const expandedWorkbenchPanes = ref(new Set());
const workspaceSelectedService = ref("");
const configProject = ref(null);
const configFiles = ref([]);
const selectedConfigName = ref("");
const configLoading = ref(false);
const configOperationBusy = ref("");
const activeConfigTab = ref("baseline");
const previewContextCollapsed = ref(true);
const createDialogOpen = ref(false);
const createBusy = ref(false);
const newProject = ref({ name: "", confDir: "", composeFile: "", jenkinsJobUrl: "", tags: [], files: [] });
const editDialogOpen = ref(false);
const editBusy = ref(false);
const editingProjectId = ref(null);
const editedProject = ref({ name: "", confDir: "", composeFile: "", jenkinsJobUrl: "", tags: [], files: [] });
const deploymentProject = ref(null);
const deploymentServices = ref([]);
const deploymentLoading = ref(false);
const composeBusyTarget = ref("");
const composeLogsOpen = ref(false);
const composeLogsProject = ref(null);
const composeLogsService = ref("");
const composeLogSource = ref(null);
const composeLogsRef = ref(null);
const composeLogsCodeRef = ref(null);
const composeLogHasOutput = ref(false);
const composeLogLines = ref(100);
const composeLogLineOptions = [100, 200, 500, 1000, 2000, 5000];
const composeLogsFollowing = ref(true);
const composeLogsFullscreen = ref(false);
const composeLogsHeight = ref(null);
const composeLogsResizing = ref(false);
const jenkinsJob = ref(null);
const jenkinsLoading = ref(false);
const jenkinsSelectedBuild = ref(null);
const jenkinsLog = ref("");
const jenkinsLogLoading = ref(false);
const jenkinsLogSource = ref(null);
const jenkinsLogRef = ref(null);
const jenkinsBuildDialogOpen = ref(false);
const jenkinsBuildBusy = ref(false);
const jenkinsParameterValues = ref({});
const settings = ref(null);
const settingsLoading = ref(false);
const settingsSaving = ref(false);
const settingsDialogOpen = ref(false);
const backgroundDialogOpen = ref(false);
const backgroundUploading = ref(false);
const backgroundFileInput = ref(null);
const backgroundVersion = ref(Date.now());
const environment = ref("dev");
const environmentDialogOpen = ref(false);
const variableRows = ref([]);
const jenkinsUsername = ref("");
const jenkinsToken = ref("");
const jenkinsTokenMask = "*****";
const directoryDialogOpen = ref(false);
const directoryLoading = ref(false);
const directoryTarget = ref("new-conf");
const directoryPath = ref("");
const directoryParent = ref(null);
const directoryEntries = ref([]);
const fileEntries = ref([]);
const theme = ref(readTheme());
const systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
let configRequestId = 0;
let deploymentRequestId = 0;
let jenkinsRequestId = 0;
let projectPageRequestId = 0;
let projectFilterTimer = null;
let projectNavResizeCleanup = null;
let composeLogsResizeCleanup = null;
const composeLogWorker = new Worker(new URL("./compose-log.worker.js", import.meta.url), { type: "module" });
let composeLogGeneration = 0;
let composeLogDomQueue = [];
let composeLogDomFrame = null;

const tagTypes = ["primary", "success", "warning", "danger"];
const workbenchPaneDefinitions = {
  directories: { name: "directories", label: "详情", icon: FolderOpened },
  config: { name: "config", label: "配置", icon: Document },
  deployment: { name: "deployment", label: "服务", icon: VideoPlay },
  jenkins: { name: "jenkins", label: "Jenkins 部署", icon: Hammer },
};
const workspaceLocale = {
  ...zhCn,
  el: {
    ...zhCn.el,
    pagination: {
      ...zhCn.el.pagination,
      pagesize: "/页",
      total: "共 {total} 个",
    },
  },
};

function tagType(tag) {
  const hash = [...tag].reduce((value, character) => value + character.codePointAt(0), 0);
  return tagTypes[hash % tagTypes.length];
}

const workspaceProjects = computed(() => summary.value?.projects || []);
const workspaceDirectories = computed(() => workspaceProject.value ? [
  { name: "项目根目录", directory: "", path: workspaceProject.value.confDir },
  ...projectSubdirectories(workspaceProject.value).map((item) => ({ ...item, directory: item.name })),
] : []);
const visibleWorkbenchPanes = computed(() => workspaceProject.value ? [
  "directories",
  ...(workspaceProject.value.files.length ? ["config"] : []),
  ...(workspaceProject.value.composeFile ? ["deployment"] : []),
  ...(workspaceProject.value.jenkinsJobUrl ? ["jenkins"] : []),
] : []);
const visibleWorkbenchPaneItems = computed(() => visibleWorkbenchPanes.value.map((name) => workbenchPaneDefinitions[name]));
const activeWorkbenchPane = computed(() => visibleWorkbenchPanes.value.find((name) => expandedWorkbenchPanes.value.has(name)) || "");

const selectedConfig = computed(() => configFiles.value.find((file) => file.name === selectedConfigName.value) || null);
const previewLines = computed(() => selectedConfig.value
  ? modifiedLines(selectedConfig.value.baseline, selectedConfig.value.merged)
  : []);
const visiblePreviewLines = computed(() => previewContextCollapsed.value
  ? diffLinesWithContext(previewLines.value)
  : previewLines.value);
const workspaceServiceTarget = computed(() => workspaceSelectedService.value || "");
const backgroundUrl = computed(() => `/api/background?v=${backgroundVersion.value}`);
const jenkinsJobLabel = computed(() => {
  if (jenkinsJob.value?.name) return jenkinsJob.value.name;
  const jobUrl = workspaceProject.value?.jenkinsJobUrl;
  if (!jobUrl) return "Jenkins Job";
  try {
    const segments = new URL(jobUrl).pathname.split("/").filter(Boolean);
    return decodeURIComponent(segments.at(-1) || jobUrl);
  } catch {
    return jobUrl;
  }
});
const jenkinsLogHtml = computed(() => ansiToHtml(jenkinsLog.value));

function formatProjectId(id) {
  return `id ${id}`;
}

async function togglePinnedProject(project) {
  const response = await fetch(`/api/projects/${project.id}/pin`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pinned: !project.pinned }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  workspaceProjectPage.value = 1;
  await loadProjectPage();
}

function projectNavigationStatuses(project) {
  const statuses = [];
  if (project.files.length) {
    const applied = project.status === "applied";
    statuses.push({
      key: "config",
      label: applied ? "已应用" : "已恢复",
      className: applied ? "is-live" : "is-config",
      type: applied ? "success" : "primary",
    });
  }
  if (project.composeFile) {
    const running = project.deploymentStatus === "running";
    statuses.push({
      key: "deployment",
      label: running ? "运行中" : "已停止",
      className: running ? "is-live" : "is-idle",
      type: running ? "success" : "info",
    });
  }
  return statuses;
}

function projectHeaderStatuses(project) {
  const statuses = new Map(projectNavigationStatuses(project).map((status) => [status.key, status]));
  return [
    statuses.get("config") || { key: "config", label: "无配置", className: "is-idle", type: "info" },
    statuses.get("deployment") || { key: "deployment", label: "无部署", className: "is-idle", type: "info" },
  ];
}

function toggleProjectNav(event) {
  projectNavCollapsed.value = !projectNavCollapsed.value;
  if (event.detail > 0) event.currentTarget.blur();
}

function setProjectNavWidth(width) {
  projectNavWidth.value = Math.min(420, Math.max(184, width));
}

function startProjectNavResize(event) {
  event.preventDefault();
  event.currentTarget.focus();
  projectNavResizeCleanup?.();
  const startX = event.clientX;
  const startWidth = projectNavWidth.value;
  projectNavResizing.value = true;
  document.body.classList.add("is-project-nav-resizing");

  const handlePointerMove = (moveEvent) => setProjectNavWidth(startWidth + moveEvent.clientX - startX);
  const stopResize = () => projectNavResizeCleanup?.();
  projectNavResizeCleanup = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
    document.body.classList.remove("is-project-nav-resizing");
    projectNavResizing.value = false;
    projectNavResizeCleanup = null;
  };
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", stopResize, { once: true });
  window.addEventListener("pointercancel", stopResize, { once: true });
}

function handleProjectNavResizeKeydown(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  setProjectNavWidth(projectNavWidth.value + (event.key === "ArrowRight" ? 16 : -16));
}

watch(workspaceProjectFilter, () => {
  workspaceProjectPage.value = 1;
  projectPageRequestId += 1;
  window.clearTimeout(projectFilterTimer);
  projectFilterTimer = window.setTimeout(() => {
    loadProjectPage().catch((error) => ElMessage.error(error.message || String(error)));
  }, 250);
});

watch(composeLogsOpen, (open) => {
  if (!open) {
    composeLogsResizeCleanup?.();
    if (composeLogSource.value) {
      composeLogSource.value.close();
      composeLogSource.value = null;
    }
    composeLogsFullscreen.value = false;
  }
});

async function loadProjectPage({ selectFirst = false } = {}) {
  const requestId = ++projectPageRequestId;
  const parameters = new URLSearchParams({
    page: String(workspaceProjectPage.value),
    pageSize: String(workspaceProjectPageSize.value),
  });
  const query = workspaceProjectFilter.value.trim();
  if (query) parameters.set("query", query);
  const response = await fetch(`/api/status?${parameters}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  if (requestId !== projectPageRequestId) return null;
  summary.value = result;
  if (workspaceProjectPage.value !== result.page) workspaceProjectPage.value = result.page;
  const current = result.projects.find((project) => project.id === workspaceProject.value?.id);
  if (current) {
    workspaceProject.value = current;
    configProject.value = current;
    deploymentProject.value = current;
  }
  if (selectFirst && !workspaceProject.value) {
    if (result.projects[0]) await openProjectWorkspace(result.projects[0]);
    else await loadSettings();
  }
  return result;
}

async function load() {
  await loadProjectPage({ selectFirst: true });
}

function handleProjectPageChange() {
  loadProjectPage().catch((error) => ElMessage.error(error.message || String(error)));
}

function handleProjectPageSizeChange() {
  workspaceProjectPage.value = 1;
  handleProjectPageChange();
}

async function loadSettings() {
  settingsLoading.value = true;
  try {
    const response = await fetch("/api/settings");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    settings.value = result;
    environment.value = result.environment;
    variableRows.value = Object.entries(result.variables).map(([key, value]) => ({ key, value, type: typeof value }));
    jenkinsUsername.value = result.jenkins?.username || "";
    jenkinsToken.value = result.jenkins?.tokenConfigured ? jenkinsTokenMask : "";
  } finally {
    settingsLoading.value = false;
  }
}

async function refreshWorkspaceConfigs() {
  if (!workspaceProject.value) return;
  try {
    await loadProjectConfigs(workspaceProject.value, { preserve: true });
  } catch (error) {
    ElMessage.warning(`设置已更新，但配置刷新失败：${error.message || String(error)}`);
  }
}

async function openSettings() {
  settingsDialogOpen.value = true;
  try { await loadSettings(); } catch (error) {
    ElMessage.error(error.message);
    settingsDialogOpen.value = false;
  }
}

async function addEnvironment() {
  try {
    const { value } = await ElMessageBox.prompt("请输入环境名称", "新增环境", {
      confirmButtonText: "添加",
      cancelButtonText: "取消",
      inputPattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      inputErrorMessage: "只能包含字母、数字、下划线和连字符",
    });
    const response = await fetch("/api/environments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    settings.value = result;
    environment.value = result.environment;
    await refreshWorkspaceConfigs();
    ElMessage.success("环境已新增");
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error.message || String(error));
  }
}

async function editEnvironment(item) {
  try {
    const { value } = await ElMessageBox.prompt("请输入新的环境名称", `重命名 ${item}`, {
      inputValue: item,
      confirmButtonText: "保存",
      cancelButtonText: "取消",
      inputPattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      inputErrorMessage: "只能包含字母、数字、下划线和连字符",
    });
    const response = await fetch(`/api/environments/${encodeURIComponent(item)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    settings.value = result;
    environment.value = result.environment;
    await refreshWorkspaceConfigs();
    ElMessage.success("环境已重命名");
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error.message || String(error));
  }
}

async function removeEnvironment(item) {
  try {
    await ElMessageBox.confirm(`删除环境 ${item} 及所有项目在该环境下的本地配置？`, "删除环境", { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" });
    const response = await fetch(`/api/environments/${encodeURIComponent(item)}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    settings.value = result;
    environment.value = result.environment;
    await refreshWorkspaceConfigs();
    ElMessage.success("环境已删除");
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error.message || String(error));
  }
}

function addVariable() {
  variableRows.value.push({ key: "", value: "", type: "string" });
}

function changeVariableType(row) {
  if (row.type === "boolean") row.value = false;
  else if (row.type === "number") row.value = 0;
  else row.value = String(row.value ?? "");
}

async function saveSettings() {
  settingsSaving.value = true;
  try {
    const variables = {};
    for (const row of variableRows.value) {
      const key = row.key.trim();
      if (!key) throw new Error("变量名不能为空");
      if (key in variables) throw new Error(`变量名重复：${key}`);
      const value = row.type === "number" ? Number(row.value) : row.type === "boolean" ? Boolean(row.value) : String(row.value);
      if (row.type === "number" && !Number.isFinite(value)) throw new Error(`${key} 必须是有效数字`);
      variables[key] = value;
    }
    const token = jenkinsToken.value.trim();
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        environment: environment.value,
        variables,
        jenkins: {
          username: jenkinsUsername.value,
          ...(token && token !== jenkinsTokenMask ? { token } : {}),
          clearToken: !token,
        },
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    settings.value = result;
    environment.value = result.environment;
    jenkinsToken.value = result.jenkins?.tokenConfigured ? jenkinsTokenMask : "";
    await refreshWorkspaceConfigs();
    ElMessage.success("参数已保存");
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    settingsSaving.value = false;
  }
}

function openProjectEditor(project) {
  editingProjectId.value = project.id;
  editedProject.value = {
    name: project.name,
    confDir: project.confDir,
    composeFile: project.composeFile || "",
    jenkinsJobUrl: project.jenkinsJobUrl || "",
    tags: [...project.tags],
    files: [...project.files],
  };
  editDialogOpen.value = true;
}

function replaceSummaryProject(project) {
  const current = summary.value?.projects.find((item) => item.id === project.id)
    || (workspaceProject.value?.id === project.id ? workspaceProject.value : null);
  if (!current) return null;
  const updated = { ...current, ...project };
  const projects = summary.value.projects.map((item) => item.id === project.id ? updated : item);
  summary.value = { ...summary.value, projects };
  return updated;
}

async function refreshEditedProjectWorkspace(project) {
  const requests = [loadProjectConfigs(project)];
  if (project.composeFile) requests.push(loadComposeDeployment(project));
  else {
    deploymentServices.value = [];
    closeComposeLogs();
  }
  if (project.jenkinsJobUrl && isWorkbenchPaneExpanded("jenkins")) requests.push(loadJenkinsJob(project, { selectLatest: true }));
  else if (!project.jenkinsJobUrl) {
    closeJenkinsLog();
    jenkinsJob.value = null;
  }
  const results = await Promise.allSettled(requests);
  for (const result of results) {
    if (result.status === "rejected") ElMessage.warning(`项目已更新，但工作台刷新失败：${result.reason?.message || String(result.reason)}`);
  }
}

async function saveEditedProject() {
  let workspaceRefresh = null;
  editBusy.value = true;
  try {
    const response = await fetch(`/api/projects/${editingProjectId.value}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: editedProject.value.name,
        confDir: editedProject.value.confDir,
        composeFile: editedProject.value.composeFile,
        jenkinsJobUrl: editedProject.value.jenkinsJobUrl,
        tags: editedProject.value.tags.map((item) => item.trim()).filter(Boolean),
        files: editedProject.value.files.map((item) => item.trim()).filter(Boolean),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const updated = replaceSummaryProject(result.project);
    if (workspaceProject.value?.id === editingProjectId.value) {
      workspaceProject.value = updated;
      configProject.value = updated;
      deploymentProject.value = updated;
      workspaceRefresh = updated;
    }
    editDialogOpen.value = false;
    ElMessage.success("项目已更新");
    void loadProjectPage().catch((error) => ElMessage.warning(`项目已更新，但列表刷新失败：${error.message || String(error)}`));
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    editBusy.value = false;
  }
  if (workspaceRefresh) void refreshEditedProjectWorkspace(workspaceRefresh);
}

async function loadProjectConfigs(project, { preserve = false } = {}) {
  const requestId = ++configRequestId;
  if (!preserve) {
    configFiles.value = [];
    selectedConfigName.value = "";
  }
  if (!project.files.length) {
    configLoading.value = false;
    return;
  }
  configLoading.value = true;
  try {
    const response = await fetch(`/api/projects/${project.id}/configs`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (requestId !== configRequestId || configProject.value?.id !== project.id) return;
    configFiles.value = result.files;
    if (!result.files.some((file) => file.name === selectedConfigName.value)) selectedConfigName.value = result.files[0]?.name || "";
  } finally {
    if (requestId === configRequestId) configLoading.value = false;
  }
}

function closeComposeLogs() {
  composeLogSource.value?.close();
  composeLogSource.value = null;
  resetComposeLogOutput();
  composeLogsProject.value = null;
  composeLogsService.value = "";
  composeLogsOpen.value = false;
}

async function openProjectWorkspace(project) {
  closeComposeLogs();
  closeJenkinsLog();
  const current = summary.value?.projects.find((item) => item.id === project.id) || project;
  workspaceProject.value = current;
  configProject.value = current;
  deploymentProject.value = current;
  workspaceSelectedService.value = "";
  deploymentServices.value = [];
  jenkinsJob.value = null;

  const requests = [
    loadProjectConfigs(current),
    loadSettings(),
    ...(current.composeFile ? [loadComposeDeployment(current)] : []),
    ...(current.jenkinsJobUrl && isWorkbenchPaneExpanded("jenkins") ? [loadJenkinsJob(current, { selectLatest: true })] : []),
  ];
  const results = await Promise.allSettled(requests);
  for (const result of results) {
    if (result.status === "rejected") ElMessage.error(result.reason?.message || String(result.reason));
  }
}

function closeProjectWorkspace() {
  closeComposeLogs();
  closeJenkinsLog();
  workspaceProject.value = null;
  configProject.value = null;
  deploymentProject.value = null;
  deploymentServices.value = [];
  jenkinsJob.value = null;
  workspaceSelectedService.value = "";
  expandedWorkbenchPanes.value = new Set();
}

function selectWorkspaceService(service = "") {
  workspaceSelectedService.value = service;
}

function serviceRowClassName({ row }) {
  return row.name === workspaceSelectedService.value ? "is-selected-service" : "";
}

function isWorkbenchPaneExpanded(name) {
  return expandedWorkbenchPanes.value.has(name);
}

function openWorkbenchPane(name) {
  expandedWorkbenchPanes.value = new Set([name]);
  if (name === "jenkins" && !jenkinsJob.value) {
    loadJenkinsJob(workspaceProject.value, { selectLatest: true }).catch((error) => ElMessage.error(error.message || String(error)));
  }
}

function toggleWorkbenchPane(name) {
  if (expandedWorkbenchPanes.value.has(name)) {
    expandedWorkbenchPanes.value = new Set();
    return;
  }
  openWorkbenchPane(name);
}

function toggleWorkbenchPaneFromHeading(event, name) {
  const interactiveSelector = "button, a, input, textarea, select, [role='button'], [role='combobox']";
  if (event.composedPath().some((target) => target instanceof Element && target.matches(interactiveSelector))) return;
  toggleWorkbenchPane(name);
}

function workbenchPaneClasses(name) {
  return activeWorkbenchPane.value === name ? { "is-active-expanded": true } : { "is-collapsed": true };
}

async function createNewProject() {
  createBusy.value = true;
  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: newProject.value.name,
        confDir: newProject.value.confDir,
        composeFile: newProject.value.composeFile,
        jenkinsJobUrl: newProject.value.jenkinsJobUrl,
        tags: newProject.value.tags.map((item) => item.trim()).filter(Boolean),
        files: newProject.value.files.map((item) => item.trim()).filter(Boolean),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const created = result.summary.projects.find((project) => project.id === result.id);
    newProject.value = { name: "", confDir: "", composeFile: "", jenkinsJobUrl: "", tags: [], files: [] };
    createDialogOpen.value = false;
    if (created) await openProjectWorkspace(created);
    workspaceProjectPage.value = Math.max(1, Math.ceil(result.summary.total / workspaceProjectPageSize.value));
    await loadProjectPage();
    ElMessage.success("项目已创建");
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    createBusy.value = false;
  }
}

async function removeWorkspaceProject() {
  const project = workspaceProject.value;
  if (!project) return;
  const ids = [project.id];
  try {
    await ElMessageBox.confirm(`删除 ${project.name} 及其本地管理数据？`, "删除项目", { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" });
    await ElMessageBox.confirm(`此操作将永久删除 projects.yaml 中的项目，以及 data 下对应 ID ${project.id} 的全部目录。是否继续？`, "再次确认删除", { type: "error", confirmButtonText: "确认永久删除", cancelButtonText: "取消" });
    const response = await fetch("/api/projects", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    closeProjectWorkspace();
    await loadProjectPage({ selectFirst: true });
    ElMessage.success(`${project.name} 已删除`);
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error.message || String(error));
  }
}

async function operateConfig(operation) {
  if (!configProject.value) return;
  configOperationBusy.value = operation;
  const labels = { sync: "备份", restore: "恢复", apply: "应用" };
  try {
    const response = await fetch("/api/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, ids: [configProject.value.id] }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const updatedProject = result.summary.projects.find((project) => project.id === configProject.value.id);
    if (updatedProject) {
      configProject.value = updatedProject;
      workspaceProject.value = updatedProject;
      deploymentProject.value = updatedProject;
    }
    await loadProjectPage();
    try { await loadProjectConfigs(configProject.value, { preserve: true }); } catch (error) {
      ElMessage.warning(`${configProject.value.name} · ${labels[operation]}已完成，但配置刷新失败：${error.message || String(error)}`);
      return;
    }
    ElMessage.success(`${configProject.value.name} · ${labels[operation]}已完成`);
  } catch (error) {
    ElMessage.error(error.message || String(error));
  } finally {
    configOperationBusy.value = "";
  }
}

function appendComposeLog(event) {
  composeLogWorker.postMessage({ type: "append", generation: composeLogGeneration, value: JSON.parse(event.data) });
}

function scheduleComposeLogDomFlush() {
  if (composeLogDomFrame === null) composeLogDomFrame = window.requestAnimationFrame(flushComposeLogDom);
}

function flushComposeLogDom() {
  composeLogDomFrame = null;
  const code = composeLogsCodeRef.value;
  if (!code) {
    if (composeLogDomQueue.length) scheduleComposeLogDomFlush();
    return;
  }
  const deadline = performance.now() + 8;
  while (composeLogDomQueue.length && performance.now() < deadline) {
    const patch = composeLogDomQueue[0];
    if (patch.removeRemaining > 0) {
      code.firstElementChild?.remove();
      patch.removeRemaining -= 1;
      continue;
    }
    if (patch.segmentIndex < patch.segments.length) {
      const segment = patch.segments[patch.segmentIndex];
      const element = document.createElement("span");
      element.dataset.logSegmentId = String(segment.id);
      element.innerHTML = segment.html;
      code.appendChild(element);
      patch.segmentIndex += 1;
      continue;
    }
    composeLogDomQueue.shift();
  }
  composeLogHasOutput.value = code.childElementCount > 0;
  if (composeLogDomQueue.length) scheduleComposeLogDomFlush();
  else if (composeLogsFollowing.value) scrollComposeLogsToEnd();
}

function applyComposeLogPatch(event) {
  const patch = event.data;
  if (patch?.type !== "patch" || patch.generation !== composeLogGeneration) return;
  if (patch.reset) {
    composeLogDomQueue = [];
    if (composeLogDomFrame !== null) window.cancelAnimationFrame(composeLogDomFrame);
    composeLogDomFrame = null;
    composeLogsCodeRef.value?.replaceChildren();
    composeLogHasOutput.value = false;
  }
  composeLogDomQueue.push({ removeRemaining: patch.removedCount, segments: patch.segments, segmentIndex: 0 });
  scheduleComposeLogDomFlush();
}

function resetComposeLogOutput() {
  composeLogGeneration += 1;
  composeLogDomQueue = [];
  if (composeLogDomFrame !== null) window.cancelAnimationFrame(composeLogDomFrame);
  composeLogDomFrame = null;
  composeLogsCodeRef.value?.replaceChildren();
  composeLogHasOutput.value = false;
  composeLogWorker.postMessage({ type: "reset", generation: composeLogGeneration });
}

composeLogWorker.addEventListener("message", applyComposeLogPatch);
composeLogWorker.addEventListener("error", () => {
  composeLogSource.value?.close();
  composeLogSource.value = null;
  ElMessage.error("日志渲染失败，请重新打开日志");
});

function scrollComposeLogsToEnd() {
  if (!composeLogsRef.value) return;
  composeLogsRef.value.scrollTop = composeLogsRef.value.scrollHeight;
}

function updateComposeLogsFollowing() {
  const element = composeLogsRef.value;
  if (!element) return;
  composeLogsFollowing.value = element.scrollHeight - element.scrollTop - element.clientHeight <= 24;
}

function composeLogsResizeBounds() {
  const logs = composeLogsRef.value;
  const panel = logs?.closest(".workspace-logs");
  const container = panel?.offsetParent;
  if (!logs || !panel || !container) return null;
  const currentHeight = logs.getBoundingClientRect().height;
  const minHeight = Number.parseFloat(getComputedStyle(logs).minHeight) || 260;
  const availableGrowth = Math.max(0, panel.getBoundingClientRect().top - container.getBoundingClientRect().top - 16);
  return { currentHeight, minHeight, maxHeight: currentHeight + availableGrowth };
}

function setComposeLogsHeight(height, bounds = composeLogsResizeBounds()) {
  if (!bounds) return;
  composeLogsHeight.value = Math.round(Math.min(bounds.maxHeight, Math.max(bounds.minHeight, height)));
}

function startComposeLogsResize(event) {
  if (composeLogsFullscreen.value) return;
  const bounds = composeLogsResizeBounds();
  if (!bounds) return;
  event.preventDefault();
  composeLogsResizeCleanup?.();
  const startY = event.clientY;
  const startHeight = bounds.currentHeight;
  composeLogsResizing.value = true;
  document.body.classList.add("is-compose-logs-resizing");

  const handlePointerMove = (moveEvent) => setComposeLogsHeight(startHeight + startY - moveEvent.clientY, bounds);
  const stopResize = () => composeLogsResizeCleanup?.();
  composeLogsResizeCleanup = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
    document.body.classList.remove("is-compose-logs-resizing");
    composeLogsResizing.value = false;
    composeLogsResizeCleanup = null;
  };
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", stopResize, { once: true });
  window.addEventListener("pointercancel", stopResize, { once: true });
}

function handleComposeLogsResizeKeydown(event) {
  if (!composeLogsOpen.value || composeLogsFullscreen.value || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
  event.preventDefault();
  const bounds = composeLogsResizeBounds();
  if (bounds) setComposeLogsHeight(bounds.currentHeight + (event.key === "ArrowUp" ? 32 : -32), bounds);
}

function handleComposeLogsFullscreenChange() {
  if (composeLogsFollowing.value) nextTick(scrollComposeLogsToEnd);
}

function toggleComposeLogsFullscreen() {
  composeLogsResizeCleanup?.();
  composeLogsFullscreen.value = !composeLogsFullscreen.value;
  handleComposeLogsFullscreenChange();
}

function handleWorkspaceKeydown(event) {
  if (event.key === "Escape") {
    if (!composeLogsFullscreen.value) return;
    event.preventDefault();
    composeLogsFullscreen.value = false;
    return;
  }
  const target = event.target;
  const isEditing = target instanceof Element && target.matches("input, textarea, select, [contenteditable='true']");
  const isOtherResizeHandle = target instanceof Element && target.matches(".workbench-project-nav-resizer");
  const hasCommandModifier = event.ctrlKey || event.metaKey || event.altKey;
  if (!event.defaultPrevented && !isEditing && !isOtherResizeHandle && !hasCommandModifier && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    handleComposeLogsResizeKeydown(event);
    return;
  }
  const isPlainKey = event.key.length === 1 && Boolean(event.key.trim());
  if (!composeLogsOpen.value || event.defaultPrevented || event.isComposing || hasCommandModifier || isEditing || !isPlainKey) return;
  composeLogsFollowing.value = true;
  nextTick(scrollComposeLogsToEnd);
}

function applyDeployment(deployment, preserveServiceOrder = false) {
  if (preserveServiceOrder && deploymentServices.value.length) {
    const nextServices = new Map(deployment.services.map((service) => [service.name, service]));
    const currentNames = new Set(deploymentServices.value.map((service) => service.name));
    deploymentServices.value = [
      ...deploymentServices.value.map((service) => nextServices.get(service.name)).filter(Boolean),
      ...deployment.services.filter((service) => !currentNames.has(service.name)),
    ];
  } else {
    deploymentServices.value = deployment.services;
  }
  if (workspaceSelectedService.value && !deploymentServices.value.some((service) => service.name === workspaceSelectedService.value)) {
    workspaceSelectedService.value = "";
  }
  const project = summary.value?.projects.find((item) => item.id === deploymentProject.value?.id);
  if (project) {
    project.deploymentStatus = deployment.status;
    if (workspaceProject.value?.id === project.id) workspaceProject.value = project;
  }
}

function composePortLabel(port) {
  const protocol = port.protocol ? `/${port.protocol}` : "";
  const target = `${port.targetPort}${protocol}`;
  if (!port.publishedPort) return target;
  const host = port.hostIp && !["0.0.0.0", "::"].includes(port.hostIp)
    ? `${port.hostIp.includes(":") ? `[${port.hostIp}]` : port.hostIp}:`
    : "";
  return `${host}${port.publishedPort} -> ${target}`;
}

function servicePortItems(ports) {
  const items = new Map();
  for (const port of ports) {
    const label = composePortLabel(port);
    if (!items.has(label)) items.set(label, {
      label,
      href: port.publishedPort ? `http://127.0.0.1:${port.publishedPort}` : "",
    });
  }
  return [...items.values()];
}

async function loadComposeDeployment(project) {
  const requestId = ++deploymentRequestId;
  deploymentLoading.value = true;
  try {
    const response = await fetch(`/api/projects/${project.id}/compose`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (requestId !== deploymentRequestId || deploymentProject.value?.id !== project.id) return;
    applyDeployment(result.deployment);
  } finally {
    if (requestId === deploymentRequestId) deploymentLoading.value = false;
  }
}

function startComposeLogStream() {
  composeLogSource.value?.close();
  resetComposeLogOutput();
  composeLogsFollowing.value = true;
  const query = new URLSearchParams({ tail: String(composeLogLines.value) });
  if (composeLogsService.value) query.set("service", composeLogsService.value);
  const source = new EventSource(`/api/projects/${composeLogsProject.value.id}/compose/logs?${query}`);
  composeLogSource.value = source;
  source.onmessage = (event) => {
    if (composeLogSource.value === source) appendComposeLog(event);
  };
  source.addEventListener("compose-error", (event) => {
    ElMessage.error(JSON.parse(event.data));
    source.close();
  });
  source.addEventListener("end", () => source.close());
  source.onerror = () => {
    if (composeLogSource.value === source) source.close();
  };
}

function openComposeLogs(project, service = "") {
  composeLogsProject.value = project;
  composeLogsService.value = service;
  composeLogsOpen.value = true;
  startComposeLogStream();
}

async function runComposeFromLogs(operation) {
  if (!composeLogsProject.value) return;
  const succeeded = await runCompose(composeLogsProject.value, operation, composeLogsService.value);
  if (succeeded && composeLogsOpen.value) startComposeLogStream();
}

async function runCompose(project, operation, service = "") {
  if (operation === "logs") return openComposeLogs(project, service);
  const targetName = service ? `${project.name} · ${service}` : project.name;
  const busyTarget = `${service || "*"}:${operation}`;
  try {
    composeBusyTarget.value = busyTarget;
    const response = await fetch(`/api/projects/${project.id}/compose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, ...(service ? { service } : {}) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    applyDeployment(result.deployment, true);
    ElMessage.success(`${targetName} · compose ${operation} 已完成`);
    return true;
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error.message || String(error));
    return false;
  } finally {
    composeBusyTarget.value = "";
  }
}

function closeJenkinsLog() {
  jenkinsRequestId += 1;
  jenkinsLogSource.value?.close();
  jenkinsLogSource.value = null;
  jenkinsLoading.value = false;
  jenkinsLogLoading.value = false;
  jenkinsLog.value = "";
  jenkinsSelectedBuild.value = null;
}

function updateJenkinsLogFollowing() {
  const element = jenkinsLogRef.value;
  if (!element) return;
  element.dataset.following = String(element.scrollHeight - element.scrollTop - element.clientHeight <= 24);
}

function copyLogAsPlainText(event) {
  const selection = window.getSelection();
  if (!selection || !event.clipboardData) return;
  event.preventDefault();
  event.clipboardData.clearData();
  event.clipboardData.setData("text/plain", selection.toString());
}

function appendJenkinsLog(chunk) {
  const following = jenkinsLogRef.value?.dataset.following !== "false";
  jenkinsLog.value = `${jenkinsLog.value}${chunk}`.slice(-2_000_000);
  if (following) nextTick(() => {
    if (jenkinsLogRef.value) jenkinsLogRef.value.scrollTop = jenkinsLogRef.value.scrollHeight;
  });
}

function startJenkinsLog(build) {
  jenkinsLogSource.value?.close();
  jenkinsSelectedBuild.value = build;
  jenkinsLog.value = "";
  jenkinsLogLoading.value = true;
  const project = workspaceProject.value;
  if (!project) return;
  const source = new EventSource(`/api/projects/${project.id}/jenkins/builds/${build.number}/logs`);
  jenkinsLogSource.value = source;
  source.addEventListener("message", (event) => {
    if (jenkinsLogSource.value === source) appendJenkinsLog(JSON.parse(event.data));
  });
  source.addEventListener("end", () => {
    if (jenkinsLogSource.value !== source) return;
    jenkinsLogLoading.value = false;
    source.close();
    jenkinsLogSource.value = null;
    loadJenkinsJob(project).catch((error) => ElMessage.error(error.message || String(error)));
  });
  source.addEventListener("jenkins-error", (event) => {
    if (jenkinsLogSource.value !== source) return;
    jenkinsLogLoading.value = false;
    ElMessage.error(JSON.parse(event.data));
    source.close();
    jenkinsLogSource.value = null;
  });
  source.onerror = () => {
    if (jenkinsLogSource.value !== source) return;
    jenkinsLogLoading.value = false;
    source.close();
    jenkinsLogSource.value = null;
  };
}

async function loadJenkinsJob(project = workspaceProject.value, { selectLatest = false } = {}) {
  if (!project?.jenkinsJobUrl) return;
  const requestId = ++jenkinsRequestId;
  jenkinsLoading.value = true;
  try {
    const response = await fetch(`/api/projects/${project.id}/jenkins`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    if (requestId !== jenkinsRequestId || workspaceProject.value?.id !== project.id) return;
    jenkinsJob.value = result.job;
    const selected = result.job.builds.find((build) => build.number === jenkinsSelectedBuild.value?.number);
    if (selectLatest || !selected) {
      if (result.job.builds[0]) startJenkinsLog(result.job.builds[0]);
      else closeJenkinsLog();
    } else jenkinsSelectedBuild.value = selected;
  } finally {
    if (requestId === jenkinsRequestId) jenkinsLoading.value = false;
  }
}

async function openJenkinsBuildDialog() {
  if (!jenkinsJob.value && workspaceProject.value?.jenkinsJobUrl) {
    try { await loadJenkinsJob(workspaceProject.value); }
    catch (error) {
      ElMessage.error(error.message || String(error));
      return;
    }
  }
  if (!jenkinsJob.value) return;
  jenkinsParameterValues.value = Object.fromEntries(jenkinsJob.value.parameters.map((parameter) => [
    parameter.name,
    parameter.multiple
      ? []
      : parameter.type === "BooleanParameterDefinition"
        ? false
        : parameter.defaultValue ?? parameter.choices[0] ?? "",
  ]));
  jenkinsBuildDialogOpen.value = true;
}

async function triggerJenkinsBuild() {
  const project = workspaceProject.value;
  if (!project) return;
  const previousNumber = jenkinsJob.value?.builds[0]?.number || 0;
  jenkinsBuildBusy.value = true;
  try {
    const response = await fetch(`/api/projects/${project.id}/jenkins/builds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parameters: jenkinsParameterValues.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    jenkinsBuildDialogOpen.value = false;
    ElMessage.success("Jenkins 构建已创建");
    for (let attempt = 0; attempt < 15 && workspaceProject.value?.id === project.id; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 1000));
      await loadJenkinsJob(project);
      const latest = jenkinsJob.value?.builds[0];
      if (latest && latest.number > previousNumber) {
        startJenkinsLog(latest);
        break;
      }
    }
  } catch (error) {
    ElMessage.error(error.message || String(error));
  } finally {
    jenkinsBuildBusy.value = false;
  }
}

function jenkinsBuildStatus(build) {
  if (build.building) return { label: "构建中", type: "primary", className: "is-live" };
  if (build.result === "SUCCESS") return { label: "成功", type: "success", className: "is-config" };
  if (build.result === "FAILURE") return { label: "失败", type: "danger", className: "" };
  if (build.result === "ABORTED") return { label: "已取消", type: "info", className: "is-idle" };
  return { label: build.result || "等待中", type: "warning", className: "" };
}

function formatJenkinsTime(timestamp) {
  return timestamp ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp) : "--";
}

function formatJenkinsDuration(duration) {
  if (!duration) return "--";
  const seconds = Math.round(duration / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function projectSubdirectories(project) {
  const directories = project.files
    .map((file) => file.replace(/\\/g, "/").split("/"))
    .filter((segments) => segments.length > 1)
    .map((segments) => segments[0]);
  return [...new Set(directories)].map((name) => ({
    name,
    path: `${project.confDir.replace(/[\\/]+$/, "")}/${name}`,
  }));
}

async function openProjectDirectory(project, directory = "") {
  try {
    const response = await fetch(`/api/projects/${project.id}/open-directory`, {
      method: "POST",
      ...(directory ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory }),
      } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const path = directory ? `${project.confDir.replace(/[\\/]+$/, "")}/${directory}` : project.confDir;
    ElMessage.success(`已打开 ${path}`);
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function openProjectTerminal(project, directory = "") {
  try {
    const response = await fetch(`/api/projects/${project.id}/open-terminal`, {
      method: "POST",
      ...(directory ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory }),
      } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const path = directory ? `${project.confDir.replace(/[\\/]+$/, "")}/${directory}` : project.confDir;
    ElMessage.success(`已在终端打开 ${path}`);
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function openProjectCode(project, directory = "") {
  try {
    const response = await fetch(`/api/projects/${project.id}/open-vscode`, {
      method: "POST",
      ...(directory ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory }),
      } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const path = directory ? `${project.confDir.replace(/[\\/]+$/, "")}/${directory}` : project.confDir;
    ElMessage.success(`已在 VS Code 打开 ${path}`);
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function openProjectZed(project, directory = "") {
  try {
    const response = await fetch(`/api/projects/${project.id}/open-zed`, {
      method: "POST",
      ...(directory ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ directory }),
      } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const path = directory ? `${project.confDir.replace(/[\\/]+$/, "")}/${directory}` : project.confDir;
    ElMessage.success(`已在 Zed 打开 ${path}`);
  } catch (error) {
    ElMessage.error(error.message);
  }
}

async function openGame(project, target) {
  try {
    const response = await fetch(`/api/projects/${project.id}/open-game-${target}`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    ElMessage.success(target === "client" ? "游戏客户端已启动" : "游戏服务器已启动");
  } catch (error) {
    ElMessage.error(error.message || String(error));
  }
}

async function loadDirectories(path) {
  directoryLoading.value = true;
  try {
    const response = await fetch(`/api/directories?path=${encodeURIComponent(path)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    directoryPath.value = result.path;
    directoryParent.value = result.parent;
    directoryEntries.value = result.directories;
    fileEntries.value = result.files;
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    directoryLoading.value = false;
  }
}

function browseProjectDirectory(targetName) {
  directoryTarget.value = targetName;
  directoryDialogOpen.value = true;
  const project = targetName.startsWith("new-") ? newProject.value : editedProject.value;
  const safePath = (path) => path && !path.startsWith("/") && !path.includes("..") && !/^[A-Za-z]:/.test(path) ? path : "";
  const projectDirectory = safePath(project.confDir);
  const composeParent = safePath(project.composeFile).split("/").slice(0, -1).join("/");
  const initialPath = targetName.endsWith("compose") ? composeParent || projectDirectory : projectDirectory;
  loadDirectories(initialPath);
}

function isDirectoryFileTarget() {
  return directoryTarget.value.endsWith("compose") || directoryTarget.value.endsWith("files");
}

function chooseProjectDirectory() {
  const project = directoryTarget.value.startsWith("new-") ? newProject.value : editedProject.value;
  project.confDir = directoryPath.value;
  directoryDialogOpen.value = false;
}

function chooseComposeFile(path) {
  const project = directoryTarget.value.startsWith("new-") ? newProject.value : editedProject.value;
  project.composeFile = path;
  directoryDialogOpen.value = false;
}

function chooseProjectConfigFile(path) {
  const project = directoryTarget.value.startsWith("new-") ? newProject.value : editedProject.value;
  const projectDirectory = project.confDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const prefix = `${projectDirectory}/`;
  if (!projectDirectory || !path.startsWith(prefix)) {
    ElMessage.error("配置文件必须位于项目目录内");
    return;
  }
  const relativePath = path.slice(prefix.length);
  if (!project.files.includes(relativePath)) project.files.push(relativePath);
  directoryDialogOpen.value = false;
}

function removeProjectTag(project, tag) {
  project.tags = project.tags.filter((item) => item !== tag);
}

function removeProjectFile(project, file) {
  project.files = project.files.filter((item) => item !== file);
}

function updateTheme(value) {
  theme.value = saveTheme(value);
}

function openBackgroundSettings() {
  backgroundVersion.value = Date.now();
  backgroundDialogOpen.value = true;
}

function chooseBackgroundImage() {
  backgroundFileInput.value?.click();
}

async function replaceBackgroundImage(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  const supportedTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
  if (!supportedTypes.has(file.type)) {
    ElMessage.error("请选择 PNG、JPEG、WebP、GIF 或 AVIF 图片");
    input.value = "";
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    ElMessage.error("背景图片不能超过 20 MB");
    input.value = "";
    return;
  }
  backgroundUploading.value = true;
  try {
    const response = await fetch("/api/background", {
      method: "PUT",
      headers: { "content-type": file.type },
      body: file,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    backgroundVersion.value = Date.now();
    document.documentElement.style.setProperty("--theme-bg-image", `url("${backgroundUrl.value}")`);
    ElMessage.success("背景已更换");
  } catch (error) {
    ElMessage.error(error.message || String(error));
  } finally {
    backgroundUploading.value = false;
    input.value = "";
  }
}

async function downloadBackgroundImage() {
  try {
    const response = await fetch("/api/background?download=1", { cache: "no-store" });
    if (!response.ok) throw new Error("背景下载失败");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = response.headers.get("x-background-filename") || "owner-config-background";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    ElMessage.error(error.message || String(error));
  }
}

function handleSystemThemeChange() {
  if (theme.value === "system") applyTheme(theme.value);
}

onMounted(() => {
  systemThemeMedia.addEventListener("change", handleSystemThemeChange);
  window.addEventListener("keydown", handleWorkspaceKeydown, true);
  load().catch((error) => ElMessage.error(error.message));
});
onBeforeUnmount(() => {
  systemThemeMedia.removeEventListener("change", handleSystemThemeChange);
  window.removeEventListener("keydown", handleWorkspaceKeydown, true);
  composeLogSource.value?.close();
  jenkinsLogSource.value?.close();
  projectNavResizeCleanup?.();
  window.clearTimeout(projectFilterTimer);
  composeLogsResizeCleanup?.();
  if (composeLogDomFrame !== null) window.cancelAnimationFrame(composeLogDomFrame);
  composeLogWorker.terminate();
});
</script>

<template>
  <el-config-provider :locale="workspaceLocale">
  <el-container class="shell">
    <el-main class="workspace is-project-workspace">
      <section class="project-workbench">
        <header class="workbench-heading">
          <div class="workbench-heading-main">
            <span class="brand-mark" aria-hidden="true"><i></i></span>
            <div class="workbench-title-row">
              <h1>工作台</h1>
              <strong class="workbench-project-title" :title="workspaceProject?.name || '未选择项目'">{{ workspaceProject?.name || "未选择" }}</strong>
              <span class="workbench-project-id">{{ workspaceProject ? formatProjectId(workspaceProject.id) : "--" }}</span>
              <div class="workbench-heading-statuses" aria-label="项目状态">
                <el-tag v-for="status in workspaceProject ? projectHeaderStatuses(workspaceProject) : projectHeaderStatuses({ files: [], composeFile: '' })" :key="status.key" class="status-beacon" :class="status.className" :type="status.type" effect="light">{{ status.label }}</el-tag>
              </div>
            </div>
          </div>
          <div class="workbench-heading-actions">
            <el-popover trigger="hover" placement="bottom" :show-after="100" :hide-after="180" popper-class="settings-popover">
              <template #reference>
                <el-button class="settings-menu-trigger" text circle :icon="SettingsIcon" aria-label="设置" title="设置" />
              </template>
              <div class="settings-menu" role="menu" aria-label="设置">
                <el-dropdown trigger="click" placement="bottom-start" popper-class="theme-dropdown" @command="updateTheme">
                  <el-button class="settings-menu-item" :icon="Palette">主题</el-button>
                  <template #dropdown>
                    <el-dropdown-menu aria-label="主题模式">
                      <el-dropdown-item v-for="option in themeOptions" :key="option.value" :command="option.value" :class="{ 'is-active': theme === option.value }">
                        <el-icon class="theme-option-check"><Check v-if="theme === option.value" /></el-icon>
                        <span>{{ option.label }}</span>
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
                <el-button class="settings-menu-item" :icon="ImageIcon" @click="openBackgroundSettings">背景</el-button>
                <el-button class="settings-menu-item" :icon="SlidersHorizontal" @click="openSettings">参数</el-button>
              </div>
            </el-popover>
          </div>
        </header>

        <div class="workbench-layout" :class="{ 'is-project-nav-collapsed': projectNavCollapsed, 'is-project-nav-resizing': projectNavResizing }" :style="{ '--project-nav-width': `${projectNavWidth}px` }">
          <aside class="workbench-project-nav">
            <div class="workbench-nav-heading">
              <span>项目</span>
              <el-tooltip :content="projectNavCollapsed ? '固定侧栏' : '折叠侧栏'" placement="right">
                <el-button class="workbench-nav-collapse workbench-pin-button" text circle :icon="Pin" :aria-label="projectNavCollapsed ? '固定侧栏' : '折叠侧栏'" :aria-expanded="!projectNavCollapsed" @click="toggleProjectNav" />
              </el-tooltip>
            </div>
            <div class="workbench-nav-actions">
              <el-tooltip content="新建项目" placement="top"><el-button text circle :icon="Plus" aria-label="新建项目" @click="createDialogOpen = true" /></el-tooltip>
              <el-tooltip content="删除当前项目" placement="top"><el-button text circle type="danger" :icon="Delete" aria-label="删除当前项目" :disabled="!workspaceProject" @click="removeWorkspaceProject" /></el-tooltip>
            </div>
            <el-input v-model="workspaceProjectFilter" clearable placeholder="搜索项目" />
            <div class="workbench-project-list">
              <div
                v-for="project in workspaceProjects"
                :key="project.id"
                class="workbench-project-item"
                :class="{ 'is-active': project.id === workspaceProject?.id }"
              >
                <button type="button" class="workbench-project-select" @click="openProjectWorkspace(project)">
                  <span class="workbench-project-name">{{ project.name }}</span>
                  <span v-if="projectNavigationStatuses(project).length" class="workbench-project-states">
                    <span v-for="status in projectNavigationStatuses(project)" :key="status.key" class="workbench-project-state status-beacon" :class="status.className">
                      {{ status.label }}
                    </span>
                  </span>
                </button>
                <el-tooltip :content="project.pinned ? '取消置顶' : '置顶项目'" placement="right">
                  <el-button
                    class="workbench-project-pin workbench-pin-button"
                    :class="{ 'is-pinned': project.pinned }"
                    text
                    circle
                    :icon="Pin"
                    :aria-label="project.pinned ? `取消置顶 ${project.name}` : `置顶 ${project.name}`"
                    :aria-pressed="project.pinned"
                    @click="togglePinnedProject(project).catch((error) => ElMessage.error(error.message || String(error)))"
                  />
                </el-tooltip>
              </div>
            </div>
            <el-pagination
              v-model:current-page="workspaceProjectPage"
              v-model:page-size="workspaceProjectPageSize"
              class="workbench-project-pagination"
              small
              layout="sizes, total, prev, next"
              :page-sizes="workspaceProjectPageSizes"
              :total="summary?.total || 0"
              @current-change="handleProjectPageChange"
              @size-change="handleProjectPageSizeChange"
            />
            <div
              class="workbench-project-nav-resizer"
              role="separator"
              aria-label="调整项目侧栏宽度"
              aria-orientation="vertical"
              :aria-valuenow="projectNavWidth"
              aria-valuemin="184"
              aria-valuemax="420"
              tabindex="0"
              @pointerdown="startProjectNavResize"
              @keydown="handleProjectNavResizeKeydown"
            ></div>
          </aside>

          <div class="workbench-content">
            <template v-if="workspaceProject">
            <div class="workbench-grid" :class="{ 'is-config-only': !workspaceProject.composeFile, 'has-expanded-pane': activeWorkbenchPane }">
              <nav v-if="activeWorkbenchPane" class="workbench-pane-switcher" aria-label="模块切换">
                <el-tooltip v-for="item in visibleWorkbenchPaneItems" :key="item.name" :content="item.label" placement="bottom">
                  <button
                    type="button"
                    class="workbench-pane-switch"
                    :class="{ 'is-selected': activeWorkbenchPane === item.name }"
                    :aria-label="item.label"
                    :aria-pressed="activeWorkbenchPane === item.name"
                    @click="openWorkbenchPane(item.name)"
                  >
                    <el-icon><component :is="item.icon" /></el-icon>
                  </button>
                </el-tooltip>
              </nav>
              <section
                class="workbench-pane directory-workbench-pane"
                :class="workbenchPaneClasses('directories')"
                data-workbench-pane="directories"
              >
                <div class="workbench-pane-heading" @click="toggleWorkbenchPaneFromHeading($event, 'directories')">
                  <div class="workbench-pane-heading-main">
                    <el-tooltip :content="isWorkbenchPaneExpanded('directories') ? '折叠详情' : '展开详情'">
                      <el-button text circle :icon="isWorkbenchPaneExpanded('directories') ? ArrowUp : ArrowDown" :aria-label="isWorkbenchPaneExpanded('directories') ? '折叠详情' : '展开详情'" @click.stop="toggleWorkbenchPane('directories')" />
                    </el-tooltip>
                    <div>
                      <h2>详情</h2>
                      <span>项目根目录与直接子目录</span>
                    </div>
                  </div>
                  <div class="workbench-pane-heading-controls">
                    <template v-if="!isWorkbenchPaneExpanded('directories')">
                      <template v-if="workspaceProject.tags.includes('game')">
                        <el-button :icon="FolderOpened" @click="openProjectDirectory(workspaceProject)">打开</el-button>
                        <el-button :icon="VideoPlay" @click="openGame(workspaceProject, 'client')">启动客户端</el-button>
                        <el-button :icon="VideoPlay" @click="openGame(workspaceProject, 'server')">启动服务器</el-button>
                      </template>
                      <template v-else>
                        <el-button :icon="FolderOpened" @click="openProjectDirectory(workspaceProject)">打开</el-button>
                        <el-button :icon="Monitor" @click="openProjectTerminal(workspaceProject)">终端打开</el-button>
                        <el-button :icon="EditPen" @click="openProjectCode(workspaceProject)">VS Code 打开</el-button>
                        <el-button :icon="EditPen" @click="openProjectZed(workspaceProject)">Zed 打开</el-button>
                      </template>
                    </template>
                    <el-button aria-label="编辑项目" @click="openProjectEditor(workspaceProject)">编辑</el-button>
                  </div>
                </div>
                <div v-show="isWorkbenchPaneExpanded('directories')" class="project-directories-body">
                  <div class="project-directory-table-heading"><span>目录</span><span>操作</span></div>
                  <div v-for="item in workspaceDirectories" :key="item.directory || 'root'" class="project-directory-row">
                    <div class="project-directory-name">
                      <el-icon><FolderOpened /></el-icon>
                      <span><strong>{{ item.name }}</strong><code>{{ item.path }}</code></span>
                    </div>
                    <div v-if="workspaceProject.tags.includes('game')" class="project-directory-actions">
                      <el-button :icon="FolderOpened" @click="openProjectDirectory(workspaceProject, item.directory)">打开</el-button>
                      <template v-if="!item.directory">
                        <el-button :icon="VideoPlay" @click="openGame(workspaceProject, 'client')">启动客户端</el-button>
                        <el-button :icon="VideoPlay" @click="openGame(workspaceProject, 'server')">启动服务器</el-button>
                      </template>
                    </div>
                    <div v-else class="project-directory-actions">
                      <el-button :icon="FolderOpened" @click="openProjectDirectory(workspaceProject, item.directory)">打开</el-button>
                      <el-button :icon="Monitor" @click="openProjectTerminal(workspaceProject, item.directory)">终端打开</el-button>
                      <el-button :icon="EditPen" @click="openProjectCode(workspaceProject, item.directory)">VS Code 打开</el-button>
                      <el-button :icon="EditPen" @click="openProjectZed(workspaceProject, item.directory)">Zed 打开</el-button>
                    </div>
                  </div>
                </div>
              </section>

              <section
                v-if="workspaceProject.files.length"
                class="workbench-pane config-workbench-pane"
                :class="workbenchPaneClasses('config')"
                data-workbench-pane="config"
              >
                <div class="workbench-pane-heading" @click="toggleWorkbenchPaneFromHeading($event, 'config')">
                  <div class="workbench-pane-heading-main">
                    <el-tooltip :content="isWorkbenchPaneExpanded('config') ? '折叠配置' : '展开配置'">
                      <el-button text circle :icon="isWorkbenchPaneExpanded('config') ? ArrowUp : ArrowDown" :aria-label="isWorkbenchPaneExpanded('config') ? '折叠配置' : '展开配置'" @click.stop="toggleWorkbenchPane('config')" />
                    </el-tooltip>
                    <div>
                      <h2>配置</h2>
                      <span>模板、本地覆盖与最终合并结果</span>
                    </div>
                  </div>
                  <div class="workbench-pane-heading-controls">
                    <div class="workbench-pane-actions">
                      <el-button v-if="isWorkbenchPaneExpanded('config') && activeConfigTab === 'merged'" @click="previewContextCollapsed = !previewContextCollapsed">{{ previewContextCollapsed ? '展开' : '折叠' }}</el-button>
                      <el-button :loading="configOperationBusy === 'sync'" :disabled="workspaceProject.status === 'applied'" @click="operateConfig('sync')">备份</el-button>
                      <el-button :loading="configOperationBusy === 'restore'" @click="operateConfig('restore')">恢复</el-button>
                      <el-button :loading="configOperationBusy === 'apply'" @click="operateConfig('apply')">应用</el-button>
                    </div>
                  </div>
                </div>
                <div v-show="isWorkbenchPaneExpanded('config')" v-loading="configLoading" class="config-workspace-body">
                  <nav class="config-file-list" aria-label="配置文件">
                    <button
                      v-for="file in configFiles"
                      :key="file.name"
                      type="button"
                      :class="{ 'is-active': selectedConfigName === file.name }"
                      @click="selectedConfigName = file.name"
                    ><el-icon><Document /></el-icon><span>{{ file.name }}</span></button>
                  </nav>
                  <div v-if="selectedConfig" class="config-tabs-row">
                    <el-tabs v-model="activeConfigTab" class="config-tabs">
                      <el-tab-pane label="模板配置" name="baseline">
                        <div class="editor-toolbar">
                          <code>{{ selectedConfig.name }}</code>
                        </div>
                        <pre class="config-code">{{ selectedConfig.baseline }}</pre>
                      </el-tab-pane>
                      <el-tab-pane label="本地配置" name="local">
                        <div class="editor-toolbar">
                          <code>{{ selectedConfig.name }}</code>
                        </div>
                        <pre class="config-code">{{ selectedConfig.local ?? "" }}</pre>
                      </el-tab-pane>
                      <el-tab-pane label="合并预览" name="merged">
                        <div class="diff-code" aria-label="合并配置差异">
                          <div v-for="(line, index) in visiblePreviewLines" :key="index" class="diff-line" :class="`is-${line.kind}`">
                            <span class="line-number">{{ line.number }}</span><span class="line-marker">{{ line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : '' }}</span><span class="line-content">{{ line.text || ' ' }}</span>
                          </div>
                          <div v-if="!visiblePreviewLines.length" class="diff-empty">合并结果无差异</div>
                        </div>
                      </el-tab-pane>
                    </el-tabs>
                  </div>
                  <div v-else-if="!configLoading" class="workbench-empty">暂无配置文件</div>
                </div>
              </section>

              <section
                v-if="workspaceProject.composeFile"
                class="workbench-pane deployment-workbench-pane"
                :class="workbenchPaneClasses('deployment')"
                data-workbench-pane="deployment"
              >
                <div class="workbench-pane-heading deployment-pane-heading" @click="toggleWorkbenchPaneFromHeading($event, 'deployment')">
                  <div class="workbench-pane-heading-main">
                    <el-tooltip :content="isWorkbenchPaneExpanded('deployment') ? '折叠服务' : '展开服务'">
                      <el-button text circle :icon="isWorkbenchPaneExpanded('deployment') ? ArrowUp : ArrowDown" :aria-label="isWorkbenchPaneExpanded('deployment') ? '折叠服务' : '展开服务'" @click.stop="toggleWorkbenchPane('deployment')" />
                    </el-tooltip>
                    <div>
                      <h2>服务</h2>
                      <span>{{ workspaceProject.composeFile }}</span>
                    </div>
                  </div>
                  <div class="workbench-pane-heading-controls">
                    <template v-if="!isWorkbenchPaneExpanded('deployment')">
                      <el-button :icon="VideoPlay" :loading="composeBusyTarget === '*:up'" @click="runCompose(deploymentProject, 'up')">启动</el-button>
                      <el-button :icon="VideoPause" :loading="composeBusyTarget === '*:down'" @click="runCompose(deploymentProject, 'down')">停止</el-button>
                      <el-button :icon="RefreshRight" :loading="composeBusyTarget === '*:restart'" @click="runCompose(deploymentProject, 'restart')">重启</el-button>
                      <el-button :icon="Document" @click="openComposeLogs(deploymentProject)">日志</el-button>
                    </template>
                  </div>
                </div>
                <div v-show="isWorkbenchPaneExpanded('deployment')" class="deployment-workspace-body">
                  <div class="deployment-target-toolbar">
                  <el-select v-model="workspaceSelectedService" aria-label="操作目标" placeholder="全部服务">
                    <el-option label="全部服务" value="" />
                    <el-option v-for="service in deploymentServices" :key="service.name" :label="service.name" :value="service.name" />
                  </el-select>
                  <div class="deployment-operation-toolbar">
                    <el-button :icon="VideoPlay" :loading="composeBusyTarget === `${workspaceServiceTarget || '*'}:up`" @click="runCompose(deploymentProject, 'up', workspaceServiceTarget)">启动</el-button>
                    <el-button :icon="VideoPause" :loading="composeBusyTarget === `${workspaceServiceTarget || '*'}:down`" @click="runCompose(deploymentProject, 'down', workspaceServiceTarget)">停止</el-button>
                    <el-button :icon="RefreshRight" :loading="composeBusyTarget === `${workspaceServiceTarget || '*'}:restart`" @click="runCompose(deploymentProject, 'restart', workspaceServiceTarget)">重启</el-button>
                    <el-button :icon="Document" @click="openComposeLogs(deploymentProject, workspaceServiceTarget)">日志</el-button>
                  </div>
                  </div>
                  <el-table
                  v-loading="deploymentLoading"
                  :data="deploymentServices"
                  :row-class-name="serviceRowClassName"
                  class="service-table"
                  empty-text="Compose 文件中没有服务"
                  @row-click="selectWorkspaceService($event.name)"
                >
                  <el-table-column prop="name" label="Service" min-width="150" />
                  <el-table-column label="端口" min-width="180">
                    <template #default="{ row }">
                      <div v-if="row.ports.length" class="service-ports">
                        <template v-for="port in servicePortItems(row.ports)" :key="port.label">
                          <a v-if="row.status === 'running' && port.href" class="service-port-link" :href="port.href" target="_blank" rel="noopener noreferrer" @click.stop><code>{{ port.label }}</code></a>
                          <code v-else>{{ port.label }}</code>
                        </template>
                      </div>
                      <span v-else class="service-ports-empty">-</span>
                    </template>
                  </el-table-column>
                  <el-table-column label="状态" width="96">
                    <template #default="{ row }"><el-tag class="status-beacon" :class="row.status === 'running' ? 'is-live' : 'is-idle'" :type="row.status === 'running' ? 'success' : 'info'" effect="light">{{ row.status === 'running' ? '运行中' : '已停止' }}</el-tag></template>
                  </el-table-column>
                  </el-table>
                </div>
              </section>

              <section
                v-if="workspaceProject.jenkinsJobUrl"
                class="workbench-pane jenkins-workbench-pane"
                :class="workbenchPaneClasses('jenkins')"
                data-workbench-pane="jenkins"
              >
              <div class="workbench-pane-heading jenkins-pane-heading" @click="toggleWorkbenchPaneFromHeading($event, 'jenkins')">
                <div class="workbench-pane-heading-main">
                  <el-tooltip :content="isWorkbenchPaneExpanded('jenkins') ? '折叠 Jenkins' : '展开 Jenkins'">
                    <el-button text circle :icon="isWorkbenchPaneExpanded('jenkins') ? ArrowUp : ArrowDown" :aria-label="isWorkbenchPaneExpanded('jenkins') ? '折叠 Jenkins' : '展开 Jenkins'" @click.stop="toggleWorkbenchPane('jenkins')" />
                  </el-tooltip>
                  <div>
                    <h2>Jenkins 部署</h2>
                    <a class="jenkins-job-link" :href="workspaceProject.jenkinsJobUrl" target="_blank" rel="noopener noreferrer" :title="workspaceProject.jenkinsJobUrl">{{ jenkinsJobLabel }}</a>
                  </div>
                </div>
                <div class="workbench-pane-heading-controls">
                  <el-button :icon="Hammer" :loading="jenkinsBuildBusy || jenkinsLoading" :disabled="jenkinsJob?.buildable === false" @click="openJenkinsBuildDialog">构建</el-button>
                </div>
              </div>
              <div v-show="isWorkbenchPaneExpanded('jenkins')" v-loading="jenkinsLoading" class="jenkins-workspace-body">
                <aside class="jenkins-build-list" aria-label="Jenkins 构建列表">
                  <div class="jenkins-column-heading">Builds</div>
                  <button
                    v-for="build in jenkinsJob?.builds || []"
                    :key="build.number"
                    type="button"
                    class="jenkins-build-row"
                    :class="{ 'is-active': build.number === jenkinsSelectedBuild?.number }"
                    @click="startJenkinsLog(build)"
                  >
                    <span class="jenkins-build-row-main">
                      <strong>{{ build.displayName || `#${build.number}` }}</strong>
                      <el-tag class="status-beacon" :class="jenkinsBuildStatus(build).className" :type="jenkinsBuildStatus(build).type" effect="light" size="small">{{ jenkinsBuildStatus(build).label }}</el-tag>
                    </span>
                    <span class="jenkins-build-row-meta"><time>{{ formatJenkinsTime(build.timestamp) }}</time><span>{{ formatJenkinsDuration(build.duration) }}</span></span>
                  </button>
                  <div v-if="jenkinsJob && !jenkinsJob.builds.length" class="jenkins-empty">暂无构建记录</div>
                </aside>
                <section class="jenkins-log-panel">
                  <div class="jenkins-column-heading">
                    <span>{{ jenkinsSelectedBuild ? `${jenkinsSelectedBuild.displayName || `#${jenkinsSelectedBuild.number}`} Console Output` : 'Console Output' }}</span>
                    <el-tag v-if="jenkinsSelectedBuild" class="status-beacon" :class="jenkinsBuildStatus(jenkinsSelectedBuild).className" :type="jenkinsBuildStatus(jenkinsSelectedBuild).type" effect="light" size="small">{{ jenkinsBuildStatus(jenkinsSelectedBuild).label }}</el-tag>
                  </div>
                  <pre ref="jenkinsLogRef" class="jenkins-log" data-following="true" @copy="copyLogAsPlainText" @scroll="updateJenkinsLogFollowing"><code v-if="jenkinsLog" v-html="jenkinsLogHtml"></code><span v-if="jenkinsLogLoading && !jenkinsLog">等待日志...</span><span v-else-if="!jenkinsSelectedBuild">请选择构建</span></pre>
                </section>
              </div>
            </section>
            </div>
            </template>

            <div v-else class="workbench-unselected"><span>未选择项目</span></div>

            <section
              v-if="composeLogsOpen"
              class="workspace-logs"
              :class="{ 'is-fullscreen': composeLogsFullscreen, 'is-resizing': composeLogsResizing }"
              :style="composeLogsHeight ? { '--compose-logs-height': `${composeLogsHeight}px` } : undefined"
            >
              <div
                class="workspace-logs-resizer"
                role="separator"
                aria-label="调整日志窗口高度"
                aria-orientation="horizontal"
                tabindex="0"
                @pointerdown="startComposeLogsResize"
              ></div>
              <div class="workspace-logs-heading">
                <div>
                  <h2>日志</h2>
                  <span>{{ composeLogsService || '全部服务' }}</span>
                </div>
                <div class="workspace-logs-window-actions">
                  <el-tooltip :content="composeLogsFullscreen ? '退出全屏' : '全屏显示'"><el-button text :icon="composeLogsFullscreen ? ScaleToOriginal : FullScreen" :aria-label="composeLogsFullscreen ? '退出全屏' : '全屏显示'" @click="toggleComposeLogsFullscreen" /></el-tooltip>
                  <el-tooltip content="关闭日志"><el-button text circle :icon="Close" aria-label="关闭日志" @click="closeComposeLogs" /></el-tooltip>
                </div>
              </div>
              <div class="compose-logs-toolbar">
                <div class="compose-logs-range">
                  <el-select v-model="composeLogsService" aria-label="日志服务" placeholder="全部服务" @change="startComposeLogStream">
                    <el-option label="全部服务" value="" />
                    <el-option v-for="service in deploymentServices" :key="service.name" :label="service.name" :value="service.name" />
                  </el-select>
                  <el-select v-model="composeLogLines" aria-label="日志行数" @change="startComposeLogStream">
                    <el-option v-for="lines in composeLogLineOptions" :key="lines" :label="`最近 ${lines} 行`" :value="lines" />
                  </el-select>
                </div>
                <div class="compose-logs-operations">
                  <el-button :icon="VideoPlay" :loading="composeBusyTarget === `${composeLogsService || '*'}:up`" @click="runComposeFromLogs('up')">启动</el-button>
                  <el-button :icon="VideoPause" :loading="composeBusyTarget === `${composeLogsService || '*'}:down`" @click="runComposeFromLogs('down')">停止</el-button>
                  <el-button :icon="RefreshRight" :loading="composeBusyTarget === `${composeLogsService || '*'}:restart`" @click="runComposeFromLogs('restart')">重启</el-button>
                </div>
              </div>
              <pre ref="composeLogsRef" class="compose-logs" @copy="copyLogAsPlainText" @scroll="updateComposeLogsFollowing"><code ref="composeLogsCodeRef"></code><span v-if="!composeLogHasOutput">等待日志...</span></pre>
            </section>
          </div>
        </div>
      </section>
    </el-main>

    <el-dialog v-model="settingsDialogOpen" title="参数" class="settings-dialog" width="min(960px, 94vw)" align-center destroy-on-close :close-on-click-modal="true" show-close>
      <div v-loading="settingsLoading" class="settings-dialog-content">
        <div class="settings-hint settings-dialog-intro">当前环境决定应用配置时读取的本地配置目录</div>
        <section class="settings-section">
          <div class="settings-heading environment-heading">
            <div class="settings-label">当前环境</div>
            <el-button @click="environmentDialogOpen = true">编辑环境</el-button>
          </div>
          <el-select v-model="environment" filterable placeholder="选择环境">
            <el-option v-for="item in settings?.environments || []" :key="item" :label="item" :value="item" />
          </el-select>
        </section>

        <section class="settings-section variables-section">
          <div class="settings-heading">
            <div>
              <div class="settings-label">全局变量</div>
              <div class="settings-hint">配置文件使用 @{VARIABLE_NAME} 引用</div>
            </div>
            <el-button @click="addVariable">新增变量</el-button>
          </div>
          <el-table :data="variableRows" class="variables-table" empty-text="暂无全局变量">
            <el-table-column label="变量名" min-width="220">
              <template #default="{ row }"><el-input v-model="row.key" placeholder="VARIABLE_NAME" /></template>
            </el-table-column>
            <el-table-column label="类型" width="150">
              <template #default="{ row }">
                <el-select v-model="row.type" @change="changeVariableType(row)">
                  <el-option label="字符串" value="string" /><el-option label="数字" value="number" /><el-option label="布尔值" value="boolean" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="值" min-width="320">
              <template #default="{ row }">
                <el-select v-if="row.type === 'boolean'" v-model="row.value"><el-option label="true" :value="true" /><el-option label="false" :value="false" /></el-select>
                <el-input v-else v-model="row.value" :type="row.type === 'number' ? 'number' : 'text'" />
              </template>
            </el-table-column>
            <el-table-column label="操作" width="90">
              <template #default="{ $index }"><el-button link type="danger" @click="variableRows.splice($index, 1)">删除</el-button></template>
            </el-table-column>
          </el-table>
        </section>

        <section class="settings-section jenkins-settings-section">
          <div class="settings-heading">
            <div>
              <div class="settings-label">Jenkins 凭据</div>
              <div class="settings-hint">标准 Jenkins 使用用户 ID 和该用户的 API Token；仅在服务支持 Bearer Token 时可不填账号</div>
            </div>
          </div>
          <div class="jenkins-credential-fields">
            <label><span>账号</span><el-input v-model="jenkinsUsername" autocomplete="username" placeholder="Jenkins 用户 ID" /></label>
            <label><span>Token</span><el-input v-model="jenkinsToken" type="password" show-password autocomplete="new-password" placeholder="Jenkins API Token" /></label>
          </div>
        </section>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <small class="dialog-close-hint">点击任意空白区域关闭</small>
          <div class="dialog-footer-actions">
            <el-button class="dialog-footer-close" @click="settingsDialogOpen = false">关闭</el-button>
            <el-button type="primary" :loading="settingsSaving" :disabled="settingsLoading" @click="saveSettings">保存参数</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="jenkinsBuildDialogOpen" title="Jenkins 构建" class="jenkins-build-dialog" width="min(620px, 92vw)" align-center destroy-on-close :close-on-click-modal="true" show-close>
      <el-form label-position="top" @submit.prevent="triggerJenkinsBuild">
        <el-form-item v-for="parameter in jenkinsJob?.parameters || []" :key="parameter.name" :label="parameter.name">
          <el-checkbox-group v-if="parameter.multiple" v-model="jenkinsParameterValues[parameter.name]" class="jenkins-multi-choice">
            <el-checkbox v-for="choice in parameter.choices" :key="choice" :value="choice">{{ choice }}</el-checkbox>
          </el-checkbox-group>
          <el-switch v-else-if="parameter.type === 'BooleanParameterDefinition'" v-model="jenkinsParameterValues[parameter.name]" />
          <el-select v-else-if="parameter.choices.length" v-model="jenkinsParameterValues[parameter.name]">
            <el-option v-for="choice in parameter.choices" :key="choice" :label="choice" :value="choice" />
          </el-select>
          <el-input v-else-if="parameter.type === 'TextParameterDefinition'" v-model="jenkinsParameterValues[parameter.name]" type="textarea" :rows="4" />
          <el-input v-else v-model="jenkinsParameterValues[parameter.name]" :type="parameter.type === 'PasswordParameterDefinition' ? 'password' : 'text'" :show-password="parameter.type === 'PasswordParameterDefinition'" />
          <div v-if="parameter.description" class="jenkins-parameter-description">{{ parameter.description }}</div>
        </el-form-item>
        <div v-if="jenkinsJob && !jenkinsJob.parameters.length" class="jenkins-no-parameters">此 Job 无需构建参数</div>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <small class="dialog-close-hint">点击任意空白区域关闭</small>
          <div class="dialog-footer-actions">
            <el-button @click="jenkinsBuildDialogOpen = false">取消</el-button>
            <el-button type="primary" :icon="Hammer" :loading="jenkinsBuildBusy" @click="triggerJenkinsBuild">构建</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="backgroundDialogOpen" title="背景" class="background-dialog" width="min(760px, 94vw)" align-center :close-on-click-modal="true" show-close>
      <div class="background-preview">
        <img :src="backgroundUrl" alt="当前工作台背景" />
      </div>
      <div class="background-meta">
        <span>PNG、JPG、WebP、GIF、AVIF</span>
        <span>推荐分辨率 1920 x 1080，最大 20 MB</span>
      </div>
      <input ref="backgroundFileInput" class="background-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" @change="replaceBackgroundImage" />
      <template #footer>
        <div class="dialog-footer background-dialog-footer">
          <small class="dialog-close-hint">点击任意空白区域关闭</small>
          <div class="dialog-footer-actions">
            <el-button :icon="Download" @click="downloadBackgroundImage">下载</el-button>
            <el-button type="primary" :icon="Upload" :loading="backgroundUploading" @click="chooseBackgroundImage">更换</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="createDialogOpen" title="新建项目" width="min(520px, 92vw)" destroy-on-close :close-on-click-modal="true" show-close>
      <el-form label-position="top" @submit.prevent="createNewProject">
        <el-form-item label="项目名称" required><el-input v-model="newProject.name" /></el-form-item>
        <el-form-item label="项目目录" required>
          <div class="project-form-row">
            <el-input v-model="newProject.confDir" placeholder="例如 se/gpm/service" />
            <el-button class="project-form-picker" @click="browseProjectDirectory('new-conf')">选择目录</el-button>
          </div>
        </el-form-item>
        <el-form-item label="Compose 文件">
          <div class="project-form-row">
            <el-input v-model="newProject.composeFile" placeholder="可选，例如 se/gpm/deploy/local.yml" />
            <el-button class="project-form-picker" @click="browseProjectDirectory('new-compose')">选择文件</el-button>
          </div>
        </el-form-item>
        <el-form-item label="Jenkins Job URL">
          <el-input v-model="newProject.jenkinsJobUrl" placeholder="可选，例如 http://jenkins.example.com/job/project/" />
        </el-form-item>
        <el-form-item label="Tags">
          <div class="project-form-row">
            <div class="project-value-list tag-value-list">
              <el-tag v-for="tag in newProject.tags" :key="tag" :type="tagType(tag)" closable disable-transitions @close="removeProjectTag(newProject, tag)">{{ tag }}</el-tag>
              <span v-if="!newProject.tags.length" class="project-list-empty">暂无 Tag</span>
            </div>
            <el-select v-model="newProject.tags" class="project-tag-picker" popper-class="project-tag-dropdown" multiple filterable allow-create default-first-option placeholder="添加 Tag" aria-label="添加项目 Tag">
              <template #tag="{ data }"><span v-if="data.length" class="project-tag-input-placeholder">添加 Tag</span></template>
              <el-option v-for="tag in summary?.tags || []" :key="tag.name" :label="tag.name" :value="tag.name" />
            </el-select>
          </div>
        </el-form-item>
        <el-form-item label="配置文件">
          <div class="project-form-row">
            <div class="project-value-list project-file-list">
              <el-tag v-for="file in newProject.files" :key="file" type="info" closable disable-transitions :title="file" @close="removeProjectFile(newProject, file)">{{ file }}</el-tag>
              <span v-if="!newProject.files.length" class="project-list-empty">暂无配置文件</span>
            </div>
            <el-button class="project-form-picker" @click="browseProjectDirectory('new-files')">选择文件</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <small class="dialog-close-hint">点击任意空白区域关闭</small>
          <div class="dialog-footer-actions">
            <el-button @click="createDialogOpen = false">取消</el-button>
            <el-button type="primary" :loading="createBusy" :disabled="!newProject.name.trim() || !newProject.confDir.trim()" @click="createNewProject">创建</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="editDialogOpen" title="编辑项目" width="min(520px, 92vw)" destroy-on-close :close-on-click-modal="true" show-close>
      <el-form label-position="top" @submit.prevent="saveEditedProject">
        <el-form-item label="项目名称" required><el-input v-model="editedProject.name" /></el-form-item>
        <el-form-item label="项目目录" required>
          <div class="project-form-row">
            <el-input v-model="editedProject.confDir" />
            <el-button class="project-form-picker" @click="browseProjectDirectory('edit-conf')">选择目录</el-button>
          </div>
        </el-form-item>
        <el-form-item label="Compose 文件">
          <div class="project-form-row">
            <el-input v-model="editedProject.composeFile" placeholder="可选" />
            <el-button class="project-form-picker" @click="browseProjectDirectory('edit-compose')">选择文件</el-button>
          </div>
        </el-form-item>
        <el-form-item label="Jenkins Job URL">
          <el-input v-model="editedProject.jenkinsJobUrl" placeholder="可选" />
        </el-form-item>
        <el-form-item label="Tags">
          <div class="project-form-row">
            <div class="project-value-list tag-value-list">
              <el-tag v-for="tag in editedProject.tags" :key="tag" :type="tagType(tag)" closable disable-transitions @close="removeProjectTag(editedProject, tag)">{{ tag }}</el-tag>
              <span v-if="!editedProject.tags.length" class="project-list-empty">暂无 Tag</span>
            </div>
            <el-select v-model="editedProject.tags" class="project-tag-picker" popper-class="project-tag-dropdown" multiple filterable allow-create default-first-option placeholder="添加 Tag" aria-label="添加项目 Tag">
              <template #tag="{ data }"><span v-if="data.length" class="project-tag-input-placeholder">添加 Tag</span></template>
              <el-option v-for="tag in summary?.tags || []" :key="tag.name" :label="tag.name" :value="tag.name" />
            </el-select>
          </div>
        </el-form-item>
        <el-form-item label="配置文件">
          <div class="project-form-row">
            <div class="project-value-list project-file-list">
              <el-tag v-for="file in editedProject.files" :key="file" type="info" closable disable-transitions :title="file" @close="removeProjectFile(editedProject, file)">{{ file }}</el-tag>
              <span v-if="!editedProject.files.length" class="project-list-empty">暂无配置文件</span>
            </div>
            <el-button class="project-form-picker" @click="browseProjectDirectory('edit-files')">选择文件</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <small class="dialog-close-hint">点击任意空白区域关闭</small>
          <div class="dialog-footer-actions">
            <el-button @click="editDialogOpen = false">取消</el-button>
            <el-button type="primary" :loading="editBusy" :disabled="!editedProject.name.trim() || !editedProject.confDir.trim()" @click="saveEditedProject">保存</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="directoryDialogOpen" :title="directoryTarget.endsWith('compose') ? '选择 Compose 文件' : directoryTarget.endsWith('files') ? '选择配置文件' : '选择项目目录'" width="min(620px, 92vw)" append-to-body :close-on-click-modal="true" show-close>
      <div v-loading="directoryLoading" class="directory-browser">
        <div class="directory-toolbar">
          <el-button :disabled="directoryParent === null" @click="loadDirectories(directoryParent || '')">返回上级</el-button>
          <code>/{{ directoryPath }}</code>
        </div>
        <div class="directory-list">
          <button v-for="entry in directoryEntries" :key="entry.path" type="button" class="directory-entry" @click="loadDirectories(entry.path)">
            <span>{{ entry.name }}</span><span>进入</span>
          </button>
          <button v-for="entry in isDirectoryFileTarget() ? fileEntries : []" :key="entry.path" type="button" class="directory-entry file-entry" @click="directoryTarget.endsWith('compose') ? chooseComposeFile(entry.path) : chooseProjectConfigFile(entry.path)">
            <span>{{ entry.name }}</span><span>选择</span>
          </button>
          <div v-if="!directoryEntries.length && (!isDirectoryFileTarget() || !fileEntries.length) && !directoryLoading" class="directory-empty">{{ isDirectoryFileTarget() ? '当前目录没有可选文件' : '没有子目录' }}</div>
        </div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <small class="dialog-close-hint">点击任意空白区域关闭</small>
          <div class="dialog-footer-actions">
            <el-button @click="directoryDialogOpen = false">取消</el-button>
            <el-button v-if="!isDirectoryFileTarget()" type="primary" @click="chooseProjectDirectory">选择当前目录</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="environmentDialogOpen" title="编辑环境" width="min(520px, 92vw)" :close-on-click-modal="true" show-close>
      <div class="environment-list">
        <div v-for="item in settings?.environments || []" :key="item" class="environment-row">
          <span>{{ item }}</span>
          <div>
            <el-button link type="primary" :disabled="item === 'dev'" @click="editEnvironment(item)">重命名</el-button>
            <el-button link type="danger" :disabled="item === 'dev'" @click="removeEnvironment(item)">删除</el-button>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="dialog-footer">
          <small class="dialog-close-hint">点击任意空白区域关闭</small>
          <div class="dialog-footer-actions">
            <el-button class="dialog-footer-close" @click="environmentDialogOpen = false">关闭</el-button>
            <el-button type="primary" @click="addEnvironment">新增环境</el-button>
          </div>
        </div>
      </template>
    </el-dialog>
  </el-container>
  </el-config-provider>
</template>
