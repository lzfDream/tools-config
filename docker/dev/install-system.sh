#!/bin/bash
set -euo pipefail

# 设置阿里云镜像源
mirror_url=https://mirrors.aliyun.com/ubuntu
sed -i "s|http://archive.ubuntu.com/ubuntu|$mirror_url|g" /etc/apt/sources.list
sed -i "s|http://security.ubuntu.com/ubuntu|$mirror_url|g" /etc/apt/sources.list
apt-get update -qq

# 安装常用工具
apt-get install -qq -y neovim zsh git bat btop duf unzip locales fonts-noto-cjk eza fd-find curl ca-certificates gnupg
locale-gen zh_CN.UTF-8

# 安装Python3和pip3
apt-get install -qq -y python3 python3-pip
# 配置pip全局镜像源
tee /etc/pip.conf << 'EOF'
[global]
index-url = https://mirrors.aliyun.com/pypi/simple/
trusted-host = mirrors.aliyun.com
break-system-packages = true
EOF
[ ! -e /usr/bin/python ] && ln -s /usr/bin/python3 /usr/bin/python
[ ! -e /usr/bin/pip ] && ln -s /usr/bin/pip3 /usr/bin/pip

# 安装httpie（全局）
pip install httpie

# 安装 Ruff（全局）
curl -fsSL https://github.com/astral-sh/ruff/releases/latest/download/ruff-x86_64-unknown-linux-gnu.tar.gz | tar -xzf - --strip-components=1 -C /usr/local/bin

# 安装 UV（全局）
curl -fsSL https://astral.sh/uv/install.sh | sh
# 将 UV 移动到系统路径
[ -f /root/.local/bin/uv ] && mv /root/.local/bin/uv /usr/local/bin/
[ -f /root/.cargo/bin/uv ] && mv /root/.cargo/bin/uv /usr/local/bin/
# 配置UV全局镜像源
mkdir -p /etc/xdg/uv
tee /etc/xdg/uv/uv.toml << 'EOF'
[pip]
index-url = "https://mirrors.aliyun.com/pypi/simple/"
EOF

# 安装 dust（全局）
curl -fsSL https://github.com/bootandy/dust/releases/download/v1.2.4/dust-v1.2.4-x86_64-unknown-linux-gnu.tar.gz | tar -xzf - --strip-components=1 -C /usr/local/bin

# 安装 procs（全局）
curl -fsSL https://github.com/dalance/procs/releases/download/v0.14.10/procs-v0.14.10-x86_64-linux.zip -o /tmp/procs.zip
unzip -q /tmp/procs.zip -d /usr/local/bin
chmod +x /usr/local/bin/procs
rm -f /tmp/procs.zip

# 安装c/c++
apt-get install -qq -y clang make cmake

# 安装Node.js（全局）
curl -fsSL https://deb.nodesource.com/setup_20.x | bash
apt-get install -y -qq nodejs

# 设置npm全局配置
npm config set prefix /usr/local --global
npm config set registry https://registry.npmmirror.com --global

# 安装npm全局工具
npm install -g bun pyright

# 安装docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update -qq
apt-get install -y -qq docker-ce-cli docker-compose-plugin

echo "系统级工具安装完成"
echo "请以普通用户身份运行 install-user.sh 完成用户级配置"
