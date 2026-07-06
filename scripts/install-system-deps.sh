#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update

apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  gnupg \
  sudo \
  build-essential \
  autoconf \
  bison \
  patch \
  pkg-config \
  rustc \
  libssl-dev \
  libreadline-dev \
  zlib1g-dev \
  libyaml-dev \
  libffi-dev \
  libgdbm-dev \
  libncurses-dev \
  libncursesw5-dev \
  libsqlite3-dev \
  libbz2-dev \
  liblzma-dev \
  libxml2-dev \
  libxmlsec1-dev \
  libjemalloc2 \
  tk-dev \
  uuid-dev \
  xz-utils \
  zip \
  unzip \
  procps \
  less \
  vim-tiny \
  xvfb \
  fontconfig \
  fonts-liberation \
  fonts-liberation2 \
  fonts-dejavu \
  fonts-noto-core \
  fonts-noto-cjk \
  fonts-noto-color-emoji

rm -rf /var/lib/apt/lists/*
