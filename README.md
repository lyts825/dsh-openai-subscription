# DSH OpenAI Subscription

在 DSH 中使用 ChatGPT/Codex 订阅模型，查看 5 小时、每周额度与使用官方额度重置卡，并让主代理将子任务分配给 DS 或 GPT。插件版本 `0.4.0-rc.1`，兼容基线为 DSH `0.2.0-rc.2`，支持官方 Desktop 和 DSH NEXT `2.0.17-next`。开发和独立 Web 运行需要 Node.js 24.2 或以上版本；桌面版使用应用自带运行时。

这是预发布候选：本地与隔离 Host 验证已通过，真实账号、模型调用和重置卡消费仍待验收。完整验证边界见 [项目状态](PROJECT_STATUS.md)。

## 安装

从 [GitHub 预发布页](https://github.com/lyts825/dsh-openai-subscription/releases/tag/v0.4.0-rc.1) 下载桌面 ZIP 或 Web 使用的 `.tgz`。桌面用户按 [Desktop / NEXT 安装说明](desktop/README.zh.md) 操作；官方桌面版使用随附 DSH CLI 与 `desktop` profile，NEXT 使用自己的包管理入口。

Web 用户在下载目录执行，然后重启相应 profile：

```powershell
$plugin = (Resolve-Path '.\dsh-openai-subscription-0.4.0-rc.1.tgz').Path
dsh plugin --profile web add $plugin --ignore-scripts
dsh web
```

安装包通过 GitHub Releases 提供，未发布到 npm；不要把此包名当作已发布的 npm 包安装。预览版 DSH 接口仍在变化，本版不保证其他版本兼容。

包内已经包含构建产物，安装时无需运行依赖脚本。上述 `--ignore-scripts` 可避免 pnpm 11 的未批准构建脚本错误；随附 Codex 可执行文件由平台依赖包提供。若曾安装失败，DSH 可能保留依赖但未启用插件：在插件管理中启用本插件，或确认目标 profile 的 `package.json` 中 `dsh.profile.bundles` 包含 `dsh-openai-subscription`，然后重启。

## 使用

1. 打开 DSH **设置 → OpenAI 订阅**，点击登录并在官方登录页面完成授权。
2. 在会话模型选择器选择 **OpenAI（ChatGPT 订阅）**，路由 ID 为 `openai-subscription`。模型、默认推荐、输入能力与推理强度来自 Codex App Server 的 `model/list`，不再固定为 Pi AI 内置列表。
3. 设置页展示服务实际返回的额度桶。只有 `windowDurationMins=300` 才显示 5 小时，`10080` 才显示每周；没有对应窗口时不显示。百分比为已用/剩余比例，重置时间按本地时区展示。
4. 选择可用重置卡后先查看确认内容，确认才会调用重置接口。服务决定哪些窗口符合重置条件。超时或连接中断时显示结果待确认，只能用原操作 ID 重试；不会自动改用另一张卡。

额度默认每 60 秒读取，在模型请求结束、服务额度通知和手动刷新时也会更新。通知可能只包含部分字段，因此通知触发完整读取。读取失败保留旧值并标记过期，不把未知额度显示为零或无限量。重置卡数量未知与确认为零分别显示。

**设置 → OpenAI 订阅 → 模型目录** 可以搜索模型并手动同步，查看默认推荐与官方替代建议。插件首次读取时加载目录，之后随额度轮询最多每 15 分钟重新读取；目录变更通知 DSH 主选择器刷新。同步失败保留上次目录并提示过期，账户切换清空旧目录。Codex 可能返回其缓存或内置目录；“同步时间”是插件读取时间，不证明每次都从网络获取，模型是否可调用仍由账号权限与服务端决定。

新模型可以直接进入目录，无需等待 Pi AI 更新模型名单；推理档位按目录原值发送，未知上下文容量不显示为已知数值。隐藏或当前文本适配器不支持的模型不会进入候选列表。已保存但从目录移除的模型会标记不可用，需自行重新选择，不自动切换模型。

## DS / GPT 子代理分配

在 **设置 → 子代理分配** 启用此功能，选择模式和具体模型后保存，再新建对话。模型候选来自当前 DSH 已配置的提供方；先在 DSH 完成所需的 DS / GPT 账号或 API 配置。GPT 可以选本插件的订阅路由，也可以选 DSH 中已有的 GPT 路由。模型出现在目录中不代表已登录、有余额或已取得调用权限。

DS 与 GPT 可分别按名称、ID 或提供方搜索，列表按提供方分组。刷新会同步订阅目录并重新读取 DSH 的模型候选，保留未保存草稿和现有选择。DeepSeek 目录由对应 DSH 提供方管理，本插件不会复制其凭据或虚构可用模型。

| 模式 | 设置 | 运行方式 |
| --- | --- | --- |
| 自动分配 | 分别选择一个 DS、一个 GPT 的提供方与模型 | 主代理根据任务调用 `delegate_to_deepseek` 或 `delegate_to_gpt` |
| 手动指定 | 选择 DS 或 GPT，再指定该类的提供方与模型 | 只开放指定的子代理工具；执行时拒绝覆盖模型 |

例如用 GPT 作为主模型，自动模式可让它把检索整理任务分配给 DS、把其他任务分配给 GPT；手动选 DS 后，新建子代理固定使用指定的 DS 模型。“自动”指主模型决定分工，不按额度或价格自动切换。所选模型不可用时返回错误，不静默回退。

功能默认关闭。保存后的设置对新对话生效；对话创建时保存一份分配设置，恢复对话或热加载插件后继续使用这份设置，已有子代理保持创建时的模型。启用插件前的旧对话保持原行为。设置适用于新对话，无论主模型是 DS 还是 GPT；子代理继承同一分配设置和 DSH 的深度限制。

子任务使用 DSH 原生 `spawn` 子会话与可继续的后台任务，沿用权限、审批、任务结果收集和取消。启用分配的对话会禁用本体其他新建子代理入口（包括原 `subagent*`、workflow、Ralph 和 Agent Team 的 `spawn_teammate`），避免绕过手动指定；已有子代理的查看、发消息和中断操作仍可用。安装其他第三方创建子会话的工具不在本版路由保证范围内。

分配默认设置保存在当前插件数据目录的 `dsh-delegation-settings.json`，会话快照保存在 DSH 原生存储域。设置页并发保存发生冲突时需刷新后重新保存；损坏的配置不会被静默覆盖。分配文件只存提供方及模型 ID，不复制 DS 或 GPT 凭据。

## 账号与配置

插件运行独立的 Codex App Server，管理登录、模型目录、额度和重置卡；模型调用复用 DSH 的 Pi AI 适配器、会话历史、图片处理、原生工具及审批流程。模型使用 Codex Responses/SSE，避免跨账号沿用缓存的 WebSocket 会话。

设置操作通过 DSH Connection 的精确 `/api/openai-subscription/*` 路由，沿用 Host/Origin 检查、浏览器认证和原生请求格式，与本体 Gateway 共存；插件请求体另限 16 KiB。

Desktop、NEXT 和自定义 profile 的登录保存在实际 profile 目录下的 `openai-subscription`；普通默认 Web profile 保留 `$DSH_HOME/openai-subscription`（未指定 Home 时为 `~/.dsh/openai-subscription`）。显式 `dataDirectory` 优先；不能取得可靠 profile 信息时沿用旧 Home 路径。不会迁移或自动复用其他 profile 的凭据。

这里的 `auth.json` 是 Codex 自身的文件凭据缓存，包含敏感登录信息，且不是额外加密的存储；插件不会读取用户原有的 `~/.codex` 登录。缓存内容只在 Host 内用于同一订阅账号的模型请求，不发送给浏览器或写入项目仓库。它的内部格式属于兼容性依赖，格式不符或账号标识不一致时拒绝调用。

插件随附固定版本 `@openai/codex@0.162.1`。以下配置可合并到目标 profile 的 `cordis.patch.yml`；保留用户已有条目：

```yaml
- id: openai-subscription
  config:
    pollIntervalMs: 60000
    requestTimeoutMs: 30000
    streamIdleTimeoutMs: 120000
    # 多个独立 Host 使用不同的绝对目录：
    # dataDirectory: D:/dsh-data/openai-subscription
    # 如需替换随附版本，指定原生可执行文件绝对路径：
    # codexPath: C:/tools/codex.exe
```

重置日志与账号绑定并持久保存幂等键。未确认结果的操作需要先重试确认，才能更换账号。不会在模型限额耗尽时自动使用重置卡。

## DSH 本体优化

[本体补丁与应用说明](patches/README.md) 修复 GPT 推理 token 明细在 `llm-pi-ai` 中丢失的问题，保留零值、不重复累加总 token。补丁基于官方提交 `639ed015397290b3745d163aafe02ffee4aa3f84`，需在对应本体源码应用并重建。订阅插件安装不会自动改写其他已安装包。

## 开发与验证

```powershell
npm ci
npm run typecheck
npm pack
# Windows 桌面 ZIP（包含构建、安装脚本和包哈希清单）：
npm run package:desktop
```

`npm pack` 的 prepack 会构建 Host、Client 和类型声明。版本与 Git 标签按 `MAJOR.MINOR.PATCH` 管理；尚待真实账号验收的版本使用 `-rc.N` 后缀及 GitHub Pre-release 标记。生成的安装包不进入源码 Git，随 Release 附件分发。

本地模拟测试、运行环境与截图放在 Git 忽略的 `.local/` 中，不随 npm 包交付。当前验证结论与真实账号验证缺口见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 登录与凭据缓存](https://learn.chatgpt.com/docs/auth)、[DSH 官方源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2)。
