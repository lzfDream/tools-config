#!/bin/bash
cd /app/tools-config
cp bash/.bashrc ~/.bashrc
cat zsh/.zshrc >> ~/.zshrc
cp -r vim/autoload ~/.vim
cp vim/.vimrc ~/.vimrc
cp git/.gitconfig ~/.gitconfig

exec sh -c 'trap "exit" TERM; while true; do sleep 1; done'
