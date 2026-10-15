# DSH OpenAI Subscription

在 DSH 中使用 ChatGPT/Codex 订阅模型，并查看 5 小时、每周额度与使用官方额度重置卡。插件版本 `0.1.0`，兼容基线为 DSH `0.2.0-rc.2`，需要 Node.js 24.2 或以上版本。

## 安装

在本项目目录构建并打包：

```powershell
npm ci
npm run build
npm pack
```

用 DSH 的插件管理命令安装生成的包，然后重启相应 profile：

```powershell
dsh plugin --profile web add D:/27247/Desktop/dsh-local_pluying/dsh-openai-subscription-0.1.0.tgz --ignore-scripts
dsh web
```

桌面版使用其随附的 DSH CLI 与 `desktop` profile。安装包只在本地生成，尚未发布到 npm；不要把此包名当作已发布的 npm 包安装。预览版 DSH 接口仍在变化，本版不保证其他版本兼容。

包内已经包含构建产物，安装时无需运行依赖脚本。上述 `--ignore-scripts` 可避免 pnpm 11 的未批准构建脚本错误；随附 Codex 可执行文件由平台依赖包提供。若曾安装失败，DSH 可能保留依赖但未启用插件：在插件管理中启用本插件，或确认目标 profile 的 `package.json` 中 `dsh.profile.bundles` 包含 `dsh-openai-subscription`，然后重启。

## 使用

1. 打开 DSH **设置 → OpenAI 订阅**，点击登录并在官方登录页面完成授权。
2. 在会话模型选择器选择 **OpenAI（ChatGPT 订阅）**，路由 ID 为 `openai-subscription`。模型及推理强度来自固定版本 Pi AI 的 Codex 模型目录，实际可用性由账号服务决定。
3. 设置页展示服务实际返回的额度桶。只有 `windowDurationMins=300` 才显示 5 小时，`10080` 才显示每周；没有对应窗口时不显示。百分比为已用/剩余比例，重置时间按本地时区展示。
4. 选择可用重置卡后先查看确认内容，确认才会调用重置接口。服务决定哪些窗口符合重置条件。超时或连接中断时显示结果待确认，只能用原操作 ID 重试；不会自动改用另一张卡。

额度默认每 60 秒读取，在模型请求结束、服务额度通知和手动刷新时也会更新。通知可能只包含部分字段，因此通知触发完整读取。读取失败保留旧值并标记过期，不把未知额度显示为零或无限量。重置卡数量未知与确认为零分别显示。

## 账号与配置

插件运行独立的 Codex App Server，只管理登录、额度和重置卡；模型调用复用 DSH 的 Pi AI 适配器、会话历史、图片处理、原生工具及审批流程。模型使用 Codex Responses/SSE，避免跨账号沿用缓存的 WebSocket 会话。

设置操作通过 DSH Connection 的精确 `/api/openai-subscription/*` 路由，沿用 Host/Origin 检查、浏览器认证和原生请求格式，与本体 Gateway 共存；插件请求体另限 16 KiB。

登录保存在 `$DSH_HOME/openai-subscription`（未指定 `DSH_HOME` 时为 `~/.dsh/openai-subscription`）。这里的 `auth.json` 是 Codex 自身的文件凭据缓存，包含敏感登录信息，且不是额外加密的存储；插件不会读取用户原有的 `~/.codex` 登录。缓存内容只在 Host 内用于同一订阅账号的模型请求，不发送给浏览器或写入项目仓库。它的内部格式属于兼容性依赖，格式不符或账号标识不一致时拒绝调用。

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
npm run typecheck
npm run build
```

本地模拟测试、运行环境与截图放在 Git 忽略的 `.local/` 中，不随 npm 包交付。当前验证结论与真实账号验证缺口见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 登录与凭据缓存](https://learn.chatgpt.com/docs/auth)、[DSH 官方源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2)。
