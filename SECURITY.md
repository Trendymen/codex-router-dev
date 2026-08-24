# 安全模型

Codex Router 是只绑定本机回环接口的 macOS Node 服务。它的安全边界是：不改写 Codex 身份验证与用户配置、只管理自己的 state、只从 tracked Git HEAD 构建 release package，并对文件、URL、日志和进程使用 fail-closed 检查。

## 保护对象

| 对象 | 用途 | 保护要求 |
| --- | --- | --- |
| caller-secret | Codex/CC Switch 调用 Router 的 capability | 私有目录、600、从日志脱敏 |
| internal-secret | Router 内部子服务认证 | 私有目录、600、从日志脱敏 |
| provider key | 外部 provider 认证 | 私有目录、600、禁止出现在参数和日志 |
| provider selection | Router 自己的启用集合 | 原子写入、同一事务发布 catalog |
| catalog generations | Codex 可见的 Router models | 原子发布、旧 generation 可恢复 |
| install manifest | 版本、revision 和 rollback 元数据 | 600、只记录 Router-owned 路径 |
| usage/log state | 运行诊断与计费摘要 | 脱敏、限制大小、不可回传密钥 |

Router 不拥有 ~/.codex/config.toml。安装、启用、禁用、更新、修复、状态、诊断和卸载都不得写它，也不得删除其中的用户表、注释、身份验证或 profile。CC Switch snippet 由 control catalog render-snippet 输出，用户在客户端侧决定是否采用。

## 文件与路径

- 所有 Router state 目录创建为 700；私有文件创建为 600。
- atomic writer 在临时文件完成内容与权限保护后才 rename。
- 受保护 runtime 只通过显式 artifact allowlist 解析；拒绝 dot segment、绝对越界、symlink、junction、hardlink 和未知 artifact id。唯一受控例外是六个 state catalog stable path：它们必须精确链接到 `catalog-generations/current/<固定文件名>`，`current` 必须链接到同目录下的直接 generation，且该 generation 只能含六个 600、单链接、私有 regular artifact；绝不接受 junction、绝对或回退目标、嵌套 target、dangling link 或 Windows 的链接权限降级。
- release packer 读取 Git HEAD 的 stage-0 regular blobs，不读取 dirty 工作树、未跟踪文件或目录递归副本。
- cleanup 不接受通配符或任意递归路径；未知文件保留并报告。

## 网络与进程

- Router、OAuth forwarder、API forwarder 和可用 provider forwarder 只绑定 127.0.0.1。
- 外部请求必须先经过 caller capability 校验；caller key 不转发给 provider。
- child process 都属于当前 Router runtime；启动失败会清理已经启动的 child，停止流程先发 SIGTERM，再在 grace window 后使用 SIGKILL。
- 健康检查区分 Router 未监听与某个 Node dependency degraded；响应只返回固定服务名，不返回 URL、key 或 provider payload。
- live provider probe 必须显式获准，并使用本机受保护凭据；失败响应正文不写入日志。

## 更新与恢复

更新事务在任何 Git revision mutation 前完成 runtime snapshot 和 preflight。replacement 只有在 Router、forwarder、catalog 与 companion contract 全部验证后才提交清理。失败路径按顺序恢复 Router-owned runtime、旧 revision，并只重启一次旧服务；恢复失败与原始错误一起报告。

snapshot 包含原始字节、模式和 allowlist identity。对于受控 catalog topology，snapshot 以 resolver-bound ServiceTarget 的 state root 为唯一边界，记录 pointer identity、generation、六个 artifact 的字节/模式与 digest；所有 snapshot entry 和 topology 在任何写入前完成校验。恢复始终保留 stable link topology：原 generation 仍精确匹配时只原子切回 pointer；若 generation 被删除或失配则先写入新的私有 generation 再切换 pointer。pointer 提交后的 fsync 或验证失败会切回旧 pointer 并删除未激活的新 generation；清理失败与 primary error 聚合。任何未知、混合或被篡改的 stable topology 都 fail-closed，不会把链接降级恢复成 regular file。恢复不触碰 Codex config.toml、CC Switch 数据库、用户 credentials、历史文件或不属于 Router 的模型权重。

## Release package

发布前必须确认 tag 指向当前 HEAD、package version 与 tag 一致。scripts/package-release.sh 生成 source archive、manifest.json 和 SHA256SUMS；manifest、archive 和 checksum 使用同一份 tracked file entry list。发布 workflow 不使用 git archive 回退路径。

runtime release 不宣称提供 npm run check 或 npm test；runtime-package.json 声明实际可用的 Node scripts、依赖、entrypoints、当前文档、Router source、catalog、browser assets 和 Swift source，且所有 Markdown 本地链接在解包后仍然存在。

## 报告

请不要在 issue 或聊天中贴 provider key、caller URL、完整 support bundle、用户 config.toml 或未经脱敏的日志。报告问题时提供版本、commit、命令、退出码和已脱敏的错误摘要。

完整安装流程见 [docs/INSTALL.md](docs/INSTALL.md)，项目概览见 [README.md](README.md)，许可证见 [LICENSE](LICENSE)。
