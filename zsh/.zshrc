alias do='docker'
alias dop='docker compose'
alias dopb='docker compose build'
alias dopd='docker compose down'
alias dopu='docker compose up -d'
alias dopl='dop logs -f -n 200'
alias dops="docker ps --format 'table {{.Image}}\t{{.Names}}'"
alias doexec='docker exec -it'
alias dotestc='docker run -it --rm'

alias c='clear'
alias objdump='llvm-objdump-14 -M intel -S'
alias cat='batcat --paging=never'
alias du='dust'
alias df='duf'
alias ls='exa'
alias fd='fdfind'
alias cc='claude'
alias cx='codex'
alias code='cmd.exe /c code'

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
HISTIGNORE="ls:ll:pwd:exit:clear"

export PATH="$HOME/.local/bin:$HOME/.npm/bin:/usr/local/bin:$PATH"
