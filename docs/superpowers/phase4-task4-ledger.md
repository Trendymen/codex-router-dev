# Phase 4 Task 4 修复台账

| 编号 | 现象 | 根因 | 修复与证据 |
| --- | --- | --- | --- |
| I4 | removed-prefix audit 只扫描可见目录 | 未消费 tracked shipped file list | `git ls-files -z` + prefix audit；dependency-removal 正/负控通过 |
| F1 | failover 后主 provider 下一轮未跳过 | 直连成功路径未做 cooldown pre-switch，且错误清理了原始 route | 实际成功 provider 清理；冷却 route 直接重建候选；failover 19/19 |
| F2 | 多候选顺序被 priority 重排 | dispatcher 无法区分显式 chain 与 rank 结果 | `preserveFailoverOrder` 保留配置顺序；multi-candidate 通过 |
| F3 | failover/no-candidate 日志缺失或受 quiet 影响 | 日志在 relay 后才写，且 disabled 也打印 no-candidate | dispatch 选择前写 failover；仅 enabled 记录 no-candidate |
| N1 | direct namespace/tool mapping 422 | Responses `tool_search` 被普通 function dialect 解析；mock terminal 缺 output | native tool-search passthrough；Responses fixtures 补合法 terminal；namespace 4/4 |
| V1 | vision E2E 仍设置旧 gateway 开关 | runner 未注入 Node route/base/credential fixture | 改为 Node fixture，使用可路由 Meta vision model；vision 10/10 |
| R1 | mid-stream direct failure 仍记 200/缺 stream marker | direct handler 未把 safe status/timing/partial stream 交给外层 | `streamAborted`、final status、dispatcher elapsed 透传；resilience 5/5 |
| T1 | timing 重复/`upstream_ms=unknown` | handler 与 outer finally 双写，outer 不知道 direct usage/elapsed | 统一 outer timing，request-local metadata 携带 elapsed/usage；timing 2/2 |
| C1 | client cancel during retry 记 200 | controller signal 已 abort 但未参与 callerGone | signal 纳入 callerGone，外层状态记 0；empty-completion 23/23 |
| G1 | Gemini trailing-turn E2E 被 skip | 旧 gateway fixture | Node direct fixture；2/2 |
| I3 | 429 长限流日志误报 `out_of_usage`，outer timing 仍显示主模型 | dispatcher 未传播 verdict reason，outer route 未采用实际 serving result | 增加 `failoverReason`/`failoverFrom`，outer route/usage/timing 采用 fallback；rate-limited + fallback identity 回归通过 |
| I4 | cooldown/普通首跳 failover 后 source deadline 跨 candidate 验证，candidate 复用 source buffer/context | forced 初始化顺序过早，dispatcher candidate context 全量继承，cleanup 可重复 | cooldown 后与每个 candidate toolBuild 配套创建 route-local coordinator；首跳 402/长 429 延迟验证、unsupported/supported fallback、cleanup-once 回归通过 |

最终提交前验证：`npm run check`、`git diff --check`、I3/I4 affected 164/164、fresh `npm test` 2338/2303/0 均通过；提交由父线程执行 amend，不在此子任务 push。
