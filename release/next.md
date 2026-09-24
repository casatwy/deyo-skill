# Deyo Skill source boundaries and Bilibili trial consent

- Add explicit source boundaries for TikTok, Kankanews, and WeChat Channels, including the exact Kankanews hostname rule and canonical-page-only handling.
- Guide Apple Podcasts shows, Xiaoyuzhou podcasts, and Bilibili Bangumi or UGC collections from their pre-billing HTTP 422 response to one concrete episode or video without retrying the whole set.
- Require the user's own interactive confirmation for a Bilibili trial segment after showing full duration, transcribable duration, expected minute deduction, and the trial-only warning; bill only the transcribable duration.
- Remove local-file hash and upload-hashing event semantics: file selection now proceeds directly to `upload.started`, while signed URLs and part ETags remain private.

- 新增明确输入清单的顺序转写编排，完整正文与助手总结分开保存；本地 manifest 支持保守恢复，未知任务不重新提交。
- 保留 Instagram 支持；CLI 仍为单输入，不增加后台队列、自动重试或充值。
