# Change Log

All notable changes to the "git-sweep-pro" extension are documented in this file.

This project adheres to [Semantic Versioning](https://semver.org) and the changelog is generated automatically from [Conventional Commits](https://www.conventionalcommits.org).

# [1.2.0](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.1.0...v1.2.0) (2026-07-04)


### Features

* add safety settings (protected branches, confirm, default mode, auto fetch/prune) ([9547129](https://github.com/MAXOUXAX/git-sweep-pro/commit/95471292b4a91db087fe1502e126b4d91b013507))
* force-delete squash/rebase-merged branches that safe delete refuses ([6135465](https://github.com/MAXOUXAX/git-sweep-pro/commit/6135465d0a3c5c56de22f4a0b7b6257c12688449))
* multi-root workspace support with repository selection ([8bd80e6](https://github.com/MAXOUXAX/git-sweep-pro/commit/8bd80e66eb05dba420a166d3a69906cd2d6951d4))
* **sweep:** add summary preview, picker quick actions, and detailed outcome ([adebe5a](https://github.com/MAXOUXAX/git-sweep-pro/commit/adebe5a7fed679d260a4048894caa6cfda09d56c))

# [1.1.0](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.0.1...v1.1.0) (2026-07-04)


### Bug Fixes

* force C locale for git so parsed tokens are locale-stable ([c90c337](https://github.com/MAXOUXAX/git-sweep-pro/commit/c90c337a65827784794f2190e0c723d0629f29e6))


### Features

* detect stale branches via structured git refs ([1d95f2e](https://github.com/MAXOUXAX/git-sweep-pro/commit/1d95f2ebb58e60222bb9a78400a61f08cede750e))

## [1.0.1](https://github.com/MAXOUXAX/git-sweep-pro/compare/v1.0.0...v1.0.1) (2026-07-03)


### Bug Fixes

* **ci:** compile before coverage and reject empty coverage data ([83fd405](https://github.com/MAXOUXAX/git-sweep-pro/commit/83fd4059695f102c1267d76b5c7f5622474d7e79))

# 1.0.0 (2026-07-03)


### Features

* add coverage reporting and improve git command handling ([b0aeea3](https://github.com/MAXOUXAX/git-sweep-pro/commit/b0aeea35ac984f489fe05bbeba844aeeba6be340))
* add icon ([8c8db32](https://github.com/MAXOUXAX/git-sweep-pro/commit/8c8db32b983bcf136297556ad4f2c60441e0de4d))
* add Post Pull Request command ([#5](https://github.com/MAXOUXAX/git-sweep-pro/issues/5)) ([26f1090](https://github.com/MAXOUXAX/git-sweep-pro/commit/26f1090b01ff3c8c36177a394036504399924b7d))
* add Sync With Upstream commands and workflow ([#6](https://github.com/MAXOUXAX/git-sweep-pro/issues/6)) ([2195eb4](https://github.com/MAXOUXAX/git-sweep-pro/commit/2195eb43a630726a1366a0cebbd0c125b74a18fe)), closes [#4](https://github.com/MAXOUXAX/git-sweep-pro/issues/4)
* promote Git Sweep Pro to first stable release ([52ca683](https://github.com/MAXOUXAX/git-sweep-pro/commit/52ca683e369c01b5a34d89007fd60f53bfc015d8))


### BREAKING CHANGES

* mark the first stable 1.0.0 release with automated publishing to the VS Code Marketplace and Open VSX.

# Change Log

All notable changes to the "git-sweep-pro" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- New commands: `Sync With Upstream` and `Sync With Upstream (Resume)` — keep a feature branch up to date with a base branch (stash, pull, rebase, `--force-with-lease` push, conflict pause/resume).
- Initial release
