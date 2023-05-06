# renovate-git-history-action

This Github actions is a helper to identify the impact of git changes created by [renovate](https://github.com/renovatebot/renovate) on the Github repository.

# Motivation

Renovate updates dependencies in pull requests. For many dependencies, it displays what's been changed between the old and new versions. (For example, in this [PR](https://github.com/renovatebot/renovate/pull/21940), one can click `18.16.0 -> 18.16.1` to see the detailed diffs introduced by that PR.) However, for some dependencies, like raw git hash changes, renovate doesn't show the detailed diffs. This action is a helper to identify the impact of such changes.

# How to use

Create a new workflow, with the following content:

```yaml
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  renovate-git-history:
    permissions:
      pull-requests: write
    runs-on: ubuntu-latest
    steps:
      - uses: bc-lee/renovate-git-history-action@master
```

# Inputs
- token: Github token. Default: `${{ github.token }}`. In general, you don't need to specify this.
