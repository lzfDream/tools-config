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
