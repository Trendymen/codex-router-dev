# Phase 4 Task 5 实施报告

日期：2026-08-24

## 结果

Task 5 fix round 2 已完成，当前 HEAD 为本 Task5 amend 提交，当前仍在 `main`，直接工作区开发，未创建或切换 worktree/分支，未推送。

## 实施摘要

- `scripts/package-release.mjs` 从 `HEAD` 的 `git ls-tree` stage-0 blob/mode 收集精确 tracked 文件级 allowlist，并用单次 `git cat-file --batch` 读取 blob；dirty/staged tracked 工作树不会改变归档内容，sourceCommit 与 package version 均来自 HEAD。
- 发布包不再递归复制 live directory；未跟踪 secret、ignored 日志和本机 SwiftPM 构建残留不会进入归档。缺少关键 Router、UI、Swift、registry 或 Node lock 依赖时在任何输出写入前拒绝。
- 归档使用 Node 内置 USTAR writer 与固定 gzip header/raw deflate，所有 slash 都尝试合法 prefix/name 分割并按 UTF-8 byte length 限制；manifest 与 archive 复用同一 verified entry list，manifest 记录 `type`、规范化 `mode`、字节数和 SHA-256，checksum 输出稳定。
- `build-macos-tray-app.sh` 将显式 bundle 路径交给 `validatePathWithin`，拒绝 dot segment、越界、symlink/junction，并限制参数数量；LaunchAgent 增加 Grok/Devin 的 `MODEL_ROUTER_*` 与 `CODEX_ROUTER_*` 端口别名。
- Swift tray fingerprint 递归覆盖 `Package.swift`、`Sources/**`、`Sources/Resources/**`、`Resources/**`，按字节序排序；使用原始 Buffer，并为路径长度/内容长度加 framing，读失败和 symlink 输入均 fail closed。
- `validatePathWithin` 检查 parent 本身及所有既存祖先的 lstat/realpath，并验证候选最近既存 parent 的 canonical path 仍在 parent 内。
- scratch Git fixture 真实读取 tar、manifest、checksum、类型、模式、字节和 hash，并覆盖重复构建一致性、HEAD provenance、staged+unstaged dirty 文件、unsafe version、未跟踪 secret、缺失依赖、symlink、hardlink、dot segment、UTF-8/100/101/255 字节路径和 target containment。

## 验证证据

| 验证项 | 结果 |
| --- | --- |
| Task5 focused（package/service/install-plan/tray） | 18 pass / 0 fail / 0 skip |
| Phase4 affected/pre-push 组合 | 79 total / 78 pass / 0 fail / 1 既有平台 skip |
| `node --check scripts/package-release.mjs` | 通过 |
| `sh -n scripts/package-release.sh scripts/build-macos-tray-app.sh` | 通过 |
| `npm run check` | 通过 |
| `npm test`（默认并发，无并发参数） | 2350 total / 2315 pass / 0 fail / 35 既有条件 skip |
| `git diff --check` | 通过 |

## 约束与残余风险

- 本轮未执行真实 macOS Swift build、package、launchctl、app launch、install 或 managed service 操作；这些属于 Phase 5 macOS 验收。
- 当前 packager 在隔离 scratch Git fixture 上完成真实归档验证；对当前 checkout 的实际 release package 构建仍按计划留到 push 后的 Phase 5。
