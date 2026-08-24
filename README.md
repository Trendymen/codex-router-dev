# Codex Router

Codex Router 是面向 macOS 的 Node 原生本地路由器。它在本机运行一个受保护的 Router 服务、必要的 Node 转发器，以及可选的 Swift 菜单栏 companion，让 Codex CLI/Desktop 使用外部模型，同时保留 Codex 自己的登录与配置文件。

当前交付面只有 Codex CLI/Desktop、macOS、Node.js 和 Swift companion。Router 不写入 Codex 的 config.toml；安装完成后通过 CC Switch snippet 让用户决定客户端配置。

## 安装

### 前置条件

- macOS 13 或更新版本
- Node.js 22.19+ 与 npm
- Git
- Xcode Command Line Tools（需要菜单栏 companion 时）
- 已安装并可运行的 Codex CLI 或 Desktop

安装脚本不会替用户安装系统运行时或包管理器。

### 引导安装

从仓库 checkout 执行：

    ./install.sh --guided

也可以使用 Homebrew 安装后运行：

    brew install codex-router
    codex-router setup --guided

安装过程会在本地生成 Router caller key、选择 provider、保存 provider 凭据并启动服务。密钥只通过隐藏提示输入，不要放进命令参数、日志或 Git 文件。

无凭据验证生命周期：

    ./install.sh --no-provider --no-discovery --no-tray

### CC Switch 配置

安装、启用、禁用和更新只管理 Router state、catalog、服务和 Swift companion，不改写 ~/.codex/config.toml。安装结束时会输出 snippet；也可以随时运行：

    ./bin/control catalog render-snippet

把输出交给 CC Switch 的本地 profile。Router caller URL 含有本机 capability，不能公开分享。

## Provider

Provider 选择属于 Router 自己的 state。常用命令：

    ./bin/model-router codex providers
    ./bin/model-router codex provider-key deepseek set
    ./bin/model-router codex providers enable deepseek
    ./bin/control catalog render-snippet

API key 由隐藏提示读取。DeepSeek、Kimi、Anthropic、xAI、GitHub Copilot、Command Code 和其他已列出的兼容 provider 使用各自的账户与计费；不要把一个 provider 的 key 复制给另一个 provider。

## 服务与诊断

    ./bin/model-router codex status
    ./bin/model-router codex doctor
    ./bin/model-router codex start
    ./bin/model-router codex stop
    ./bin/model-router codex update
    ./bin/model-router codex rollback

服务只监听本机回环地址。默认 Router 端口为 4202，OAuth 转发器为 4201，API 转发器为 4203；端口可通过环境变量调整，但所有隔离验收必须使用独立 ServiceTarget。

doctor 和 status 是只读诊断。修复由 ./bin/doctor --fix 重新运行受保护的 Router 安装流程；成功的安装、更新、修复和卸载都保持 ~/.codex/config.toml 字节不变。

## 本地 Vision

本地模型只作为 Vision reader，不作为 Codex chat route。可以查看硬件适配、下载模型、启动 headless runtime 和选择 Vision engine：

    ./bin/control local-models list
    ./bin/control local-models inspect qwen2.5vl:3b
    ./bin/control local-models install qwen2.5vl:3b --yes
    ./bin/control local-models runtime status
    ./bin/control local-models runtime start --yes
    ./bin/control vision-bridge models
    ./bin/control vision-bridge engine auto

control local-models set ... on|off 已移除。下载和卸载不会创建 chat overlay、修改 provider selection，也不会因为本地模型而重启 Router。

Vision cache 可以通过以下命令安全清理：

    ./bin/control vision-purge-cache

## 安全边界

- caller key、internal key、provider key 和 usage state 写入受保护目录。
- 本地 URL 只暴露回环接口；日志和 support bundle 会脱敏。
- Router 只清理自身 allowlist 内的文件，不使用递归通配删除。
- release package 从 Git HEAD 的 tracked regular files 生成，并附带 manifest 与 SHA256SUMS。

详见 SECURITY.md 与 docs/INSTALL.md。

## 更新、回滚与卸载

更新前会先捕获 Router runtime snapshot，并在 snapshot 与 preflight 成功后才改变 Git revision。替换启动、健康检查、catalog 发布和清理全部成功才提交新 runtime；任一步骤失败都会恢复旧 runtime、旧 revision，再只重启一次旧服务。

    ./bin/model-router codex update
    ./bin/model-router codex rollback
    ./bin/model-router codex uninstall

卸载会撤销 Router 自己的服务、catalog、skills 和 companion。caller key、internal key、provider keys、Codex 身份验证、用户 credentials、用户 profile 和 config.toml 均受保护并保留原样。

## 开发与验证

    npm ci
    npm run check
    npm test

测试使用项目默认并发，不把并发数写进命令或脚本。完整测试应在 macOS 运行；当前主线上的纯 Node、源检查和 Swift fixture 可在其他环境进行只读验证。

source checkout 的 scratch 验证：

    ./scripts/package-release.sh --output generated/release

runtime release 不包含测试目录或开发检查脚本；它携带 runtime-package.json，声明实际可用的 Node entrypoints、依赖、assets 和文档。manifest、archive 与 checksum 共用同一份 tracked entry list。

## 项目文档

- [安装、升级与回滚](docs/INSTALL.md)
- [安全模型](SECURITY.md)
- [许可证](LICENSE)
- [Devin CLI probe](docs/DEVIN-CLI-PROBE.md)
