# DSH 本体补丁

`dsh-0.2.0-rc.2-reasoning-usage.patch` 针对官方 `dsh-v0.2.0-rc.2`，基线提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。版本为 **0.2.0-rc.2 → 0.2.0-rc.2 + 本地补丁**；这不是上游发布。

补丁修复 `llm-pi-ai` 丢失推理 token 明细的问题。OpenAI Responses 与 Chat Completions 的推理用量经 pi-ai 的 `usage.reasoning` 映射至 DSH 已有的 `reasoningTokens`，供轮次用量统计与界面显示。显式零值保留，未报告时不生成字段，输出 token 和总 token 不重复累加。补丁同时更新该包的英文、中文 README 和对应配对记录。

在目标 DSH 源码目录确认版本与已有改动后，使用补丁的绝对路径执行：

```powershell
git rev-parse HEAD
git status --short
git apply --check D:/27247/Desktop/dsh-local_pluying/patches/dsh-0.2.0-rc.2-reasoning-usage.patch
git apply D:/27247/Desktop/dsh-local_pluying/patches/dsh-0.2.0-rc.2-reasoning-usage.patch
git diff --check
```

本地验证：4 项针对实际 `mapUsage` 源码的检查通过，覆盖有值、零值、缺失及输出/总量不重复计数；补丁可在基线文件上应用，`git diff --check` 通过。测试保存在本项目已忽略的 `.local/tests/core-usage.test.ts`，在项目目录运行 `node --test .local/tests/core-usage.test.ts`。补丁本身不包含测试材料。

未运行上游完整构建、完整测试或真实模型调用。当前参考检出为稀疏检出，未安装上游工作区依赖；文档只核对了本次段落的中英对应、结构与配对哈希，未宣称通过完整 `doc-sync`。应用补丁后需按目标 DSH 源码的构建流程重新生成并使用本地运行产物；安装订阅插件不会自动修改已安装的 DSH 本体。

协议依据：[OpenAI 推理模型用量说明](https://developers.openai.com/api/docs/guides/reasoning)。pi-ai `0.87.1` 的 Responses 适配器已从 `output_tokens_details.reasoning_tokens` 提取推理用量；本补丁补齐 DSH 的字段传递。
