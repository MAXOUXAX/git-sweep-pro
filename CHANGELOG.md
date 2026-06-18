# Change Log

All notable changes to the "git-sweep-pro" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Post Pull Request: keep the current branch and rebase it onto the selected branch (after a pull), then force-push it, instead of deleting/pruning it. Delegates to the Sync With Upstream flow (stash, conflict resume, `--force-with-lease`) and pre-selects the default branch as the target.
- Initial release