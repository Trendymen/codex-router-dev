# Phase 4 Task 4 实施报告

日期：2026-08-24

## 结果

Task 4 round 4 已完成，所有新增 whole-router skip 已恢复为真实执行。工作区为 `main`，直接在当前工作区完成；未创建或切换 worktree/分支，未推送。

| 验证项 | 结果 |
| --- | --- |
| `model-failover-router` | 23 pass / 0 fail / 0 skip |
| `namespace-relay-routing` | 4 pass / 0 fail / 0 skip |
| `vision-bridge-e2e` | 10 pass / 0 fail / 0 skip |
| `router-resilience` | 5 pass / 0 fail / 0 skip |
| `router-timing-log` | 2 pass / 0 fail / 0 skip |
| `gemini-trailing-turns` | 2 pass / 0 fail / 0 skip |
| 恢复套件 + dependency/platform/target focused | 71 total / 70 pass / 0 fail / 1 既有平台 skip |
| `npm run check` | 通过 |
| `git diff --check` | 通过 |
| I3/I4 affected 组合 | 164 pass / 0 fail / 0 skip |
| fresh `npm test` | 2338 total / 2303 pass / 0 fail / 35 既有条件 skip |

新增 skip 统计以 `1919053` 为基线：`model-failover-router` 17、`vision-bridge-e2e` 10、`namespace-relay-routing` 4、`router-resilience` 3、`router-timing-log` 2、`gemini-trailing-turns` 1，当前均为 0。

## 实施摘要

- 依赖移除审计现在消费 `git ls-files` 的真实 tracked shipped roots，并对 `requirements/`、Electron、Control Center、Tauri 前缀提供正/负控；忽略工作区残留目录不会污染审计。
- Node provider dispatcher 支持显式 failover chain 顺序、冷却窗口预切换、正确清理实际成功 provider 的 cooldown，并记录 no-candidate/failover 日志。
- 直连 Router 统一传递 failover、工具方言、empty-completion guard、取消状态、usage 与 timing；Responses 原生 `tool_search` 声明不再误当普通函数解析。
- 视觉、命名空间、Gemini trailing-turn、resilience 与 timing E2E 均改用 Node provider fixture/mock endpoint，不再依赖已删除 gateway。
- 直连 timing 使用 dispatcher `elapsedMs` 与 request-local usage/status，确保每轮只写一条包含 `upstream_ms`、缓存 token 和失败状态的日志。
- failover dispatcher 传播真实 `rate_limited`/`out_of_usage` reason、`failoverFrom` 与实际 serving route；outer timing/usage 现在记录 fallback model/provider。
- forced-tool coordinator 在 cooldown route 选定后创建；每个 dispatcher hop 会剥离 source forced buffer/callback context，fallback 使用自身 toolBuild/生命周期。
- 普通首跳 402/长 429 failover 会先清理 source deadline/buffer，再由 route-local context factory 创建 candidate coordinator；延迟候选验证、unsupported candidate 与 cleanup-once 均有回归覆盖。

## 残余风险

本机 ignored/untracked 目录中仍可能有历史 Electron/Control Center 构建残留；它们不在 Git tracked shipped file list 中，审计按计划忽略，不属于本提交的运行时交付物。未执行真实安装、服务启动、live provider 或打包流程。
