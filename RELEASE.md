# 发布流程

本项目通过 GitHub 仓库分发 OpenCode 本地 TUI 插件。发布版本使用 SemVer 标签和 GitHub Release；当前不发布 npm 包。

## 开发分支

从最新 `main` 创建短期功能或修复分支，完成后通过 Pull Request 合并回 `main`：

```text
main
└── feature/<name> 或 fix/<name>
```

不创建长期 `develop`、`release` 或 `hotfix` 分支。

## 版本号

稳定版本使用 `vMAJOR.MINOR.PATCH`：

- `MAJOR`：不兼容的功能或配置变更
- `MINOR`：向后兼容的新功能
- `PATCH`：向后兼容的问题修复

例如：`v1.1.0`、`v1.1.1`。已发布的版本标签不可移动、覆盖或重复使用。

## 发布步骤

1. 将已审核的变更合并到 `main`。
2. 在准备发布的提交上创建并推送带注释的版本标签：

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v1.1.0 -m "Release v1.1.0"
   git push origin v1.1.0
   ```

3. 推送 `vX.Y.Z` 标签会触发 `.github/workflows/release.yml`。工作流校验标签格式，并使用 GitHub 自动生成的变更说明创建 Release。
4. 核对 Release 的标签、目标提交和说明。GitHub Release 基于标签记录版本；它不会发布 npm 包。

工作流只接受不带预发布后缀的 `vMAJOR.MINOR.PATCH` 标签。若标签指向错误提交，应删除并重建发布前的标签；已发布的版本不应重写。

---

# Release process

This project distributes the OpenCode local TUI plugin from GitHub. Releases use SemVer tags and GitHub Releases; the project does not currently publish an npm package.

## Development branches

Create a short-lived feature or fix branch from the latest `main`, then merge it through a pull request:

```text
main
└── feature/<name> or fix/<name>
```

Do not create long-lived `develop`, `release`, or `hotfix` branches.

## Version numbers

Stable releases use `vMAJOR.MINOR.PATCH`:

- `MAJOR`: an incompatible feature or configuration change
- `MINOR`: a backward-compatible feature
- `PATCH`: a backward-compatible fix

Examples: `v1.1.0` and `v1.1.1`. Never move, overwrite, or reuse a published version tag.

## Release steps

1. Merge reviewed changes into `main`.
2. Create and push an annotated version tag on the commit to release:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v1.1.0 -m "Release v1.1.0"
   git push origin v1.1.0
   ```

3. Pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`. The workflow validates the tag and creates a GitHub Release with GitHub-generated release notes.
4. Review the release tag, target commit, and notes. A GitHub Release records a tagged version; it does not publish an npm package.

The workflow accepts only `vMAJOR.MINOR.PATCH` tags without prerelease suffixes. If a tag points to the wrong commit, delete and recreate it before publishing; do not rewrite a published version.
