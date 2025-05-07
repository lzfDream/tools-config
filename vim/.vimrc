set fileencoding=utf-8
syntax on
syntax enable

filetype plugin indent on
set number
set cursorline

" tab
set tabstop=4
set expandtab
set softtabstop=4
set shiftwidth=4
set nocompatible
set backspace=indent,eol,start
set autoindent

set ai
set smartindent

set foldmethod=marker
set foldlevelstart=99
set fileformat=unix

set laststatus=2
set cindent
set cinoptions={0,1s,t0,n-2,p2s,(03s,=.5s,>1s,=1s,:1s
highlight Comment ctermfg=2
set incsearch
set ignorecase
set showmode
set ruler
set autoread
set showmatch
set list
set listchars=tab:>-,trail:-,
" more colors
" set termguicolors

let mapleader = "-"
nnoremap <leader>w :w<CR>
nnoremap <leader>fu :CtrlPFunky<Cr>
nnoremap <leader>fU :execute 'CtrlPFunky' .expand('<cword>')<Cr>

"map
inoremap jj <Esc>
inoremap <leader>ret if (iRet != 0) {<Cr>return iRet;<Cr>}<esc>
