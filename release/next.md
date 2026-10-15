# Deyo Skill 来源与合集规则

- 明确支持 18 个命名平台，以及 HTTP/HTTPS 通用媒体链接和单文件上传，共 20 类来源；微信视频号遵循独立功能开关。
- 红果整剧、抖店多课时和网页多媒体候选必须先选择一项，不默认选择或批量转写；红果选集失败可返回目录，过期候选需重新解析。
- 播放列表、节目、专辑和合集仅展示真实摘要并引导具体单集，抖音与小红书作者页引导具体作品；带 list 的 YouTube 具体视频仍按单视频处理。
- 明确摘要型合集的 HTTP 422、`UNSUPPORTED_CONTENT` 与 `mode`，保留旧 `COLLECTION_UNSUPPORTED` 读取兼容；多媒体候选使用 `MULTIPLE_MEDIA_SELECTION_REQUIRED`，红果目录使用 `HONGGUO_EPISODE_REQUIRED`，其 `parseToken` 不得跨用户使用。
- 付费或受限内容先分类；摘要、未选目录和不可转写内容不得复用任务、扣分钟或创建任务。缺失封面不阻断流程，未知集数与零条结果明确区分。

- 区分发布审核恢复提示：精确终态安全拒绝引导 `make fix-forward` 完整预检；等待或网络失败继续同版本 resume，证据冲突停止检查。
- CLI 缺失、过旧或缺少流式能力时先说明全局安装命令，仅在明确授权后执行；统一插件回退入口的授权规则。

- 扩展受控 fix-forward：修复提交已同步远端时仍完整校验失败版本证据，私有归档后正常发布下一 patch；保留原恢复路径兼容。

- Install the latest npm CLI with `npm install -g @casatwy/deyo@latest`; preserve the manifest minimum compatibility requirement.
- Ordinary publish automatically reconciles retained release evidence and immutable artifacts.
