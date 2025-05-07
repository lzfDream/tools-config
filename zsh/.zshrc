alias do='docker'
alias dop='docker-compose'
alias doexec='docker exec -it'
alias objdump='llvm-objdump-14 -M intel -S'
alias cat='batcat --paging=never'

bindkey '^_' autosuggest-accept
export ZSH_AUTOSUGGEST_STRATEGY=(history completion)
