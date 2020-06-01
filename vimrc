set fileencoding=utf-8

syntax on
syntax enable

filetype on
filetype plugin on
set number
set cursorline

set tabstop=4
set expandtab
set softtabstop=4
set shiftwidth=4

set ai
set smartindent

set foldmethod=indent
set foldlevelstart=99
set fileformat=unix

set laststatus=1
set autoindent
set cindent
set cinoptions={0,1s,t0,n-2,p2s,(03s,=.5s,>1s,=1s,:1s
highlight Comment ctermfg=2
execute pathogen#infect()
filetype plugin indent on
set incsearch
set ignorecase
set showmode
set ruler
set autoread
set showmatch

let mapleader = "-"
nnoremap <leader>w :w<CR>
nnoremap <leader>fu :CtrlPFunky<Cr>
nnoremap <leader>fU :execute 'CtrlPFunky' .expand('<cword>')<Cr>

"map
inoremap jj <Esc>
inoremap jh <Esc>^i
inoremap jl <Esc>$a
inoremap <leader>ret if (iRet != 0) {<Cr>return iRet;<Cr>}<esc>
map <C-n> :NERDTree<CR>
nnoremap fj ^
nnoremap fl $
nnoremap <leader>ev :vsplit $MYVIMRC<Cr>
nnoremap <leader>sv :source $MYVIMRC<Cr>
nnoremap <leader>' viw<esc>a'<esc>hbi'<esc>l
nnoremap <leader>" viw<esc>a"<esc>hbi"<esc>l
nnoremap <leader>( viw<esc>a)<esc>hbi(<esc>l
nnoremap <leader>c I//<esc>
