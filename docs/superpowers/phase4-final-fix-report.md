# Phase 4 final fix report

日期：2026-08-24

本轮关闭 Phase 4 final reviewer 的 integration gaps。当前工作区仍为默认 `main`，未创建或切换 worktree/分支，未推送；沿用同一 `fix: close phase four integration gaps` 提交并 amend，交由父线程最终 reviewer 复核。

## 已关闭 finding

- 更新事务：runtime snapshot 与 preflight 在任何 Git revision mutation 前执行；merge/revision change 位于 migration replacement；失败恢复 runtime 与旧 revision 后只重启一次旧服务；新增 update-level injected ordering regression。
- Codex ownership：install、enable、disable、update、control、refresh-catalog、Codex runtime uninstall 不再调用 config writer；Codex auth-mode、signed-routing、model-set 改为 fail-closed 提示 CC Switch；config.toml 只读且 exact-byte preservation 有回归。
- Local Vision：移除 `control local-models set <tag> on|off`；下载、卸载、Vision inspect/download/runtime 不再创建 chat overlay、修改 provider selection 或重启 Router。
- Release：release workflow 使用 `scripts/package-release.sh`，校验 tag/version/HEAD、manifest 和 SHA256SUMS，不再使用 `git archive`。
- Runtime package：packer 改为 runtime-only allowlist，排除 `test/`、`scripts-check.mjs`、开发检查脚本和 PowerShell shim；加入 tracked `runtime-package.json`，声明可用 Node entrypoints、依赖、当前 README/INSTALL/SECURITY/Devin guide、LICENSE、Router source、browser assets 与 Swift source；重新纳入 `scripts/build-macos-tray-app.sh` 及其实际 Swift/Info.plist 闭包；manifest negative audit 拒绝 test/Python/Electron/Tauri 路径重入。scratch 解包实际运行 `bin/model-router-tray` 到 builder，以隔离 service/端口和 mock Swift/codesign/PlistBuddy 验证无 `.git` 依赖。
- Legacy migration：recognized migration 仅停旧 service/plist 并保留 Codex config.toml 原始字节与模式，不再调用 config writer 或恢复 config 文件。
- Local uninstall：移除隐藏 `finalize-uninstall` command、catalog publication、provider selection 和 restart worker；卸载只更新 Vision inventory/download state。
- Uninstall docs：README 与 `docs/INSTALL.md` 明确 caller key、internal key、provider keys、Codex auth/credentials 和 `config.toml` 默认受保护并保留；测试分别验证保护句与禁止删除/撤销措辞。
- Minor fixes：Vision Responses 使用 dispatcher transformed body；Node runtime shutdown grace timer 可取消且不以 `unref` 丢失等待；symlink fixture 使用 `mkdtempSync`；package CLI 缺少 option value 返回 2。

## Windows 已验证

本机仅执行纯 Node、source、fixture 和静态检查；没有真实 macOS install、launchd、Swift build、app launch 或 live provider 请求。Phase 5 在另一台 Mac 继续隔离安装、服务、browser/Swift visual、package 和获准 live API 验收。

## 最终验证证据

- `npm run check`：通过。
- `git diff --check`：通过。
- Phase4 final fix：12 pass / 0 fail。
- runtime package / tray closure：`node-only-package` 6 pass / 0 fail；target isolation 15 pass / 0 fail / 1 existing skip；service macOS fixture 3 pass / 0 fail；platform gate 9 pass / 0 fail。
- update target：16 pass / 0 fail / 1 existing macOS skip。
- runtime migration：6 pass / 0 fail。
- control：27 pass / 0 fail / 3 existing skips。
- config manager：34 pass / 0 fail / 1 existing skip。
- node-only package：6 pass / 0 fail。
- node runtime：10 pass / 0 fail。
- legacy migration：5 pass / 0 fail。
- local-llm：24 pass / 0 fail。
- routing：78 pass / 0 fail；vision bridge：113 pass / 0 fail。
- fresh default `npm test`：2360 total / 2325 pass / 0 fail / 35 existing skips。

## 交接入口

从默认分支开始运行：

    npm ci
    npm run check
    npm test

测试使用项目默认并发，不传 `--test-concurrency`。交接主文档由父线程在 Phase 4 提交前补充，包含最终 commit、GitHub CI run、剩余 Phase 5 acceptance matrix 和 live probe 状态。
