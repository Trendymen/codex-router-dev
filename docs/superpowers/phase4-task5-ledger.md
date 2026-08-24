# Phase 4 Task 5 修复台账

| 编号 | 发现 | 修复与证据 |
| --- | --- | --- |
| C1 | `cp -R` 会把未跟踪文件、symlink 或 SwiftPM 残留带入发布包 | `git ls-files -s -z` 的 tracked file-level allowlist；lstat/realpath containment；regular/nlink 校验；scratch secret/symlink/hardlink 回归通过 |
| I1 | tray 显式 bundle 参数只做字符串前缀判断，可被 `..` 或 symlink 绕过 | `validatePathWithin` 统一检查绝对路径、dot segment、边界和中间 symlink；build script 所有目标写入使用验证后的 bundle path |
| SPEC-port | LaunchAgent 未发布 Grok/Devin 端口别名 | 增加 `MODEL_ROUTER_GROK_OAUTH_PORT`、`MODEL_ROUTER_DEVIN_CLI_PORT` 及对应 `CODEX_ROUTER_*` aliases；service fixture 断言 5208/5210 |
| I2 | shell `tar`/递归复制不保证 owner、mode、mtime、gzip 和 entry 顺序稳定 | Node USTAR + 固定 gzip writer；byte-order sort；manifest/archive 同一 entry list；重复 scratch build byte-identical |
| I3 | 原测试只做正则，未验证真实包内容 | scratch Git fixture 读取并解析 tar，逐条核对 manifest 类型、规范化模式、bytes、SHA-256 和 checksum |
| SPEC-Swift | fingerprint 只覆盖顶层 Swift 文件和单个 Info.plist | 递归覆盖 `Sources/**` 与 `Resources/**`，包含嵌套资源；nested resource 变更使 fingerprint 变化，symlink 输入拒绝 |
| C2 | packager 从 dirty tracked 工作树读取，无法证明 release provenance | `git ls-tree HEAD` + stage-0 blob/mode + 单次 `git cat-file --batch`；staged+unstaged dirty fixture 仍输出 HEAD bytes/sourceCommit |
| I2 | USTAR 只尝试最后一个 slash，UTF-8/多级 prefix 边界未充分验证 | 所有 slash 组合按 UTF-8 byte length 选择合法 prefix/name；覆盖 100/101/255、多级、UTF-8 边界和超限拒绝 |
| S2 | fingerprint 的字符串拼接会让二进制内容和边界产生碰撞，读失败被吞掉 | 原始 Buffer hash 加路径/内容长度 framing；0x80→0x81、read failure、symlink 均有回归 |
| I4 | `validatePathWithin` 未检查 parent 本身、全祖先及 canonical 最近 existing parent | parent/祖先 lstat+realpath 全链路检查，canonical candidate containment，Windows junction/parent symlink fixture |

当前 HEAD 为 Task5 amend 提交。未推送，真实 macOS 构建/安装/服务验收留 Phase 5。
