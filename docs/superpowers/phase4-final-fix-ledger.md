# Phase 4 final fix ledger

| Finding | 修复 | focused evidence |
| --- | --- | --- |
| update ordering | `migrateRuntime.preflight`；snapshot/preflight before merge；restore old revision before one restart | `test/phase4-final-fix.test.mjs`, `test/update-target.test.mjs`, `test/runtime-migration.test.mjs` |
| Codex config ownership | public lifecycle paths remove config writer; control mutations fail closed; refresh/uninstall preserve client document | `test/phase4-final-fix.test.mjs`, `test/control.test.mjs`, `test/config-manager.test.mjs`, `test/refresh-catalog.test.mjs` |
| local chat mutation | local-models set path removed; local pull/uninstall are Vision-only and do not publish/restart | `test/local-llm.test.mjs`, `test/local-models.test.mjs` |
| release workflow | verified packer, tag/version/HEAD, manifest/checksum validation; no archive fallback | `test/phase4-final-fix.test.mjs`, `test/node-only-package.test.mjs` |
| runtime package closure | runtime-package metadata and allowlist exclude test/check/Python/Electron/Tauri paths while closing shipped links | `test/phase4-final-fix.test.mjs`, `test/node-only-package.test.mjs` |
| Swift Tray builder closure | runtime archive carries `scripts/build-macos-tray-app.sh`; unpack test drives the real tray wrapper with isolated labels/ports and mocked Swift/signing tools | `test/phase4-final-fix.test.mjs`, `test/target-isolation.test.mjs`, `test/service-macos-node-only.test.mjs` |
| legacy migration ownership | recognized migration stops old service/plist but never writes or restores Codex config.toml | `test/phase4-final-fix.test.mjs`, `test/legacy-migration.test.mjs` |
| local uninstall ownership | hidden finalization removed; worker updates only Vision inventory/download state | `test/phase4-final-fix.test.mjs`, `test/local-llm.test.mjs` |
| uninstall retention docs | README/INSTALL explicitly retain caller/internal/provider keys, Codex auth and config; protected sentence has no deletion/revocation wording | `test/phase4-final-fix.test.mjs` |
| minor races/fixtures | transformed dispatcher body, cancellable shutdown wait, unique symlink fixture, CLI exit 2 | `test/phase4-final-fix.test.mjs`, `test/node-runtime.test.mjs`, `test/target-isolation.test.mjs` |

## Gate policy

- 每次只运行一套测试，使用项目默认并发。
- Windows 只做 Node/source/fixture 验证；macOS install、launchd、Swift、视觉和 live provider 验收留到 Phase 5。
- 本轮仅 amend 同一 final-fix 提交，不推送；完成后交由父线程 reviewer RE_REVIEW。
