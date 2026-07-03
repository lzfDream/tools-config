# owner_config

集中管理 `/mnt/d/code` 下各项目的本地配置。

## 目录

```text
owner_config/
├── cfg.sh
├── bin/owner_config.py
├── config/projects.yaml
├── data/
│   ├── baseline/<project>/
│   ├── local/<project>/
│   │   └── <env>/
│   └── variables.yaml
├── .env
└── state/
    ├── apply.lock
    └── sync-meta.yaml
```

## 规则

- `sync`：从目标项目当前文件复制到 `data/baseline/<project>/`
- `build`：根据 `projects.yaml` 同步 `data/baseline/<project>/` 和 `data/local/<project>/`，删除已移除项目目录；按 `files` 创建缺失的空占位文件；缺失时创建 `data/variables.yaml` 和 `.env`
- `apply`：从 `owner_config/.env` 读取 `APP_ENV`；`dev` 读取 `data/local/<project>/`，其他环境读取 `data/local/<project>/<env>/`；非结构化文件优先用 `local` 整体覆盖；YAML/JSON/INI 文件以 `baseline` 为基准合并 `local` 中声明的 key；没有 `local` 时回写 `baseline`；成功后写入 `state/apply.lock`
- `re`：直接用 `baseline` 覆盖目标项目，并移除 `state/apply.lock`
- `ls`：始终允许执行，并显示当前状态是 `baseline` 还是 `applied`
- 安全锁：`state/apply.lock` 存在时，`cfg ls`、`cfg apply` 和 `cfg re` 允许执行，其他命令都会直接拒绝
- `projects.yaml`：显式声明项目名、相对代码根目录和受管文件
- `conf_dir`：默认写相对 `owner_config` 父目录的路径，也支持直接写绝对路径；如果该目录下存在 `conf/` 子目录，则文件会自动读写到 `conf/`

## 结构化配置合并规则

- `local` 里只保留想修改的 key
- `data/variables.yaml` 可定义全局变量，`local` YAML/JSON/INI 中可用 `@{VAR_NAME}` 引用
- 整个字符串等于 `@{VAR_NAME}` 时，替换为变量原始标量类型；字符串内部出现时按字符串内插
- `dict` 递归合并，但不允许新增 baseline 中不存在的 key
- `list` 按索引递归覆盖
- 标量值直接替换
- 变量值只允许字符串、数字、布尔；未定义变量会直接报错
- `null`、类型不匹配、未知 key、越界索引都会直接报错

## 用法

新环境如果想直接使用 `cfg` 命令，而不是每次执行 `./cfg.sh`，可以按下面的方式创建 `~/.local/bin/cfg`：

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/cfg <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

exec /mnt/d/code/owner_config/cfg.sh "$@"
EOF
chmod +x ~/.local/bin/cfg
```

如果 `~/.local/bin` 还没在 `PATH` 里，再补一行到 shell 配置后重新加载：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

完成后可直接执行：

```bash
cfg
cfg ls
cfg build
cfg sync
cfg sync --project entry
cfg apply
cfg re --project entry
```

## 测试

```bash
uv run pytest
```

## 初始化

1. 修改 `config/projects.yaml`，补充要管理的项目和服务
2. 执行 `cfg build`
3. 执行 `cfg sync`
4. `APP_ENV=dev` 时在 `data/local/<project>/` 下放本地覆盖文件；其他环境放到 `data/local/<project>/<env>/`
5. 执行 `cfg apply`
