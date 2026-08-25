# 🔥 GitHub Trending 每日 QQ 推送

每天由 GitHub Actions 自动抓取 GitHub Trending，排除最近 30 天已经推荐过的项目，只把新项目推送到 QQ 私聊，同时将完整榜单保存为 Obsidian Markdown。

## 功能

- 📊 抓取 GitHub Trending 完整日榜
- 🧹 按规范化后的 `owner/repo` 做 30 天滚动去重
- 🤖 使用 Gemini 生成中文项目说明，失败时自动降级到机器翻译或原文
- 📱 通过 QQ 开放平台官方机器人推送到手机 QQ
- 🗂️ 每天保存完整 Obsidian 榜单，并标记“已推送”或“重复未推送”
- 🔒 QQ OpenID 和去重状态仅保存在私有 Vault 仓库
- ⏰ GitHub Actions 每天北京时间 12:17 自动执行（避开整点拥堵）
- 🧩 保留 PushPlus 作为可选兼容通道

## 数据流

```text
GitHub Actions
  ├─ 抓取当天完整榜单
  ├─ 读取 Vault 中的最近推送状态
  ├─ 只处理并推送新项目
  └─ 将完整日榜提交到 Vault 私库
```

Vault 仓库中的文件结构：

```text
├─ .github-trending/
│  ├─ qq-target.json     # 已绑定的 QQ OpenID（私库）
│  └─ state.json         # 去重状态和历史中文说明
└─ 2026/
   ├─ 2026-07-25.md
   └─ 2026-07-26.md
```

## 1. 配置 QQ 机器人

在 [QQ 开放平台](https://q.qq.com/) 打开已经创建的机器人，取得 `AppID` 和 `AppSecret`。`AppSecret` 不要写入代码或聊天记录。

在推送项目 `Big-Light/github-trending-push` 的 **Settings → Secrets and variables → Actions** 中创建：

| Secret | 用途 |
|---|---|
| `QQ_BOT_APP_ID` | QQ 机器人 AppID |
| `QQ_BOT_APP_SECRET` | QQ 机器人 AppSecret |
| `OBSIDIAN_REPO_TOKEN` | 只允许读写 Vault 私库的细粒度 Token |
| `GEMINI_API_KEY` | 可选，用于 AI 中文总结 |

`OBSIDIAN_REPO_TOKEN` 建议使用 fine-grained personal access token，只授权 `Big-Light/github-trending-obsidian`，Repository permissions 中仅开启 **Contents: Read and write**。

## 2. 首次绑定手机 QQ

1. 打开推送项目的 **Actions**。
2. 选择 **绑定 QQ 机器人私聊**，点击 **Run workflow**。
3. 等待日志出现“请在手机 QQ 中向机器人发送”。
4. 在 3 分钟内向机器人发送：`绑定 GitHub Trending`。
5. 机器人回复绑定成功后，OpenID 会写入 Vault 私库的 `.github-trending/qq-target.json`。

完整 OpenID 不会打印到公开 Actions 日志。

## 3. 测试每日任务

在 Actions 中选择 **每日 GitHub Trending 推送**，手动运行一次。首次运行时，最近 30 天没有历史记录，因此当天榜单都会被视为新项目。

随后检查：

- 手机 QQ 是否收到新项目消息；
- Vault 私库是否出现 `YYYY/YYYY-MM-DD.md`；
- `.github-trending/state.json` 是否生成；
- 重复手动运行时，QQ 是否只收到“今日暂无新上榜项目”。

定时私聊使用 QQ 的普通主动消息，不占用互动召回额度。请在手机 QQ 的机器人会话设置中开启 **允许主动发送**；关闭后 QQ 会拒绝每日榜单。主动消息仍受开放平台频率和风控约束，详细规则见 [QQ 开放平台消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)。

## 本地运行

```bash
npm install

# 只预览，不推送、不更新去重状态
node src/index.js --dry-run
```

如果需要在本地真实推送，设置：

```text
QQ_BOT_APP_ID
QQ_BOT_APP_SECRET
QQ_BOT_TARGET_OPENID
TRENDING_ARCHIVE_DIR
```

GitHub Actions 使用私有 Vault 中的绑定文件，因此不需要配置 `QQ_BOT_TARGET_OPENID`。

## 可调参数

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `DEDUP_DAYS` | `30` | 去重窗口天数 |
| `QQ_CONTENT_LIMIT` | `1800` | 单条 QQ 文本安全长度 |
| `DESCRIPTION_CHAR_LIMIT` | `220` | 项目说明展示长度 |
| `TRENDING_ARCHIVE_DIR` | 无 | Vault 私库在运行器中的路径 |

## 测试

```bash
npm test
```
