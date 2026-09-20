# 项目管理

基于 Node.js + TypeScript 的本地项目管理工具，集中管理代码根目录下各项目的配置和 Compose 服务，通过网页完成配置与部署操作。

## 配置

项目定义在 `data/projects.yaml`：

```yaml
env:
  current: dev
  options: [dev]
projects:
  - id: 10
    name: task-admin
    tags: [task, other]
    conf_dir: se/other/task/admin
    compose_file: se/other/task/local-compose.yml
    jenkins_job_url: http://jenkins.example.com/job/task-admin/
    files:
      - dev.yaml
```

- `id`：正整数且全局唯一，是项目的稳定身份；数据目录使用可读的 `<name>--<id>` 命名以兼容重名项目。
- `name`：展示名称，允许重名。
- `tags`：可选，一个项目可属于多个 tag。
- `conf_dir`：相对 owner_config 父目录，也可为绝对路径；存在 `conf/` 子目录时自动使用该目录。
- `compose_file`：可选，Compose 文件；相对 owner_config 父目录，也可为绝对路径。运行 Compose 时始终通过 `docker compose -f <文件>` 使用该文件，因此文件名不限于默认的 `compose.yaml`。
- `jenkins_job_url`：可选，Jenkins Job 的完整 HTTP(S) 地址。仅配置该字段的项目显示 Jenkins 部署模块。
- `files`：项目内受管文件列表。

网页中的配置操作始终以单个项目的稳定 ID 提交，不支持批量操作。
项目置顶状态由后端保存在 `state/project-pins.yaml`，不写入项目配置；列表由后端先筛选，再按置顶状态和项目 ID 排序，最后分页。

## 安装与测试

要求 Node.js 22 或更高版本。Web 页面以 `1920x1080` 显示器为主要使用环境，支持常见浏览器缩放；布局下限为 `1280x720` CSS 视口，不适配手机等小屏设备：

```bash
npm install
npm test
```

## 网页服务

```bash
./deploy.sh
./deploy.sh stop
```

`./deploy.sh` 默认执行 `start`，会复用 `dist/` 和 `web-dist/` 中的构建缓存，必要时先构建，然后在后台保留唯一的 Node 服务进程。PID 和日志分别保存在 `state/server.pid` 和 `state/server.log`；重复启动不会创建新实例，停止服务使用 `./deploy.sh stop`。`npm start` 作为兼容入口执行相同流程。

默认访问 `http://127.0.0.1:4173`。可通过 `PORT` 修改端口，通过 `OWNER_CONFIG_ROOT` 指定 owner_config 根目录。

页面使用 Vue 3 和 Element Plus 展示项目列表，包括项目名称、配置状态和部署状态。项目列表由服务端按“置顶优先、组内项目 ID 升序”排序后分页，默认每页 10 个；名称搜索同样由服务端在分页前完成。项目根目录可直接点击打开；聚合项目的子项目目录默认折叠，可通过根目录后的箭头展开，展开后的目录同样可以点击打开。页面右上角的“主题设置”可选择跟随系统、白天或夜间模式。新建或编辑项目时填写项目目录；选择 Compose 文件会从现有 Compose 文件所在目录开始浏览，尚未配置时则从项目目录开始。“配置”窗口针对单个项目执行备份、恢复和应用，其中“备份”会把项目当前配置保存为模板；模板和本地配置默认只读，通过“编辑文件”打开统一的文件编辑弹窗，保存前执行与应用操作相同的严格合并校验。窗口顶部可打开“全局设置”弹窗，用于切换当前环境、管理 `data/variables.yaml` 中的标量变量，以及设置 Jenkins Token 和可选账号。配置了 `compose_file` 的项目通过“部署”窗口管理 Compose 文件中的所有服务。配置了 `jenkins_job_url` 的项目在工作台模块列表中显示 Jenkins 部署模块：左侧显示最近构建，右侧默认显示最新构建日志；构建按钮按 Job 定义生成参数表单，触发后刷新列表，并通过 SSE 持续显示运行中的 Console Output。所有弹窗均可点击外部空白区域或右上角 X 关闭，底部显示对应提示。关闭日志窗口会停止对应的日志跟随进程。

## 数据规则

- `sync`：目标项目 -> `data/projects/<name>--<id>/baseline/`
- `apply`：以 baseline 为基础，合并当前环境的 `data/projects/<name>--<id>/local/<env>/`；未配置环境时默认使用 `dev`
- `restore`：baseline -> 目标项目
- 当前环境和可选环境保存在 `data/projects.yaml` 的 `env` 段；服务启动时自动迁移旧 `.env` 中的 `APP_ENV` 和旧 ID 数据目录，并补齐 `data/variables.yaml` 以及当前环境缺失的项目配置文件
- YAML、JSON、INI 递归合并；未知 key、类型不匹配、数组越界、null 和未定义变量均报错
- `data/variables.yaml` 支持标量变量，配置中用 `@{VARIABLE_NAME}` 引用
- Jenkins 凭据保存在被 Git 忽略的 `data/jenkins.yaml`，设置接口不会回传 Token 明文
