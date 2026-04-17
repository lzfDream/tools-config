#!/bin/bash
set -euo pipefail

# 设置阿里云镜像源
mirror_url=https://mirrors.aliyun.com
sed -i "s/archive.ubuntu.com/$mirror_url/ubuntu/g" /etc/apt/sources.list
sed -i "s/security.ubuntu.com/$mirror_url/ubuntu/g" /etc/apt/sources.list
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
export PIP_INDEX_URL=$mirror_url/pypi/simple/
export PIP_TRUSTED_HOST=mirrors.aliyun.com
export UV_DEFAULT_INDEX=$mirror_url/pypi/simple/
apt-get update -qq

# 安装常用工具
apt-get install -qq -y vim zsh git bat btop duf unzip locales fonts-noto-cjk eza fd-find
locale-gen zh_CN.UTF-8

# 安装Python3和pip3
apt-get install -qq -y python3 python3-pip
tee /etc/pip.conf << 'EOF'
[global]
break-system-packages = true
EOF
[ ! -L /usr/bin/python ] && ln -s /usr/bin/python3 /usr/bin/python
[ ! -L /usr/bin/pip ] && ln -s /usr/bin/pip3 /usr/bin/pip

# 安装httpie
pip install httpie

# 安装 Ruff
https -qd https://github.com/astral-sh/ruff/releases/latest/download/ruff-x86_64-unknown-linux-gnu.tar.gz -o - | tar -xzf - --strip-components=1 -C /usr/local/bin

# 安装 UV
https -qd https://astral.sh/uv/install.sh -o - | sh

# 安装 dust
https -qd https://github.com/bootandy/dust/releases/download/v1.2.4/dust-v1.2.4-x86_64-unknown-linux-gnu.tar.gz -o - | tar -xzf - --strip-components=1 -C /usr/local/bin

# 安装 procs
https -qd https://github.com/dalance/procs/releases/download/v0.14.10/procs-v0.14.10-x86_64-linux.zip -o /tmp/procs.zip
unzip -q /tmp/procs.zip -d /usr/local/bin
chmod +x /usr/local/bin/procs
rm -f /tmp/procs.zip

# 安装c/c++
apt-get install -qq -y clang make cmake > /dev/null

# 安装Node.js
https https://deb.nodesource.com/setup_20.x | bash
apt-get install -y -qq nodejs
npm config set prefix ~/.local
npm install -g -s bun pyright

# 安装oh-my-zsh和常用插件
https https://install.ohmyz.sh | bash
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
git clone https://github.com/MichaelAquilina/zsh-you-should-use.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/you-should-use
sed -i 's/plugins=(git)/plugins=(git zsh-autosuggestions zsh-syntax-highlighting z extract copyfile you-should-use)/g' ~/.zshrc

# 安装docker
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce-cli docker-compose-plugin

npm install -g -s bun

cp vim/.vimrc ~/
cp -r vim/autoload ~/.vim/
cp git/.gitconfig ~/

cat zsh/.zshrc >> ~/.zshrc
# 修改主题
sed -i 's/^ZSH_THEME=.*/ZSH_THEME="gozilla"/' ~/.zshrc

usermod -s /usr/bin/zsh $USER
