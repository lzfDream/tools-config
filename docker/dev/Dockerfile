FROM ubuntu:22.04

# 安装Docker客户端 操作宿主机docker
COPY --from=gloursdocker/docker / /

ARG MIRROR=mirrors.aliyun.com

# 设置阿里云镜像源
RUN <<EOF
sed -i "s/archive.ubuntu.com/${MIRROR}/g" /etc/apt/sources.list && \
sed -i "s/security.ubuntu.com/${MIRROR}/g" /etc/apt/sources.list && \
apt-get update -qq
EOF

ENV LANG=zh_CN.UTF-8
# 设置其他镜像源
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/

# 安装常用工具
RUN apt-get install -qq -y vim zsh curl wget git bat unzip locales fonts-noto-cjk > /dev/null && locale-gen zh_CN.UTF-8
# 安装Python3和pip3
RUN apt-get install -qq -y python3 python3-pip > /dev/null

# 安装c/c++
RUN apt-get install -qq -y clang make cmake > /dev/null

# 安装Node.js
RUN <<EOF
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
npm install -g -s bun
EOF

# 安装oh-my-zsh和常用插件
RUN <<EOF
curl -fsSL https://install.ohmyz.sh | sh
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
git clone https://github.com/MichaelAquilina/zsh-you-should-use.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/you-should-use
sed -i 's/plugins=(git)/plugins=(git zsh-autosuggestions zsh-syntax-highlighting z extract copyfile you-should-use)/g' ~/.zshrc
EOF

# 安装uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# 安装docker
# RUN <<EOF
# apt-get install -y ca-certificates curl gnupg
# install -m 0755 -d /etc/apt/keyrings
# curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
# chmod a+r /etc/apt/keyrings/docker.gpg
# echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
# apt-get update
# apt-get install -y docker-ce-cli docker-compose-plugin
# EOF

WORKDIR /app

COPY bash/.bashrc vim/.vimrc git/.gitconfig zsh/.zshrc /app/
RUN <<EOF
mv /app/.bashrc /root/
mv /app/.vimrc /root/
cat /app/.zshrc >> /root/.zshrc
mv /app/.gitconfig /root/
EOF

CMD ["zsh"]
