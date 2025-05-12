FROM fellah/gitbook:3.2.1

RUN sed -i 's/confirm: true/confirm: false/g' /root/.gitbook/versions/3.2.1/lib/output/website/copyPluginAssets.js
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g \
    gitbook-plugin-highlight \
    gitbook-plugin-livereload \
    gitbook-plugin-expandable-chapters-small \
    gitbook-plugin-splitter \
    gitbook-plugin-back-to-top-button \
    # gitbook-plugin-github \
    gitbook-plugin-hide-element \
    gitbook-plugin-code \
    gitbook-plugin-custom-favicon \
    gitbook-plugin-page-toc-button \
    gitbook-plugin-tbfed-pagefooter


COPY entrypoint.sh /
RUN chmod +x /entrypoint.sh && mkdir -p /etc/gitbook-config
ENTRYPOINT ["/entrypoint.sh"]

CMD ["tail", "-f", "/dev/null"]
