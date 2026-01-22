#!/usr/bin/env sh
set -eu

# Deploy and enforce a single Machine.
# This trades redundancy for simplicity and cost.

fly deploy --ha=false "$@"
fly scale count 1 -y

