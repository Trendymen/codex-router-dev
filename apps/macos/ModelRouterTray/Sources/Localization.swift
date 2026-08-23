import Foundation

/// The language the tray renders in. `system` follows macOS's preferred
/// languages, which is what somebody who has already set their Mac to Chinese
/// expects; the explicit cases are for everyone whose Mac is in one language
/// and who wants this app in another. That combination is common enough --
/// a Chinese speaker on an English macOS install, or the reverse -- that
/// following the OS alone leaves them with no way to ask.
enum TrayLanguage: String, CaseIterable, Identifiable {
  case system
  case english
  case chinese
  case arabic
  case hindi
  case japanese
  case korean

  var id: String { rawValue }

  /// Deliberately shown in the language each option selects, not in the
  /// current one: somebody who cannot read the current language still has to
  /// be able to find their way out.
  ///
  /// `system` additionally names what it currently resolves to. Without that
  /// it is the one option whose label says nothing about the language you
  /// would get -- and worse, it is itself translated, so picking Chinese makes
  /// "System" read as 跟随系统 even on an English Mac, which looks like the
  /// setting is stuck.
  var label: String {
    switch self {
    case .system:
      return "\(routerLocalized("System")) · \(RouterLanguage.systemResolution.nativeName)"
    case .english: return "English"
    case .chinese: return "中文"
    case .arabic: return "العربية"
    case .hindi: return "हिन्दी"
    case .japanese: return "日本語"
    case .korean: return "한국어"
    }
  }
}

/// A concrete language the tray can render in: `TrayLanguage` minus `system`,
/// which resolves to one of these.
enum ResolvedTrayLanguage {
  case english
  case chinese
  case arabic
  case hindi
  case japanese
  case korean

  var nativeName: String {
    switch self {
    case .english: return "English"
    case .chinese: return "中文"
    case .arabic: return "العربية"
    case .hindi: return "हिन्दी"
    case .japanese: return "日本語"
    case .korean: return "한국어"
    }
  }

  /// English is the source text itself, so it carries no table.
  var table: [String: String]? {
    switch self {
    case .english: return nil
    case .chinese: return RouterChineseText.values
    case .arabic: return RouterArabicText.values
    case .hindi: return RouterHindiText.values
    case .japanese: return RouterJapaneseText.values
    case .korean: return RouterKoreanText.values
    }
  }
}

enum RouterLanguage {
  static let storageKey = "ModelRouterTray.language"

  /// Read on every localized string, so it is cached rather than hitting
  /// UserDefaults each time. `setSelection` is the only writer.
  private(set) static var selection: TrayLanguage = {
    let raw = UserDefaults.standard.string(forKey: storageKey)
    return raw.flatMap(TrayLanguage.init(rawValue:)) ?? .system
  }()

  static func setSelection(_ next: TrayLanguage) {
    selection = next
    UserDefaults.standard.set(next.rawValue, forKey: storageKey)
  }

  static var systemResolution: ResolvedTrayLanguage {
    let preferred = (Locale.preferredLanguages.first ?? Locale.current.identifier).lowercased()
    if preferred.hasPrefix("zh") { return .chinese }
    if preferred.hasPrefix("ar") { return .arabic }
    if preferred.hasPrefix("hi") { return .hindi }
    if preferred.hasPrefix("ja") { return .japanese }
    if preferred.hasPrefix("ko") { return .korean }
    return .english
  }

  static var systemPrefersChinese: Bool { systemResolution == .chinese }

  static var resolution: ResolvedTrayLanguage {
    switch selection {
    case .system: return systemResolution
    case .english: return .english
    case .chinese: return .chinese
    case .arabic: return .arabic
    case .hindi: return .hindi
    case .japanese: return .japanese
    case .korean: return .korean
    }
  }

  /// Kept for the call sites that compose Chinese strings inline; those fall
  /// back to English in every other translated language.
  static var isSimplifiedChinese: Bool { resolution == .chinese }
}

/// Small, dependency-free localization layer for strings rendered by the
/// native tray and Dynamic Island. English remains the source text and the
/// fallback, so a newly added string is still usable before its translation is
/// added.
func routerLocalized(_ english: String) -> String {
  RouterLanguage.resolution.table?[english] ?? english
}

func routerFormat(_ english: String, _ arguments: CVarArg...) -> String {
  let format = routerLocalized(english)
  return String(format: format, arguments: arguments)
}

enum RouterChineseText {
  static let values: [String: String] = [
    "Uninstalling": "正在卸载",
    "Off by default · replaces consumed tool results on external models": "默认关闭 · 在外部模型上替换已使用的工具结果",
    "Fix Codex Router installation": "修复 Codex 路由安装",
    "Language": "语言",
    "System": "跟随系统",
    "Tray language. Reopen the panel to apply everywhere.": "托盘语言。重新打开面板即可全部生效。",
    "Usage and activity over the notch on every display": "在每个显示器的刘海处显示用量和活动",
    "Off by default. The menu-bar panel stays available either way.": "默认关闭。无论如何，菜单栏面板始终可用。",
    "Idle": "空闲",
    "Thinking": "思考中",
    "Starting": "启动中",
    "Error": "错误",
    "Codex subscription": "Codex 订阅",
    "%@ left": "剩余 %@",
    "%d chats": "%d 个会话",
    "Active session": "活动会话",
    "No traffic": "暂无流量",
    "Ready to enable": "已准备好启用",
    "Needs setup": "需要设置",
    "OAuth · enabled": "OAuth · 已启用",
    "API · enabled": "API · 已启用",
    "Always": "始终显示",
    "With Codex": "随 Codex 显示",
    "Off": "关闭",
    "Notch": "刘海区域",
    "Desktop": "桌面",
    "Usage": "用量",
    "Status": "状态",
    "Settings": "设置",
    "Model Router": "模型路由",
    "Updated": "已更新",
    "None": "无",
    "none": "无",
    "Local": "本地",
    "Auto": "自动",
    "Codex account": "Codex 账户",
    "ChatGPT %@": "ChatGPT %@",
    "ChatGPT limit": "ChatGPT 限制",
    "Current usage": "当前用量",
    "All usage": "全部用量",
    "7-day snapshot": "过去 7 天快照",
    "Tokens by model": "按模型统计 token",
    "Router": "路由",
    "Model speed": "模型速度",
    "Live requests": "实时请求",
    "Quota resets": "额度重置",
    "No traffic right now": "当前没有流量",
    "No model observed": "尚未观测到模型",
    "No usage recorded yet": "尚未记录用量",
    "Waiting": "等待中",
    "No samples": "暂无样本",
    "Appears after a metered reply": "完成一次计量回复后显示",
    "Observed output throughput": "已观测的输出吞吐量",
    "Nothing in flight": "当前没有进行中的请求",
    "no tools — can't chat": "没有工具 — 无法聊天",
    "works in Codex": "可在 Codex 中运行",
    "unreliable in Codex": "在 Codex 中不稳定",
    "not offered yet": "暂未提供",
    "fails in Codex": "在 Codex 中失败",
    "chat — untested": "聊天 — 未测试",
    "Provider added. Restart Codex to refresh its model picker.": "提供商已添加。请重启 Codex 以刷新模型选择器。",
    "Provider hidden. Restart Codex to refresh its model picker.": "提供商已隐藏。请重启 Codex 以刷新模型选择器。",
    "Show tray": "显示菜单栏图标",
    "Appears with Codex or ChatGPT, hides when they quit": "Codex 或 ChatGPT 运行时显示，退出后隐藏",
    "Kept on: a terminal session has no window to follow": "保持开启：终端会话没有可跟随的窗口",
    "DeepSeek Harness": "DeepSeek Harness",
    "Install DeepSeek Harness and publish this router's models into it": "安装 DeepSeek Harness 并将本路由的模型发布到其中",
    "Not installed · installs the CLI, then publishes this router's models": "未安装 · 将安装 CLI，然后发布本路由的模型",
    "Needs Node %@ or newer; this router runs Node %@": "需要 Node %@ 或更高版本；本路由运行的是 Node %@",
    "%@ · routed models published · `dsh web` to start": "%@ · 已发布路由模型 · 运行 `dsh web` 启动",
    "%@ · installed but not routed here yet": "%@ · 已安装，但尚未接入本路由",
    "%d models published. Run `%@` to start.": "已发布 %d 个模型。运行 `%@` 启动。",
    "Installing DeepSeek Harness…": "正在安装 DeepSeek Harness…",
    "Publishing routed models…": "正在发布路由模型…",
    "Setting up DeepSeek Harness": "正在设置 DeepSeek Harness",
    "Connect": "接入",
    "Open site": "打开网页",
    "Turn off": "关闭",
    "Disconnect": "断开连接",
    "Stopping…": "正在停止…",
    "Stopped. Memory and CPU released.": "已停止。内存和 CPU 已释放。",
    "This harness was started outside the router — stop it where you started it.": "该 Harness 不是由本路由启动的 — 请在启动它的位置停止。",
    "Stop the harness process and free its memory and CPU": "停止 Harness 进程并释放其内存和 CPU",
    "Disconnecting…": "正在断开…",
    "Turned off. The harness and its own settings were kept.": "已关闭。Harness 及其自身设置已保留。",
    "Remove this router's models from the harness, keeping the harness itself": "从 Harness 中移除本路由的模型，但保留 Harness 本身",
    "Start": "启动",
    "Open the DeepSeek Harness browser UI": "打开 DeepSeek Harness 浏览器界面",
    "Start the DeepSeek Harness browser UI": "启动 DeepSeek Harness 浏览器界面",
    "Starting DeepSeek Harness…": "正在启动 DeepSeek Harness…",
    "%@ · running at %@": "%@ · 运行于 %@",
    "%@ · routed models published · not running": "%@ · 已发布路由模型 · 未运行",
    "%d models published. Press play to open the harness.": "已发布 %d 个模型。按播放按钮打开 Harness。",
    "%d models published, but the harness UI did not start: %@": "已发布 %d 个模型，但 Harness 界面未能启动：%@",
    "Menu bar icon stays visible": "菜单栏图标始终显示",
    "Dynamic Island": "动态岛",
    "Quotas and live activity pinned to the desktop": "将额度和实时活动固定在桌面",
    "Show provider usage and activity status": "显示提供商用量和活动状态",
    "Use Router with ChatGPT": "在 ChatGPT 中使用路由",
    "Native GPT + external models · task history preserved": "原生 GPT + 外部模型 · 保留任务历史",
    "Keep ChatGPT login and the current task history": "保留 ChatGPT 登录和当前任务历史",
    "Use without OpenAI login": "不使用 OpenAI 登录",
    "External providers · Codex restarts automatically": "外部提供商 · Codex 会自动重启",
    "Use connected models and restart Codex": "使用已连接模型并重启 Codex",
    "Compact old tool results": "压缩旧工具结果",
    "Effort as subagent": "作为子代理的思考强度",
    "Forced off by CODEX_ROUTER_TOOL_RESULT_AGING=0": "已被 CODEX_ROUTER_TOOL_RESULT_AGING=0 强制关闭",
    "External models · applies on the next request": "外部模型 · 下次请求生效",
    "Providers": "提供商",
    "Auto-saved": "自动保存",
    "Applying…": "应用中…",
    "Subagent models": "子代理模型",
    "All proven models": "所有已验证模型",
    "Model picker": "模型选择器",
    "Local LLMs": "本地 LLM",
    "Vision": "视觉",
    "Subagent choices do not hide models from Codex's picker — use Model picker below for that.": "子代理选择不会隐藏 Codex 选择器中的模型；如需隐藏模型，请使用下面的模型选择器。",
    "Hidden models stay connected but are not offered by Codex.": "隐藏的模型仍保持连接，但不会提供给 Codex。",
    "Run models locally through Ollama. Enable an installed model to make it available to Codex.": "通过 Ollama 在本地运行模型。启用已安装的模型即可提供给 Codex。",
    "Nothing installed yet. Start with a quick pick or browse the Ollama catalog below.": "尚未安装模型。请选择快速选项，或浏览下面的 Ollama 目录。",
    "Install a model": "安装模型",
    "Install": "安装",
    "Clear": "清除",
    "Download": "下载",
    "Cancel": "取消",
    "Confirm": "确认",
    "Confirm removal?": "确认移除？",
    "Remove model": "移除模型",
    "Measure speed": "测量速度",
    "Test image reading": "测试图像读取",
    "Use for image reading": "用于图像读取",
    "Reading images": "读取图像",
    "loaded": "已加载",
    "Installing local model": "正在安装本地模型",
    "Local model ready": "本地模型已就绪",
    "Local model install failed": "本地模型安装失败",
    "Text-only models can't see images. When on, a vision model reads the paste and hands over the text.": "纯文本模型无法查看图像。开启后，将使用视觉模型读取粘贴内容并交给文本模型。",
    "Read images for text-only models": "为纯文本模型读取图像",
    "Engine": "引擎",
    "Paid (cloud)": "付费（云端）",
    "Your ChatGPT plan": "你的 ChatGPT 方案",
    "Model default": "模型默认",
    "Update": "更新",
    "Fix": "修复",
    "Working…": "处理中…",
    "Update or fix failed": "更新或修复失败",
    "Router unavailable": "路由不可用",
    "Run setup, then refresh this panel.": "请先运行设置，然后刷新此面板。",
    "Refresh": "刷新",
    "Refreshing…": "刷新中…",
    "%d accounts": "%d 个账号",
    "Restart": "重启",
    "Restarting…": "正在重启…",
    "Restart failed: %@": "重启失败：%@",
    "Restarted without updating: %@": "已重启但未更新：%@",
    "Awaiting data": "等待数据",
    "Quit": "退出",
    "API key": "API 密钥",
    "Replacement %@": "替换 %@",
    "Paste %@": "粘贴 %@",
    "Click the check again to delete this credential": "再次点击勾号以删除此凭据",
    "Checking setup…": "正在检查设置…",
    "Session expired · reconnect for account usage": "会话已过期 · 请重新连接以查看账户用量",
    "Official CLI required": "需要官方 CLI",
    "Sign in with the official CLI": "使用官方 CLI 登录",
    "Setup required": "需要设置",
    "Reconnect": "重新连接",
    "Reconnect OAuth": "重新连接 OAuth",
    "Install & Sign In": "安装并登录",
    "Sign In": "登录",
    "Install the official CLI and sign in": "安装官方 CLI 并登录",
    "Sign in again with the official CLI": "使用官方 CLI 重新登录",
    "Cancel credential replacement": "取消替换凭据",
    "Click again to delete the stored credential": "再次点击以删除已保存的凭据",
    "Remove stored %@": "移除已保存的 %@",
    "Available in Codex": "可在 Codex 中使用",
    "Hidden from Codex": "已从 Codex 隐藏",
    "Signed in": "已登录",
    "Add Key": "添加密钥",
    "Save": "保存",
    "Open usage dashboard": "打开用量面板",
    "Daily token usage": "每日 token 用量",
    "Full": "完整",
    "Full token numbers": "完整 token 数",
    "Millions of tokens": "百万 token",
    "Token unit": "token 单位",
    "Router traffic": "路由流量",
    "Loading provider usage…": "正在加载提供商用量…",
    "Loading native Codex usage…": "正在加载原生 Codex 用量…",
    "Set up this provider below to fetch its account usage.": "请在下方设置此提供商以获取账户用量。",
    "Usage limit": "用量限制",
    "No reset reported": "未提供重置时间",
    "Reconnect below": "请在下方重新连接",
    "OAuth expired · reconnect below": "OAuth 已过期 · 请在下方重新连接",
    "No router traffic yet": "尚无路由流量",
    "Configured · currently hidden": "已配置 · 当前隐藏",
    "Sign in again to restore quota": "请重新登录以恢复额度",
    "Local router traffic": "本地路由流量",
    "What do these tags mean?": "这些标签是什么意思？",
    "Hide tag guide": "隐藏标签说明",
    "Show fewer tags": "收起标签",
    "View all %@ tags": "查看全部 %@ 个标签",
    "Hide machine & runtime": "隐藏设备和运行时",
    "Machine & runtime": "设备和运行时",
    "Show fewer quick picks": "收起快速选项",
    "View more quick picks": "查看更多快速选项",
    "Show all": "全部显示",
    "Hide all": "全部隐藏",
    "Update and verify Codex Router": "更新并验证 Codex 路由",
    "Running Codex Router maintenance": "正在维护 Codex 路由",
    "Daily token usage chart. Hover a day for its displayed token count.": "每日 token 用量图表。将鼠标悬停在某天上可查看当前显示的 token 数。",
    "Show %@ usage": "显示 %@ 用量",
    "WEEKLY LEFT": "每周剩余",
    "TODAY TOKENS": "今日 token",
    "DAILY USAGE": "每日用量",
    "LAST 7 DAYS": "过去 7 天",
    "Collapse": "收起",
    "TODAY'S TOKENS": "今日 token",
    "DAILY TOKEN TREND": "每日 token 趋势",
    "ACTIVE NOW": "当前活动",
    "ACTIVE PROVIDER": "当前提供商",
    "USED": "已使用",
    "Account and traffic are provider-scoped": "账户和流量按提供商区分",
    "Live": "实时",
    "Last used": "上次使用",
    "Running chats": "运行中的会话",
    "Router overview": "路由概览",
    "Ready": "就绪",
    "CHATGPT • NATIVE": "CHATGPT · 原生",
    "XAI • OAUTH SESSION": "XAI · OAUTH 会话",
    "XAI • METERED API": "XAI · 计量 API",
    "METERED API": "计量 API",
    "OAUTH ROUTE": "OAUTH 路由",
    "ChatGPT account usage": "ChatGPT 账户用量",
    "Measured by this router": "由此路由测量",
    "Not reported by provider": "提供商未报告",
    "Thinking · %@": "思考中 · %@",
    "ROUTER": "路由",
    "QUOTAS": "额度",
    "Connect a provider to see its quota here.": "连接提供商后可在此查看额度。",
    "DAILY TOKENS": "每日 token",
    "resets soon": "即将重置",
    "Download anyway?": "仍要下载？",
    "local model": "本地模型",
    "none installed": "尚未安装",
    "installed": "已安装",
    "ON THIS MAC": "本机",
    "MODEL": "模型",
    "SIZE": "大小",
    "QUICK PICKS": "快速选项",
    "shortlist for this Mac": "适合本机的精选",
    "CODING": "编程",
    "IMAGE READING": "图像读取",
    "DISCOVER OLLAMA": "发现 Ollama",
    "cloud-only": "仅云端",
    "Size tags choose the model scale. Q4/Q8/BF16 are weight precision; MLX/NVFP4 are hardware-oriented builds; cloud tags run remotely. Codex compatibility is checked only after a pull.": "大小标签表示模型规模。Q4/Q8/BF16 是权重精度，MLX/NVFP4 是面向硬件的构建，云端标签表示远程运行。只有拉取模型后才会检查 Codex 兼容性。",
    "Search family or tag": "搜索系列或标签",
    "INSTALL A MODEL": "安装模型",
    "Ollama tag or URL": "Ollama 标签或 URL",
    "Use a tag or model-page URL. Downloads stay headless.": "输入标签或模型页面 URL。下载会在后台进行。",
    "gemma4:12b or ollama.com/library/gemma4:12b": "gemma4:12b 或 ollama.com/library/gemma4:12b",
    "BEST FIT FOR THIS MAC": "最适合本机",
    "CLOUD ONLY · NO LOCAL DOWNLOAD": "仅云端 · 不下载本地模型",
    "NO LOCAL VARIANT FITS THIS MAC": "没有适配本机的本地变体",
    "managed": "已管理",
    "not started": "未启动",
    "Models:": "模型：",
    "Update Ollama": "更新 Ollama",
    "cloud": "云端",
    "won't fit": "无法适配",
    "cloud only": "仅云端",
    "Anyway": "仍要下载",
    "Default": "默认",
    "Cloud": "云端",
    "Apple Silicon build": "Apple 芯片构建",
    "NVFP4 build": "NVFP4 构建",
    "4-bit build": "4 位构建",
    "8-bit build": "8 位构建",
    "BF16 build": "BF16 构建",
    "Coding build": "编程构建",
    "Specialized build": "专用构建",
    "BEST FIT": "最适合",
    "CLOUD": "云端",
    "DEFAULT": "默认",
    "TIGHT": "内存紧张",
    "WON'T FIT": "无法适配",
    "memory tight": "内存紧张",
    "verified": "已验证",
    "untested": "未测试",
    "accurate": "准确",
    "inaccurate": "不准确",
    "tight": "紧张",
    "too-large": "过大",
    "good": "适合",
    "tags": "标签",
    "fit": "适配",
    "none fit": "无适配项",
    "Local model": "本地模型",
    "Installing": "正在安装",
    "testing…": "测试中…",
    "Actions for %@": "%@ 的操作",
    "speed unmeasured": "速度未测量",
    "vision only — no tools": "仅视觉 — 不支持工具",
    "Downloading": "正在下载",
    "Last download failed": "上次下载失败",
    "ChatGPT subscription": "ChatGPT 订阅",
    "measured on this Mac": "在本机测量",
    "tokens": "token",
    "requests": "请求",
    "All good": "一切正常",
    "Router ready": "路由已就绪",
    "Current limit": "当前限制",
    "Daily limit": "每日限制",
    "Weekly limit": "每周限制",
    "Monthly limit": "每月限制",
    "5-hour limit": "5 小时限制",
    "Hidden from picker — show it below to use it here": "已从选择器隐藏 — 请在下方显示后才能使用",
    "Proven v2": "已验证 v2",
    "Not selected": "未选择",
    "Apply the checked-out router revision, then run the Codex doctor": "应用已检出的路由版本，然后运行 Codex doctor",
    "Run the Codex doctor and repair managed router files": "运行 Codex doctor 并修复受管理的路由文件",
    "Sign in or paste an API key": "登录或粘贴 API 密钥",
    "required": "必填",
    "Checking…": "检查中…",
    "Reading via": "读取引擎",
    "Off — text-only models refuse pasted images": "关闭 — 纯文本模型无法读取粘贴的图像",
    "Daily token usage line chart": "每日 token 用量折线图",
    "agent": "代理",
    "agents": "代理",
    "Active": "活动中",
    "Low": "低",
    "Medium": "中",
    "High": "高",
    "Model provider": "模型提供商",
    "Resets": "重置时间",
    "Menu bar mode": "菜单栏模式",
    "Standard": "标准模式",
    "Icon only": "仅图标",
    "Compact icon only, no model name text": "仅显示紧凑图标，隐藏模型名称文本",
    "Show icon, model name, and usage": "显示图标、模型名称及用量",
    "Show model name": "显示模型名称",
    "Current model or provider is visible in menu bar": "在菜单栏中显示当前模型或提供商名称",
    "Hide model name text in menu bar": "在菜单栏中隐藏模型名称文本",
    "Menu bar icon": "菜单栏图标",
    "Provider icon": "提供商图标",
    "Activity dot": "活动状态点",
    "Preset icon": "预设图标",
    "Custom image": "自定义图片",
    "Choose the icon displayed in the menu bar": "选择菜单栏中显示的图标",
    "Choose Image…": "选择图片…",
    "No custom image selected": "未选择自定义图片",
    "Custom image missing": "自定义图片已丢失",
    "Codex Router · %@ (%@) · %@": "Codex Router · %@ (%@) · %@",
    "Codex Router · %@ (%@)": "Codex Router · %@ (%@)",
    "Capability-driven controls": "按能力驱动的控制",
    "Read-only compatibility status": "只读兼容状态",
    "Router capability update required": "需要更新路由能力",
    "Capability schema %d": "能力架构 %d",
    "Refresh after updating the Router.": "更新路由后刷新。",
    "Quota warning": "配额警告",
    "Enter credential for this one-time operation": "输入本次操作使用的凭据",
    "This operation may consume provider quota. Check the provider plan before continuing.": "此操作可能消耗提供商配额，请先确认套餐。",
    "Confirm and run": "确认并运行",
    "Run": "运行",
    "Confirm this Router operation?": "确认执行此路由操作？",
    "This action may use quota.": "此操作可能使用配额。",
    "The Router will apply this change.": "路由将应用此更改。",
    "Presentation": "展示方式",
    "This presentation preference stays local to the Swift tray.": "此展示偏好仅保存在 Swift 托盘本地。",
    "Menu bar": "菜单栏",
    "Layout": "布局",
    "Show provider name": "显示提供商名称",
    "Active now": "当前活动",
    "Active provider": "当前提供商",
    "Daily usage": "每日用量",
    "Last 7 days": "最近 7 天",
    "Tokens": "Token",
    "Quota": "配额",
    "Stop": "停止",
    "Apply": "应用",
    "Remove": "移除",
    "Delete": "删除",
    "Enable": "启用",
    "Disable": "停用",
    "Failover": "故障转移",
    "Tool-result aging": "工具结果老化",
    "Vision Bridge": "视觉桥接",
    "Presence": "驻留方式",
    "CC Switch": "CC Switch",
    "Native session": "原生会话",
    "Account usage": "账户用量",
    "Provider credentials": "提供商凭据",
    "Provider model state": "提供商模型状态",
    "Protocol proof": "协议验证",
    "Picker and catalog": "选择器与目录",
    "Doctor and update": "诊断与更新",
    "Lifecycle": "生命周期",
    "Confirmation required": "需要确认",
    "Protected input": "受保护输入",
    "Protected output": "受保护输出",
    "Schema version": "架构版本",
    "Health": "健康状态",
    "Version": "版本",
    "Read-only": "只读",
    "Compatible": "兼容",
    "One-time operation": "一次性操作",
    "No credential is stored by the tray.": "托盘不会保存凭据。",
    "Native presentation": "原生展示",
    "Provider": "提供商",
    "Model": "模型",
    "Effort": "推理力度",
    "Selection": "选择",
    "Mode": "模式",
    "Days": "天数",
    "Visible": "可见",
    "Enabled": "已启用",
    "Expired only": "仅过期项",
    "Slug": "标识",
    "Tag": "标签",
    "OpenAI": "OpenAI",
    "DeepSeek": "DeepSeek",
    "Qwen Plan": "Qwen Plan",
    "Catalog": "目录",
    "Logs": "日志",
    "Doctor": "诊断",
    "Maintenance": "维护",
    "Account": "账户",
    "Router command": "路由命令",
    "Command result": "命令结果",
    "Error details": "错误详情",
    "Try again": "重试",
    "The Router is unavailable.": "路由不可用。",
    "Loading": "加载中",
    "Unavailable": "不可用",
    "Installed": "已安装",
    "Configured": "已配置",
    "Hidden": "已隐藏",
    "Visible in picker": "在选择器中可见",
    "Provider plan": "提供商套餐",
    "Quota status": "配额状态",
    "Reset": "重置",
    "Today": "今天",
    "Week": "本周",
    "Month": "本月",
    "Requests": "请求数",
    "Input tokens": "输入 Token",
    "Output tokens": "输出 Token",
    "Total tokens": "总 Token",
    "Success": "成功",
    "Failure": "失败",
    "Retry": "重试",
    "Cancel operation": "取消操作",
    "Operation complete": "操作完成",
    "Operation failed": "操作失败",
    "Read-only status": "只读状态",
    "Settings saved": "设置已保存",
    "Language changed": "语言已更改",
    "Presentation saved": "展示方式已保存",
    "Menu bar saved": "菜单栏设置已保存",
    "Only health and version information is available for this Router capability version.": "此路由能力版本仅提供健康状态和版本信息。",
    "Only health and version information is available until the Router capability snapshot is ready.": "在路由能力快照就绪前仅提供健康状态和版本信息。",
    "Health: %@": "健康状态：%@",
    "Version: %@": "版本：%@",
    "Command failed": "命令失败",
    "Clear command result": "清除命令结果",
    "Copy protected result": "复制受保护结果",
    "capability.lifecycle": "生命周期",
    "capability.doctor": "诊断",
    "capability.maintenance": "维护",
    "capability.native": "原生会话",
    "capability.credential": "提供商凭据",
    "capability.provider": "提供商",
    "capability.model": "模型",
    "capability.protocol-proof": "协议验证",
    "capability.picker": "选择器",
    "capability.catalog": "目录",
    "capability.subagents": "子代理",
    "capability.failover": "故障转移",
    "capability.tool-result-aging": "工具结果老化",
    "capability.usage": "用量",
    "capability.vision": "视觉桥接",
    "capability.presence": "驻留方式",
    "capability.cc-switch": "CC Switch",
    "capability.doctor-update": "诊断与更新",
    "capability.native-session-usage": "原生会话与用量",
    "capability.provider-credentials": "提供商凭据",
    "capability.provider-model-state": "提供商模型状态",
    "capability.picker-catalog": "选择器与目录",
    "field.provider": "提供商",
    "field.slug": "模型标识",
    "field.enabled": "启用",
    "field.visible": "可见",
    "field.engine": "引擎",
    "field.effort": "推理力度",
    "field.tag": "标签",
    "field.days": "天数",
    "field.mode": "模式",
    "field.selection": "选择",
    "field.expiredOnly": "仅过期项",
    "Select": "选择",
  ]
}
