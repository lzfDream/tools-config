export type Scalar = string | number | boolean;

export interface ProjectConfig {
  id: number;
  name: string;
  confDir: string;
  composeFile?: string;
  jenkinsJobUrl?: string;
  files: string[];
  tags: string[];
}

export interface NewProject {
  name: string;
  confDir: string;
  composeFile?: string;
  jenkinsJobUrl?: string;
  files: string[];
  tags: string[];
}

export interface TagSummary {
  name: string;
  projects: number[];
}

export interface ProjectSummary extends ProjectConfig {
  pinned: boolean;
  status: "normal" | "applied";
  deploymentStatus: "running" | "stopped" | null;
  updatedAt: string | null;
}

export interface ConfigSummary {
  tags: TagSummary[];
  projects: ProjectSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GlobalSettings {
  environment: string;
  environments: string[];
  variables: Record<string, Scalar>;
  jenkins: JenkinsSettings;
}

export interface JenkinsSettings {
  username: string;
  tokenConfigured: boolean;
}

export interface JenkinsCredentials {
  username: string;
  token: string;
}

export interface JenkinsBuild {
  number: number;
  url: string;
  displayName: string;
  result: string | null;
  building: boolean;
  timestamp: number;
  duration: number;
}

export interface JenkinsParameterDefinition {
  name: string;
  type: string;
  description: string;
  defaultValue: string | number | boolean | string[] | null;
  choices: string[];
  multiple: boolean;
}

export interface JenkinsJob {
  name: string;
  url: string;
  buildable: boolean;
  builds: JenkinsBuild[];
  parameters: JenkinsParameterDefinition[];
}

export interface ConfigFileView {
  name: string;
  baseline: string;
  local: string | null;
  merged: string;
}

export interface ComposeService {
  name: string;
  status: "running" | "stopped";
  ports: ComposePort[];
}

export interface ComposePort {
  hostIp: string;
  publishedPort: number;
  targetPort: number;
  protocol: string;
}

export interface ComposeDeployment {
  status: "running" | "stopped";
  services: ComposeService[];
}

export type Operation = "sync" | "apply" | "restore";
export type ComposeOperation = "up" | "down" | "restart";
