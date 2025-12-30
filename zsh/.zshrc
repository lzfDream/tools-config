alias c='clear'
alias do='docker'
alias dop='docker compose'
alias dops="docker ps --format 'table {{.Image}}\t{{.Names}}'"
alias doexec='docker exec -it'
alias dotestc='docker run -it --rm'
alias objdump='llvm-objdump-14 -M intel -S'
alias cat='batcat --paging=never'

bindkey '^_' autosuggest-accept
export ZSH_AUTOSUGGEST_STRATEGY=(history completion)

# ===================== 核心配置：禁用实时同步，启用退出时保存 =====================
# 1. 禁用「实时追加历史到文件」（默认开启，执行命令后不立即写入 ~/.zsh_history）
unsetopt inc_append_history
unsetopt inc_append_history_time  # 变种配置，同样禁用

# 2. 禁用「跨会话历史共享」（默认开启，禁止实时读取其他会话的历史，禁止当前会话历史实时被其他会话读取）
unsetopt share_history

# 3. 启用「退出会话时追加历史到文件」（而非覆盖，与 bash 的 histappend 一致）
setopt append_history

# 历史记录控制：忽略重复命令（连续相同命令只保存一条）、忽略空格开头的命令（隐私命令）
HISTCONTROL=ignoredups:ignorespace

# 忽略无用命令
HISTIGNORE="ls:ll:pwd:exit:clear"
