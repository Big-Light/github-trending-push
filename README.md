# 🔥 GitHub Trending 每日推送

每天自动爬取 [GitHub Trending](https://github.com/trending)，将热门开源项目推送到微信。

## 功能

- 📊 自动爬取 GitHub Trending 页面
- 📝 提取项目名、描述、编程语言、Star/Fork 数
- 🎨 格式化为美观的 HTML 卡片
- 📱 通过 PushPlus 推送到微信
- ⏰ GitHub Actions 每日定时执行（北京时间 9:00）
- 🖱️ 支持手动触发

## 快速开始

### 1. 配置 PushPlus

1. 访问 [pushplus.plus](https://www.pushplus.plus/)
2. 微信扫码登录
3. 从个人中心复制 Token

### 2. 配置 GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Name | Value |
|------|-------|
| `PUSHPLUS_TOKEN` | 你的 PushPlus Token |

### 3. 手动测试

在仓库的 **Actions** 标签页，选择工作流，点击 **Run workflow** 手动触发一次。

## 本地运行

```bash
# 安装依赖
npm install

# 仅预览，不推送
node src/index.js --dry-run

# 实际推送（需要设置环境变量）
# Windows
set PUSHPLUS_TOKEN=你的token
node src/index.js

# Linux/Mac
export PUSHPLUS_TOKEN=你的token
node src/index.js
```

## 项目结构

```
├── .github/workflows/
│   └── daily-trending.yml   # GitHub Actions 定时任务
├── src/
│   └── index.js             # 主脚本
├── package.json
└── README.md
```
