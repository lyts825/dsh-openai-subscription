# DSH Desktop / DSH NEXT 安装说明

这是 `dsh-openai-subscription 0.2.0` 桌面插件包，ZIP 内含已构建的 npm 包、Windows 安装脚本和 SHA-256 清单；不包含 DSH 应用安装程序。

## 适配目标

| 应用 | 兼容版本 | 配置 |
| --- | --- | --- |
| 官方 DeepSeek Harness Desktop | DSH `0.2.0-rc.2` | `desktop` profile |
| DSH NEXT | `2.0.17-next`，内置 DSH `0.2.0-rc.2` | 默认 `desktop` 或应用已有的自定义 profile |

两者均使用桌面应用自带的运行时和包管理器。终端用户无需额外安装 Node.js、npm 或 pnpm。其他版本暂未验证，脚本会拒绝安装。

## 安装

1. 解压整个 ZIP，保持四个文件位于同一目录。先启动目标应用一次，确认已有 profile，然后退出应用（包括托盘）。安装脚本不会中断运行中的会话。
2. 确认目标应用实际使用的 **DSH Home** 绝对路径；它下面应已有 `profiles/desktop/package.json`（自定义 profile 使用其名称）。默认通常是 `%USERPROFILE%\.dsh`，设置了 `DSH_HOME` 或在 NEXT 中迁移过数据目录时使用实际位置；NEXT 内置终端启动信息中的 `Harness home` 可帮助核对。不要将应用安装目录或插件解压目录误填为 DSH Home。两个应用可以使用不同的 Home。
3. 在解压目录打开 PowerShell，先检查参数，再执行安装。以下路径只是示例，请替换为本机实际路径。

DSH NEXT：

```powershell
.\Install-Plugin.ps1 -Target next -ApplicationDirectory 'D:\dsh\DSH NEXT' -DshHome 'D:\my-dsh-home' -ValidateOnly
.\Install-Plugin.ps1 -Target next -ApplicationDirectory 'D:\dsh\DSH NEXT' -DshHome 'D:\my-dsh-home'
```

官方 Desktop：

```powershell
.\Install-Plugin.ps1 -Target official -ApplicationDirectory 'C:\Users\your-name\AppData\Local\Programs\DeepSeek Harness' -DshHome 'D:\my-dsh-home' -ValidateOnly
.\Install-Plugin.ps1 -Target official -ApplicationDirectory 'C:\Users\your-name\AppData\Local\Programs\DeepSeek Harness' -DshHome 'D:\my-dsh-home'
```

NEXT 自定义 profile 追加 `-Profile your-profile`。`-ValidateOnly` 只检查包哈希、应用版本、profile 和运行状态，不安装或改变 profile；应用运行中也会拒绝，须先完全退出。脚本不会创建 profile、修改全局环境变量或自动停止应用；执行时临时设置的环境变量会恢复。

如果系统策略禁止运行 PowerShell 脚本，可使用应用的插件管理功能安装解压得到的 `.tgz` 本地包，启用 `dsh-openai-subscription` 后重启。使用 CLI 时应使用相应桌面应用自带的 CLI，并添加 `--ignore-scripts`；不要用独立安装的 npm DSH 管理官方 Desktop 保留的 profile。

4. 重开应用，在 **设置 → OpenAI 订阅** 登录。授权链接使用系统浏览器；如无法自动打开，可点击复制登录链接。登录完成后回到应用刷新。
5. 模型选择器中选择 **OpenAI（ChatGPT 订阅）**。目录由固定版本适配器提供，实际模型权限取决于账号。

## 桌面行为与数据

- Desktop 和 NEXT 使用相同的原生设置入口与 Host 认证通道；插件声明 `platform: web` 是两种桌面渲染器的正式加载协议。
- 默认将独立 Codex 登录、重置记录和进程锁放在当前 profile 的 `openai-subscription` 子目录；不同 profile 互不复用账号。显式配置的 `dataDirectory` 优先。不会迁移旧凭据或读取 `~/.codex`。
- 默认 Web profile 的旧 `DSH_HOME/openai-subscription` 路径保持兼容；桌面升级后如果此前使用旧共享路径，需要重新登录，或主动配置原有绝对 `dataDirectory`。
- 同一 Home、同一 profile 在两个应用间共享时会使用同一个账号目录；不要同时运行这两个 Host，生命周期锁会阻止并发使用。需要独立账号时选择独立 Home/profile。
- 仅显示服务返回的 300 分钟 / 10080 分钟额度窗口；没有 5 小时限制时不显示 5 小时条目。读取失败显示过期状态，保留上次数据。
- 使用重置卡必须先查看并确认。超时后只重试原操作 ID；不会自动消费其他卡。确认窗口支持 Esc、Tab 和关闭后的焦点恢复。

登录缓存 `auth.json` 包含敏感凭据，由 Codex 写入本地文件，未额外加密。备份和分享时不要包含账号目录。

## GPT 本体补丁与验收边界

插件继续复用 DSH 原生 Pi AI 适配器、工具、审批和会话回放。npm 包的 `patches/` 目录另含官方 `0.2.0-rc.2` GPT 推理 token 用量修复补丁；必须在对应源码应用并重建，安装插件不会修改现有应用。本体补丁不能仅凭 NEXT 内核版本相同就直接覆盖其已构建文件。

本次先交付本地安装包，真实账号稍后验收。未完成真实订阅调用或重置卡消费，不代表已登录、已部署到用户 profile 或已发布到 npm。详细验证结论见 npm 包内 `PROJECT_STATUS.md`。
