alias dc='docker'
alias dcp='docker compose'
alias dcpb='docker compose build'
alias dcpd='docker compose down'
alias dcpu='docker compose up -d'
alias dcpr='docker compose restart'
alias dcpl='docker compose logs -f -n 200'
alias dcps='docker ps --format "table {{.Names}}\t{{if gt (len .Ports) 30}}{{printf \"%.30s...\" .Ports}}{{else}}{{printf \"%-30s\" .Ports}}{{end}}\t{{.Status}}\t{{if gt (len .Image) 30}}{{printf \"%.30s...\" .Image}}{{else}}{{printf \"%-30s\" .Image}}{{end}}"'
alias dcexec='docker exec -it'
alias dctestc='docker run -it --rm'

alias c='clear'
alias cc='claude'
alias cx='codex'
alias cat='batcat --paging=never'
alias du='dust'
alias df='duf'
alias fd='fdfind'
alias g='git'
alias gs='git status'
alias ls='exa'
alias objdump='llvm-objdump-14 -M intel -S'
alias vim='nvim'
alias tm='tmux'
alias wcode='cmd.exe /c code'
# wsl专用
alias es='_es(){ local win=$(wslpath -w "$1"); explorer.exe /select,"$win"; }; _es'
ee() {
  # 无参数 = 当前目录；有参数 = 拼接相对路径
  local target="${1:-.}"
  # 转为 Windows 绝对路径
  local win_path=$(wslpath -w "$target")
  explorer.exe "$win_path"
}
alias wcode='cmd.exe /c code'
alias wzed='cmd.exe /c start "" /min zed.exe "$1"'
# WSL环境判断
is_wsl() {
    [[ "$OSTYPE" == "linux-gnu"* && -f /proc/sys/fs/binfmt_misc/WSLInterop ]]
}
# 判断是否Windows Terminal
is_wt() {
    [[ -n "$WT_SESSION" ]]
}
# 解决WSL2下Windows Terminal目录同步问题
if is_wsl && is_wt; then
    autoload -Uz add-zsh-hook

    update_terminal_cwd() {
        local real_pwd win_path
        # 强制解析真实物理drvfs路径，规避软链接虚拟路径inode不稳定
        real_pwd=$(realpath -- "$PWD" 2>/dev/null)
        if [[ -z "$real_pwd" ]]; then
            real_pwd="$PWD"
        fi
        # 转换Windows路径，仅屏蔽stderr报错，不中断执行
        win_path=$(wslpath -w -- "$real_pwd" 2>/dev/null)
        # 只要转换出有效Windows路径，就下发同步指令
        [[ -n "$win_path" ]] && printf "\e]9;9;%s\e\\" "$win_path"
    }

    # 只在目录实际变化后同步给 Windows Terminal，避免每次渲染提示符都重复下发 cwd。
    add-zsh-hook chpwd update_terminal_cwd
fi
# Refresh a stale DrvFS cwd before running commands. Git and /bin/pwd both use
# getcwd(), while `cd .` reacquires the current directory handle.
refresh_drvfs_cwd() {
    [[ "$PWD" == /mnt/[a-zA-Z]/* ]] || return

    if ! /bin/pwd -P >/dev/null 2>&1; then
        builtin cd -q .
    fi
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec refresh_drvfs_cwd


bindkey '^_' autosuggest-accept
export ZSH_AUTOSUGGEST_STRATEGY=(history completion)

# 1. 禁用「实时追加历史到文件」
unsetopt inc_append_history
unsetopt inc_append_history_time

# 2. 禁用「跨会话历史共享」
unsetopt share_history

# 3. 启用「退出会话时追加历史到文件」
setopt append_history

# 历史记录控制：忽略重复命令（连续相同命令只保存一条）、忽略空格开头的命令（隐私命令）
HISTCONTROL=ignoredups:ignorespace

# 忽略无用命令
HISTIGNORE="ls:ll:pwd:exit:clear:tm:wcode"

export PATH="$HOME/.local/bin:$HOME/.npm/bin:/usr/local/bin:$PATH"
