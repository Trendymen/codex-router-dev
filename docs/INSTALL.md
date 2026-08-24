# 安装、升级与回滚

本文描述当前 macOS Node Router 交付。安装、更新和卸载只管理 Router 自己的 state、catalog、服务和 companion；不会写入 Codex 的 config.toml，也不会接管 Codex 身份验证。

## 支持条件

- macOS 13 或更新版本
- Node.js 22.19+ 与 npm
- Git
- Codex CLI 或 Desktop
- Xcode Command Line Tools（需要 Swift companion 时）

安装、配置和服务命令只面向当前 macOS 交付。

## 安装

从 checkout 安装：

    ./install.sh --guided

不需要交互时：

    ./install.sh --auto --providers configured

安装目录应是稳定路径。默认目录为 ~/.local/share/codex-router；后台服务从该 checkout 启动，不从临时目录启动。

没有 provider 凭据时可先做生命周期验证：

    ./install.sh --no-provider --no-discovery --no-tray

这会启动空的 Router；请求会收到本地配置错误，不会发出 provider 请求。

## 配置边界

Router 通过自己的 state 文件保存 provider selection、caller key、internal key、catalog 和 usage。安装、enable、disable、update、repair、uninstall 都不会写 ~/.codex/config.toml。

安装完成后生成 CC Switch snippet：

    ./bin/control catalog render-snippet

把 snippet 粘贴到 CC Switch 的本地 profile，由用户决定 Codex 的 model、provider 和其他设置。Router 不会替用户改写这些设置。

doctor 和 status 只读 Codex 配置并报告诊断。doctor --fix 只修复 Router state、依赖、catalog、服务和 companion；成功执行后 config.toml 必须保持完全相同的字节。

## Provider 凭据

不要把 key 放在命令参数、环境快照、日志、issue 或 tracked 文件中。通过隐藏提示保存：

    ./bin/model-router codex provider-key deepseek set
    ./bin/model-router codex provider-key kimi-api set
    ./bin/model-router codex provider-key anthropic-api set

然后选择并发布 provider：

    ./bin/model-router codex providers enable deepseek
    ./bin/control catalog render-snippet

每个 provider 使用自己的账户、端点和计费。DeepSeek 官方 API 验证只应使用本机受保护配置，不要把 key 复制到仓库。

需要显式同意才会产生配额请求：

    ./bin/smoke-test --yes

## 服务

    ./bin/model-router codex start
    ./bin/model-router codex stop
    ./bin/model-router codex status
    ./bin/model-router codex doctor

默认 Router 端口为 4202，OAuth 转发器为 4201，API 转发器为 4203。服务只监听本机回环地址。验收测试必须使用独立 ServiceTarget、label、端口和 state/support 根目录。

## 更新事务

更新流程如下：

1. 检查 checkout、origin、main 分支和本地 tracked 修改。
2. 在任何 Git revision 变化前捕获 Router runtime snapshot 并执行 preflight。
3. 在 migration installReplacement 中执行 fast-forward 和新 revision 安装。
4. 等待 Router、转发器、catalog 和必要 companion contract 通过。
5. 成功后清理旧 Router-owned artifacts。
6. 任一步骤失败时恢复 runtime 和旧 revision，再只重启一次旧服务。

更新和回滚：

    ./bin/model-router codex update
    ./bin/model-router codex update check
    ./bin/model-router codex rollback

有 tracked 本地修改时默认拒绝更新；只有明确传 --force 才会丢弃 tracked 修改。untracked 文件不会被清理。

## 卸载

    ./bin/model-router codex uninstall

卸载会删除 Router 自己的服务、catalog、managed skills 和 companion。caller key、internal key、provider keys、Codex 登录、身份验证、用户 credentials、用户 profile 与 config.toml 均受保护并保留原样。

## 本地 Vision

本地模型不再作为 Codex chat route。保留的操作只用于 Vision reader、下载和 headless runtime：

    ./bin/control local-models list
    ./bin/control local-models inspect qwen2.5vl:3b
    ./bin/control local-models install qwen2.5vl:3b --yes
    ./bin/control local-models runtime status
    ./bin/control local-models runtime start --yes
    ./bin/control vision-bridge models

local-models set on/off 已移除。下载和卸载不会改 provider selection、chat overlay 或 Router 服务。

## 从源码验证

    npm ci
    npm run check
    npm test
    ./scripts/package-release.sh --output generated/release

测试保持项目默认并发；不要在命令、脚本或子代理参数中加入 test-concurrency 覆盖。source checkout 的测试命令不属于 runtime release；runtime-package.json 声明实际可用的 Node entrypoints、依赖、assets 和文档。发布包的 manifest、archive 和 SHA256SUMS 必须对应同一份 Git HEAD tracked entry list。

## 交接到另一台 Mac

1. 从仓库默认分支 checkout，确认 Node.js 22.19+ 和 npm。
2. 先运行 npm ci、npm run check、npm test。
3. 运行 Phase 4 的 Node、source、package fixture，确认 GitHub CI 与本地结果一致。
4. 使用隔离 acceptance root 做安装、服务、浏览器和 Swift 验收；不要触碰现有 managed installation。
5. 通过本机受保护的 DeepSeek 官方 API 配置做获准 live probe；不可用的其他 API 标记为 NOT RUN，不伪造通过。
6. 按 Phase 5 计划继续真实 macOS build、package、launchd、app launch、visual 和 live acceptance。

更多安全约束见 SECURITY.md；项目概览见 README.md。
