autocmd BufWritePost $MYVIMRC source $MYVIMRC

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

set laststatus=1
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
map <C-n> :NERDTree<CR>
map <C-p> :LeaderfFile<CR>
"map <C-S-o> :LeaderfFunction<CR>

call plug#begin()
Plug 'SirVer/ultisnips'
Plug 'honza/vim-snippets'

Plug 'vim-airline/vim-airline'
Plug 'vim-airline/vim-airline-themes'
Plug 'jiangmiao/auto-pairs'
" Plug 'neoclide/coc.nvim', {'branch': 'release'}

Plug 'preservim/nerdtree'
Plug 'jistr/vim-nerdtree-tabs'
" 可以在导航目录中看到 git 版本信息
Plug 'Xuyuanp/nerdtree-git-plugin'

Plug 'Yggdroot/LeaderF', { 'do': './install.sh' }

Plug 'https://github.com/fatih/vim-go', {'do': ':GoUpdateBinaries'}

Plug 'junegunn/vim-easy-align'
" 查看当前代码文件中的变量和函数列表的插件，
" 可以切换和跳转到代码中对应的变量和函数的位置
" 大纲式导航, Go 需要 https://github.com/jstemmer/gotags 支持
Plug 'jstemmer/gotags'
Plug 'majutsushi/tagbar'
" 有道词典在线翻译
Plug 'ianva/vim-youdao-translater'

" 代码自动完成，安装完插件还需要额外配置才可以使用
Plug 'Valloric/YouCompleteMe'

" 可以在 vim 中使用 tab 补全
Plug 'vim-scripts/SuperTab'

" 可以在 vim 中自动完成
Plug 'Shougo/neocomplete.vim'
call plug#end()

"==============================================================================
" vim-go 插件
"==============================================================================
let g:go_fmt_command = "goimports" " 格式化将默认的 gofmt 替换
let g:go_autodetect_gopath = 1
let g:go_list_type = "quickfix"

let g:go_version_warning = 1
let g:go_highlight_types = 1
let g:go_highlight_fields = 1
let g:go_highlight_functions = 1
let g:go_highlight_function_calls = 1
let g:go_highlight_operators = 1
let g:go_highlight_extra_types = 1
let g:go_highlight_methods = 1
let g:go_highlight_generate_tags = 1

let g:godef_split=2
