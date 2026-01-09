#!/bin/bash
set -euo pipefail

# 设置阿里云镜像源
sed -i "s/archive.ubuntu.com/mirrors.aliyun.com/g" /etc/apt/sources.list
sed -i "s/security.ubuntu.com/mirrors.aliyun.com/g" /etc/apt/sources.list
apt-get update -qq

# 安装常用工具
apt-get install -qq -y vim zsh git bat btop duf unzip locales fonts-noto-cjk
locale-gen zh_CN.UTF-8

# 安装Python3和pip3
apt-get install -qq -y python3 python3-pip

# 安装httpie
pip install httpie

# 安装dust
https -qd https://github.com/bootandy/dust/releases/download/v1.2.4/dust-v1.2.4-x86_64-unknown-linux-gnu.tar.gz
tar -xzf dust-v1.2.4-x86_64-unknown-linux-gnu.tar.gz
mv dust-v1.2.4-x86_64-unknown-linux-gnu/dust /usr/local/bin
chmod +x /usr/local/bin/dust
rm -rf dust-v1.2.4-x86_64-unknown-linux-gnu.tar.gz

# 安装procs
https -qd https://github.com/dalance/procs/releases/download/v0.14.10/procs-v0.14.10-x86_64-linux.zip -o procs.zip
unzip procs.zip
mv procs /usr/local/bin
chmod +x /usr/local/bin/procs
rm -rf procs.zip

# 安装c/c++
apt-get install -qq -y clang make cmake > /dev/null

# 安装Node.js
https https://deb.nodesource.com/setup_20.x | bash
apt-get install -y -qq nodejs
npm install -g -s bun

# 安装oh-my-zsh和常用插件
https https://install.ohmyz.sh | bash
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
git clone https://github.com/MichaelAquilina/zsh-you-should-use.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/you-should-use
sed -i 's/plugins=(git)/plugins=(git zsh-autosuggestions zsh-syntax-highlighting z extract copyfile you-should-use)/g' ~/.zshrc

# 安装docker
# apt-get install -y ca-certificates curl gnupg
# install -m 0755 -d /etc/apt/keyrings
# curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
# chmod a+r /etc/apt/keyrings/docker.gpg
# echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
# apt-get update
# apt-get install -y docker-ce-cli docker-compose-plugin

mv bash/.bashrc ~/
mv vim/.vimrc ~/
cp -r vim/autoload ~/.vim/
mv git/.gitconfig ~/

cat zsh/.zshrc >> ~/.zshrc
