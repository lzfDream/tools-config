#!/bin/bash
set -euo pipefail

# 安装oh-my-zsh和常用插件
if [ ! -d ~/.oh-my-zsh ]; then
    curl -fsSL https://install.ohmyz.sh | bash
fi

# 安装zsh插件
ZSH_CUSTOM=${ZSH_CUSTOM:-~/.oh-my-zsh/custom}
[ ! -d "$ZSH_CUSTOM/plugins/zsh-autosuggestions" ] && \
    git clone https://github.com/zsh-users/zsh-autosuggestions "$ZSH_CUSTOM/plugins/zsh-autosuggestions"
[ ! -d "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting" ] && \
    git clone https://github.com/zsh-users/zsh-syntax-highlighting.git "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting"
[ ! -d "$ZSH_CUSTOM/plugins/you-should-use" ] && \
    git clone https://github.com/MichaelAquilina/zsh-you-should-use.git "$ZSH_CUSTOM/plugins/you-should-use"

# 配置zsh插件（如果还没配置）
if ! grep -q "zsh-autosuggestions" ~/.zshrc; then
    sed -i 's/plugins=(git)/plugins=(git zsh-autosuggestions zsh-syntax-highlighting z extract copyfile you-should-use)/g' ~/.zshrc
fi

# 复制vim配置
if [ -f vim/.vimrc ]; then
    cp vim/.vimrc ~/
fi
if [ -d vim/autoload ]; then
    mkdir -p ~/.vim
    cp -r vim/autoload ~/.vim/
fi

# 复制git配置
if [ -f git/.gitconfig ]; then
    cp git/.gitconfig ~/
fi

# 复制zsh配置（追加）
if [ -f zsh/.zshrc ]; then
    cat zsh/.zshrc >> ~/.zshrc
fi

# 修改zsh主题
sed -i 's/^ZSH_THEME=.*/ZSH_THEME="gozilla"/' ~/.zshrc

echo "用户级配置完成"
echo "请运行以下命令切换到zsh: chsh -s /usr/bin/zsh"
