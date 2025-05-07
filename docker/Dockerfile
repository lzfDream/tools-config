FROM ubuntu:22.04

# 设置阿里云镜像源
RUN sed -i 's/archive.ubuntu.com/mirrors.aliyun.com/g' /etc/apt/sources.list && \
    sed -i 's/security.ubuntu.com/mirrors.aliyun.com/g' /etc/apt/sources.list && \
    apt-get update

# 设置字符集为UTF-8
RUN apt-get install -y locales language-pack-zh-hans fonts-noto-cjk && \
    locale-gen zh_CN.UTF-8 && \
    update-locale LANG=zh_CN.UTF-8 LANGUAGE=zh_CN:zh LC_ALL=zh_CN.UTF-8

# 安装常用工具
RUN apt-get install -y vim zsh curl wget git bat

# 安装oh-my-zsh和常用插件
RUN sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended && \
    git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions && \
    git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting && \
    git clone https://github.com/MichaelAquilina/zsh-you-should-use.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/you-should-use && \
    sed -i 's/plugins=(git)/plugins=(git zsh-autosuggestions zsh-syntax-highlighting z extract copyfile you-should-use)/g' ~/.zshrc

# 安装Python3和pip3
RUN apt-get install -y python3 python3-pip

# 安装常用工具
RUN pip install --no-cache-dir uv -i https://mirrors.aliyun.com/pypi/simple/

# 安装Node.js
RUN apt-get install -y nodejs npm

# 安装c/c++
RUN apt-get install -y clang make cmake

# 设置中文
ENV LANG=zh_CN.UTF-8 \
    LANGUAGE=zh_CN:zh \
    LC_ALL=zh_CN.UTF-8

WORKDIR /app

COPY ./ tools_config

RUN cd tools_config && \
    cp bash/.bashrc ~/.bashrc && \
    cat zsh/.zshrc >> ~/.zshrc && \
    cp -r vim/autoload ~/.vim && \
    cp vim/.vimrc ~/.vimrc && \
    cp git/.gitconfig ~/.gitconfig && \
    rm -rf /app/tools_config

CMD ["zsh"]
