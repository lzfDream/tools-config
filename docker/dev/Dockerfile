FROM ubuntu:24.04

WORKDIR /app

COPY . .
RUN bash docker/dev/install-system.sh
RUN bash docker/dev/install-user.sh

CMD ["zsh"]
