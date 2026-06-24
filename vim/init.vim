" ===================== 编码与基础环境 =====================
set fileencoding=utf-8
set fileformat=unix
syntax on
syntax enable
filetype plugin indent on

" ===================== 行号、光标、UI显示 =====================
set number
set cursorline
set laststatus=2
set ruler
set showmode
set showmatch
set autoread

" 搜索配置
set incsearch
set ignorecase

" 空白字符可视化
set list
set listchars=tab:>-,trail:-

" ===================== Tab / 缩进统一4空格 =====================
set tabstop=4
set expandtab
set softtabstop=4
set shiftwidth=4
set autoindent
set ai
set smartindent
set cindent
set cinoptions={0,1s,t0,n-2,p2s,(03s,=.5s,>1s,=1s,:1s

" 退格兼容
set backspace=indent,eol,start

" 折叠配置
set foldmethod=marker
set foldlevelstart=99

" 注释颜色
highlight Comment ctermfg=2

" 彩色终端（按需取消注释开启）
" set termguicolors

" ===================== Leader 快捷键定义 =====================
let mapleader = "-"
nnoremap <leader>w :w<CR>
nnoremap <leader>fu :CtrlPFunky<Cr>
nnoremap <leader>fU :execute 'CtrlPFunky' .expand('<cword>')<Cr>

" 插入模式 jj 快速退出
inoremap jj <Esc>

" C语言返回模板快捷输入
inoremap <leader>ret if (iRet != 0) {<Cr>return iRet;<Cr>}<esc>

" ===================== 剪贴板核心配置（自动适配WSL/Linux/Mac/Win） =====================
" 所有y复制自动同步系统剪贴板
set clipboard=unnamedplus
