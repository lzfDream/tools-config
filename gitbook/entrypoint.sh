#!/bin/bash
# 复制配置文件要包含隐藏文件
ls -A /etc/gitbook-config/ | xargs -I {} cp -rv /etc/gitbook-config/{} /srv/gitbook/

mkdir -p /srv/gitbook/node_modules/
# 先删除可能存在的旧链接
rm -f /srv/gitbook/node_modules/*
# 然后创建新链接
ln -s /usr/local/lib/node_modules/* /srv/gitbook/node_modules/
exec "$@"
