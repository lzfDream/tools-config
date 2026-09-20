import { load } from "cheerio";
import { withExternalOperationTimeout } from "./external.js";
import type { JenkinsCredentials, JenkinsJob, JenkinsParameterDefinition } from "./types.js";

export type JenkinsFetch = typeof fetch;

interface JenkinsAction {
  parameterDefinitions?: unknown;
}

type JenkinsParameterValue = string | number | boolean | string[];

interface JenkinsFormParameter {
  choices: string[];
  defaults: string[];
  multiple: boolean;
}

export function validateJenkinsToken(token: string): void {
  if (token && !/^[\x21-\x7e]+$/.test(token)) throw new Error("Jenkins Token 只能包含无空格的 ASCII 可打印字符，请重新复制 Jenkins API Token");
}

function authorization(credentials: JenkinsCredentials): string | undefined {
  if (!credentials.token) return undefined;
  validateJenkinsToken(credentials.token);
  if (credentials.username) return `Basic ${Buffer.from(`${credentials.username}:${credentials.token}`).toString("base64")}`;
  return `Bearer ${credentials.token}`;
}

async function errorMessage(response: Response): Promise<string> {
  if (response.status === 401) return "Jenkins 认证失败 (401 Unauthorized)：请在“参数 > Jenkins 凭据”中确认账号为 Jenkins 用户 ID，Token 为该账号的 API Token";
  if (response.status === 403) return "Jenkins 拒绝访问 (403 Forbidden)：请配置 Jenkins 账号和 API Token，并确认该账号具有 Job 读取和构建权限";
  const detail = (await response.text()).trim().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 240);
  return `Jenkins request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${detail ? `: ${detail}` : ""}`;
}

async function jenkinsRequest(url: URL, credentials: JenkinsCredentials, fetcher: JenkinsFetch, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const auth = authorization(credentials);
  if (auth) headers.set("authorization", auth);
  const response = await withExternalOperationTimeout("Jenkins 请求", (signal) => fetcher(url, { ...init, headers, redirect: "manual", signal }), { parentSignal: init.signal });
  if (!response.ok && !(init.method === "POST" && [201, 302, 303].includes(response.status))) throw new Error(await errorMessage(response));
  return response;
}

function buildFormParameters(html: string): Map<string, JenkinsFormParameter> {
  if (!html) return new Map();
  const $ = load(html);
  const parameters = new Map<string, JenkinsFormParameter>();
  $("[name='parameter']").each((_index, element) => {
    const field = $(element);
    const name = field.children("input[type='hidden'][name='name']").first().attr("value")?.trim();
    if (!name || parameters.has(name)) return;
    const checkboxes = field.find("input[type='checkbox'][name='value']");
    const radios = field.find("input[type='radio'][name='value']");
    const options = field.find("select[name='value'] option");
    const controls = checkboxes.length ? checkboxes : radios.length ? radios : options;
    if (!controls.length) return;
    const choices: string[] = [];
    const defaults: string[] = [];
    controls.each((_controlIndex, control) => {
      const item = $(control);
      const value = item.attr("value");
      if (value === undefined) return;
      choices.push(value);
      if (item.is(":checked") || item.is(":selected")) defaults.push(value);
    });
    parameters.set(name, {
      choices,
      defaults,
      multiple: checkboxes.length > 0 && !field.find("input[type='checkbox'][name='value'][hidden]").length,
    });
  });
  return parameters;
}

async function getBuildFormParameters(jobUrl: string, credentials: JenkinsCredentials, fetcher: JenkinsFetch, signal?: AbortSignal): Promise<Map<string, JenkinsFormParameter>> {
  const headers = new Headers();
  const auth = authorization(credentials);
  if (auth) headers.set("authorization", auth);
  const response = await withExternalOperationTimeout("Jenkins 请求", (requestSignal) => fetcher(new URL("build?delay=0sec", jobUrl), { headers, redirect: "manual", signal: requestSignal }), { parentSignal: signal });
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return new Map();
  return buildFormParameters(await response.text());
}

function parameterDefinitions(
  actions: unknown,
  formParameters = new Map<string, JenkinsFormParameter>(),
  properties: unknown = [],
): JenkinsParameterDefinition[] {
  const containers = [actions, properties].filter(Array.isArray).flat() as JenkinsAction[];
  const definitions = containers.flatMap((container) => (
    Array.isArray(container?.parameterDefinitions) ? container.parameterDefinitions : []
  ));
  const seen = new Set<string>();
  return definitions.flatMap((definition) => {
    if (!definition || typeof definition !== "object") return [];
    const value = definition as Record<string, unknown>;
    if (typeof value.name !== "string" || !value.name) return [];
    if (seen.has(value.name)) return [];
    seen.add(value.name);
    const defaultParameter = value.defaultParameterValue && typeof value.defaultParameterValue === "object"
      ? (value.defaultParameterValue as Record<string, unknown>).value
      : null;
    const defaultValue = ["string", "number", "boolean"].includes(typeof defaultParameter)
      ? defaultParameter as string | number | boolean
      : null;
    const type = typeof value.type === "string" ? value.type : "StringParameterDefinition";
    const form = formParameters.get(value.name);
    const multiple = type !== "BooleanParameterDefinition" && form?.multiple === true;
    const choices = Array.isArray(value.choices) && value.choices.length ? value.choices.map(String) : form?.choices || [];
    const formDefaults = form?.defaults.length ? form.defaults : defaultValue === null || defaultValue === "" ? [] : String(defaultValue).split(",");
    return [{
      name: value.name,
      type,
      description: typeof value.description === "string" ? value.description : "",
      defaultValue: multiple ? formDefaults : defaultValue,
      choices,
      multiple,
    }];
  });
}

export async function getJenkinsJob(jobUrl: string, credentials: JenkinsCredentials, fetcher: JenkinsFetch = fetch, signal?: AbortSignal): Promise<JenkinsJob> {
  const api = new URL("api/json", jobUrl);
  api.searchParams.set("tree", "name,url,buildable,builds[number,url,result,building,timestamp,duration,displayName]{0,50},actions[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]],property[parameterDefinitions[name,type,description,defaultParameterValue[value],choices]]");
  const response = await jenkinsRequest(api, credentials, fetcher, { signal });
  const raw = await response.json() as Record<string, unknown>;
  const formParameters = await getBuildFormParameters(jobUrl, credentials, fetcher, signal);
  const builds = Array.isArray(raw.builds) ? raw.builds.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.number !== "number" || !Number.isSafeInteger(value.number) || typeof value.url !== "string") return [];
    return [{
      number: value.number,
      url: value.url,
      displayName: typeof value.displayName === "string" ? value.displayName : `#${value.number}`,
      result: typeof value.result === "string" ? value.result : null,
      building: value.building === true,
      timestamp: typeof value.timestamp === "number" ? value.timestamp : 0,
      duration: typeof value.duration === "number" ? value.duration : 0,
    }];
  }) : [];
  return {
    name: typeof raw.name === "string" ? raw.name : "Jenkins",
    url: typeof raw.url === "string" ? raw.url : jobUrl,
    buildable: raw.buildable !== false,
    builds: builds.sort((left, right) => right.number - left.number),
    parameters: parameterDefinitions(raw.actions, formParameters, raw.property),
  };
}

async function crumbHeaders(jobUrl: string, credentials: JenkinsCredentials, fetcher: JenkinsFetch, signal?: AbortSignal): Promise<Headers> {
  const url = new URL("/crumbIssuer/api/json", jobUrl);
  const auth = authorization(credentials);
  const headers = new Headers(auth ? { authorization: auth } : undefined);
  const response = await withExternalOperationTimeout("Jenkins 请求", (requestSignal) => fetcher(url, { headers, redirect: "manual", signal: requestSignal }), { parentSignal: signal });
  if (response.status === 404) return new Headers();
  if (!response.ok) throw new Error(await errorMessage(response));
  const value = await response.json() as Record<string, unknown>;
  if (typeof value.crumbRequestField !== "string" || typeof value.crumb !== "string") return new Headers();
  return new Headers({ [value.crumbRequestField]: value.crumb });
}

export async function triggerJenkinsBuild(jobUrl: string, credentials: JenkinsCredentials, parameters: Record<string, JenkinsParameterValue>, fetcher: JenkinsFetch = fetch, signal?: AbortSignal): Promise<{ queueUrl: string | null }> {
  const headers = await crumbHeaders(jobUrl, credentials, fetcher, signal);
  const body = new URLSearchParams(Object.entries(parameters).map(([key, value]) => [key, String(value)]));
  const target = new URL(Object.keys(parameters).length ? "buildWithParameters" : "build", jobUrl);
  headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
  const response = await jenkinsRequest(target, credentials, fetcher, { method: "POST", headers, body, signal });
  const location = response.headers.get("location");
  return { queueUrl: location ? new URL(location, target).toString() : null };
}

export async function isJenkinsBuildRunning(jobUrl: string, buildNumber: number, credentials: JenkinsCredentials, fetcher: JenkinsFetch = fetch, signal?: AbortSignal): Promise<boolean> {
  if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) throw new Error("Jenkins build number must be a positive integer");
  const url = new URL(`${buildNumber}/api/json`, jobUrl);
  url.searchParams.set("tree", "building");
  const response = await jenkinsRequest(url, credentials, fetcher, { signal });
  const value = await response.json() as Record<string, unknown>;
  return value.building === true;
}

export async function readJenkinsLog(jobUrl: string, buildNumber: number, credentials: JenkinsCredentials, offset: number, fetcher: JenkinsFetch = fetch, signal?: AbortSignal): Promise<{ text: string; nextOffset: number; more: boolean }> {
  if (!Number.isSafeInteger(buildNumber) || buildNumber <= 0) throw new Error("Jenkins build number must be a positive integer");
  const url = new URL(`${buildNumber}/logText/progressiveText`, jobUrl);
  url.searchParams.set("start", String(offset));
  const response = await jenkinsRequest(url, credentials, fetcher, { signal });
  const text = await response.text();
  const size = Number(response.headers.get("x-text-size"));
  return {
    text,
    nextOffset: Number.isSafeInteger(size) && size >= offset ? size : offset + Buffer.byteLength(text),
    more: response.headers.get("x-more-data")?.toLowerCase() === "true",
  };
}
