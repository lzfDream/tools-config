# 开发环境安装脚本

将原 `install.sh` 分离为两个脚本，明确区分系统级和用户级安装。

## 脚本说明

### install-system.sh
**需要 root 权限执行**

安装系统级工具和依赖：
- 系统工具：neovim, zsh, git, bat, btop, duf, eza, fd-find
- Python 3 及 pip、httpie
- Ruff、UV、dust、procs（安装到 `/usr/local/bin`）
- C/C++ 工具链：clang, make, cmake
- Node.js 及 npm（全局配置）
- 全局 npm 包：bun, pyright
- Docker CLI 和 Compose 插件
- 中文字体和 locale
- **全局镜像源配置**：pip (`/etc/pip.conf`)、uv (`/etc/xdg/uv/uv.toml`)、npm (全局 npmrc)

### install-user.sh
**以普通用户身份执行**

配置用户级设置：
- oh-my-zsh 及插件（zsh-autosuggestions, zsh-syntax-highlighting, you-should-use）
- vim 配置文件复制
- git 配置文件复制
- zsh 配置文件复制和主题设置

## 使用方法

```bash
# 1. 以 root 身份安装系统工具
sudo ./install-system.sh

# 2. 以普通用户身份配置用户环境
./install-user.sh

# 3. 切换默认 shell 为 zsh
chsh -s /usr/bin/zsh
```

## 设计原则

- **系统工具全局化**：UV、npm 本体安装到系统路径（`/usr/local/bin`），所有用户可用
- **镜像源全局化**：pip、uv、npm 镜像源配置写入系统配置，对所有用户生效
- **配置用户化**：插件、dotfiles 配置保留在当前用户目录
- **职责分离**：系统级安装和用户级配置分离，便于维护和调试
- **幂等性**：脚本可重复执行，会检查已存在的配置
