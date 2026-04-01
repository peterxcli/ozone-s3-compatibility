FROM ghcr.io/catthehacker/ubuntu:act-latest

USER root

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends maven rsync jq && \
    rm -rf /var/lib/apt/lists/*
