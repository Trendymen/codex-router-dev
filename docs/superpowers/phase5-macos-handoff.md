# Phase 5 macOS 续接交接

更新日期：2026-08-24

## 当前状态

- Phase 4 已在默认分支 `main` 完成，最终 SPEC_COMPLIANCE 与 CODE_QUALITY 均为 `APPROVED`。
- Phase 4 批准头：`5a1860a55dbee8a0130040a17acfec514aeea3a2`。
- 开发始终在当前主工作区完成，没有创建或切换 Git worktree、没有切换功能分支。
- 当前产品目标是 macOS 上的 Codex CLI/Desktop。公开 DSH/Gemini target、Python/LiteLLM gateway、Rust/Tauri/Electron/Control Center 交付均已移除。
- Windows 本机没有执行真实 macOS build、package install、LaunchAgent、app launch、视觉验收或 live provider 请求。
- GitHub CI：首次 Phase 4 推送后补充确切 run URL 与最终结果。

## Phase 4 交付摘要

主要提交：

- `6594d0e` — Node-only Router/forwarder runtime 与 health。
- `6237141` — macOS-only pre-write gate 与统一 ServiceTarget。
- `1c4d6ad` — 可逆 runtime migration、快照、回滚与 closed cleanup。
- `1919053` — restore short-write、metadata durability 与 backup 安全修复。
- `0589abb` — 移除旧 Python/LiteLLM/Rust/Tauri/Electron runtime，迁移完整 Node direct pipeline。
- `8daef0f` — Node-only macOS LaunchAgent、确定性 runtime package 与 Swift source fingerprint。
- `5a1860a` — Phase 4 final integration fix：Codex config no-write、update ordering、Vision-only local、release/docs/package closure、可信平台 gate。

最终 Windows 验证：

- `npm run check`：通过。
- Phase 4 pre-push：66 pass / 1 macOS 条件 skip / 0 fail。
- final platform/package/target：39 pass / 0 fail / 0 skip。
- fresh 默认 `npm test`：2362 total / 2327 pass / 35 existing skips / 0 fail。
- 测试均使用项目默认并发，没有传 `--test-concurrency`。

## Mac 开始前

只使用默认分支和普通 checkout，不创建 worktree：

```bash
git switch main
git pull --ff-only
git status --short --branch
node --version
npm --version
npm ci
npm run check
npm test
```

Node 必须为 22.19.0 或更高版本。开始任何 acceptance 前先确认工作树 clean，并重新读取全局与仓库 `AGENTS.md`。

## Phase 5 入口与范围

执行计划：

`docs/superpowers/plans/2026-08-21-node-native-router-phase-5-acceptance-release.md`

按计划连续完成以下内容：

1. 在隔离 root/label/ports 下验证 clean install、已知旧版本升级、失败回滚与 uninstall；不得触碰现有 managed installation。
2. 真实构建 Swift Tray 和 runtime release，核对 manifest、SHA256SUMS、文件模式、可复现归档与 app capability probe。
3. 真实 LaunchAgent bootstrap/health/restart/stop，验证 Router 与所有启用 Node forwarder；禁止出现 Python/gateway/4200。
4. 运行 browser contract、Swift command contract、app launch、视觉与可访问性验收。
5. 验证 update 的 snapshot → revision switch → install/verify → cleanup，以及失败时 runtime+revision restore → 单次旧服务 restart。
6. 完成 release/docs 最终审查、tag/release workflow 与 GitHub macOS CI 验证。

所有真实安装/服务操作必须使用 `resolveServiceTarget()` 产生的 validated acceptance target。production target 不接受测试工具覆盖；fixture context 只允许真实 Darwin，且强制 build-only/dry-run，不能安装 service 或写 stamp。

## Live provider 验收

- 用户已授权 Phase 5 中必要的配额请求。
- 第三方 API 只使用 DeepSeek 官方 API；本机受保护配置入口为 `~/.ai-configs/deepseek`。
- 不得读取、打印、复制或提交 key；不要把 key 放进聊天、命令参数、环境输出、日志或 tracked 文件。
- Ali Bailian 当前没有可运行 key，相关矩阵明确标记 `NOT RUN`，不要伪造通过。
- 每个 live probe 先运行本地/隔离 fixture，再以最少请求验证 model、stream、tool、reasoning、usage/cache 与错误边界。

Phase 2 遗留绑定项必须在 live 前关闭：verified-foreign 顶层 reasoning 不能留下空 assistant message；GLM/Z.ai 集成要验证 reasoning 与 visible content 严格分离。

## 不要做的事

- 不创建或切换 worktree/功能分支。
- 不恢复 DSH/Gemini public publication、Windows/Linux runtime、Python/LiteLLM、Tauri/Electron 或 local chat route。
- 不写 Codex `config.toml`；安装、更新、repair、卸载都必须保持其精确字节。
- 不使用宽泛递归 cleanup，不删除 provider keys、caller/internal keys、Codex auth/history/profile 或其他用户文件。
- 不在测试中设置并发覆盖；继续使用项目默认并发。
- 不用 live production target 做 acceptance，不在现有 managed service 上试验。

## 完成标准

Phase 5 只有在真实 macOS install/upgrade/rollback/service/package/Swift/browser/visual/live acceptance 全部有证据、final reviewers 批准、默认分支 GitHub CI 全绿后才可标记完成。
