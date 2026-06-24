# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个个人开发工具配置管理仓库，集中管理各种开发工具的配置文件（dotfiles）和开发环境设置。

## 架构组织

```
tools-config/
├── vim/              # Vim/Neovim 配置
├── vscode/           # VS Code 配置
├── git/              # Git 配置
├── zsh/              # Zsh shell 配置
├── docker/           # Docker 开发环境
│   ├── dev/          # 开发环境（包含完整工具链安装脚本）
│   ├── play/         # 实验环境
│   └── test/         # 测试环境
├── script/           # Python 实用脚本
│   ├── merge_pdf.py         # PDF 合并工具
│   ├── rename.py            # 批量重命名工具
│   ├── yaml_config_merger.py # YAML 配置合并工具
│   └── loop-git.py          # Git 循环操作工具
└── software.md       # 推荐软件工具清单
```

## 依赖管理

- 使用 `uv` 管理 Python 依赖
- Python 依赖定义在 `pyproject.toml` 中（pypdf, pyyaml）

```bash
# 同步依赖
uv sync

# 添加依赖
uv add <package>
```

## Docker 开发环境

### 启动开发环境

```bash
cd docker/dev
docker compose up -d
```

### 安装脚本

开发环境安装分为两个阶段：

**install-system.sh（需要 root 权限）**
- 系统工具和依赖
- 全局安装：UV、npm、Ruff、dust、procs
- Node.js 20.x 和全局 npm 包（bun, pyright）
- C/C++ 工具链（clang, make, cmake）
- Docker CLI 和 Compose 插件
- 中文字体和 locale
- 全局镜像源配置（pip、uv、npm）

**install-user.sh（普通用户执行）**
- oh-my-zsh 和插件
- vim、git、zsh 配置文件

```bash
# 安装顺序
sudo ./install-system.sh
./install-user.sh
chsh -s /usr/bin/zsh
```

### 环境变量配置

Docker 环境的配置通过 `docker/dev/.env` 文件管理，包含镜像源和工具版本等设置。

## 配置文件安装

配置文件需要手动复制到用户目录：

```bash
# Vim
cp vim/init.vim ~/.config/nvim/

# Git
cp git/.gitconfig ~/.gitconfig

# Zsh
cp zsh/.zshrc ~/.zshrc

# VS Code
cp -r vscode/ ~/vscode/
```

## Python 脚本

### merge_pdf.py
合并多个 PDF 文件，依赖 pypdf 库。

### yaml_config_merger.py
合并和处理 YAML 配置文件，依赖 pyyaml 库。

### rename.py
批量重命名文件工具。

### loop-git.py
对多个 Git 仓库执行批量操作。

## 约定

- 配置文件修改后需要重新手动复制到目标位置才能生效
- Docker 环境使用阿里云镜像源以加速国内访问
- Python 版本要求：>=3.12.10
