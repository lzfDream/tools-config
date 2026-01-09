FROM ubuntu:22.04

WORKDIR /app

ENV LANG=zh_CN.UTF-8
# 设置镜像源
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ENV UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/

# 安装uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/

COPY . .
RUN bash docker/dev/install.sh

CMD ["zsh"]
