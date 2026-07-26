const axios = require('axios');
const cheerio = require('cheerio');
const path = require('node:path');
const translate = require('google-translate-api-x');
const {
  classifyRepos,
  formatDateKey,
  loadArchiveState,
  loadQQTarget,
  saveArchiveState,
  saveDailyArchive,
  updateStateAfterSuccessfulPush,
} = require('./archive');
const { buildQQMessages, pushToQQ } = require('./qq');

let GoogleGenAI = null;
try {
  ({ GoogleGenAI } = require('@google/genai'));
} catch (err) {
  // 本地未安装依赖时仍允许测试和翻译兜底运行；GitHub Actions 会通过 npm install 安装。
}

const ai = GoogleGenAI && process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

// ============================================================
//  配置
// ============================================================
const GITHUB_TRENDING_URL = 'https://github.com/trending';
const PUSHPLUS_API = 'http://www.pushplus.plus/send';
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;
const PUSHPLUS_CONTENT_LIMIT = Number.parseInt(process.env.PUSHPLUS_CONTENT_LIMIT || '19000', 10);
const DESCRIPTION_CHAR_LIMIT = Number.parseInt(process.env.DESCRIPTION_CHAR_LIMIT || '220', 10);
let geminiQuotaExhausted = false;

function formatDate() {
  return new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateText(text, maxLength = DESCRIPTION_CHAR_LIMIT) {
  const cleanText = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleanText);
  if (chars.length <= maxLength) return cleanText;
  return `${chars.slice(0, Math.max(0, maxLength - 1)).join('').trimEnd()}…`;
}

function getErrorMessage(err) {
  return String(err?.message || err || '');
}

function isGeminiQuotaError(err) {
  const message = getErrorMessage(err).toLowerCase();
  return (
    message.includes('resource_exhausted') ||
    message.includes('generate_requests_per_day') ||
    message.includes('generaterequestsperday') ||
    message.includes('current quota') ||
    message.includes('quota exceeded')
  );
}

function isGeminiRateLimitError(err) {
  const message = getErrorMessage(err).toLowerCase();
  return message.includes('429') || message.includes('quota') || message.includes('rate');
}

function resetGeminiQuotaState() {
  geminiQuotaExhausted = false;
}

// ============================================================
//  1. 爬取 GitHub Trending
// ============================================================
async function scrapeTrending() {
  console.log('🔍 正在爬取 GitHub Trending ...');

  const { data: html } = await axios.get(GITHUB_TRENDING_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    timeout: 30000,
  });

  const $ = cheerio.load(html);
  const repos = [];

  $('article.Box-row').each((i, el) => {
    const $el = $(el);

    // 项目名 (owner/repo)
    const rawName = $el.find('h2 a').text().trim().replace(/\s+/g, '');
    // 提取 href 作为链接
    const href = $el.find('h2 a').attr('href') || '';
    const repoUrl = href ? `https://github.com${href}` : '';

    // 项目描述
    const description = $el.find('p').text().trim() || '暂无描述';

    // 编程语言
    const language = $el.find('[itemprop="programmingLanguage"]').text().trim() || '';

    // Star 总数
    const starsText = $el.find('a[href$="/stargazers"]').text().trim().replace(/,/g, '');
    const stars = starsText || '0';

    // Fork 总数
    const forksText = $el.find('a[href$="/forks"]').text().trim().replace(/,/g, '');
    const forks = forksText || '0';

    // 今日新增 Star
    const todayStars =
      $el.find('span.d-inline-block.float-sm-right').text().trim() ||
      $el.find('span:last-child').text().trim().match(/[\d,]+ stars/)?.[0] ||
      '';

    repos.push({
      rank: i + 1,
      name: rawName,
      url: repoUrl,
      description,
      language,
      stars,
      forks,
      todayStars,
    });
  });

  console.log(`✅ 成功爬取 ${repos.length} 个项目`);
  return repos;
}

// ============================================================
//  2. AI 总结并翻译描述
// ============================================================
async function fetchReadmeSnippet(repoUrl) {
  try {
    // 转换 url: https://github.com/owner/repo -> https://raw.githubusercontent.com/owner/repo/HEAD/README.md
    const rawUrl = repoUrl.replace('github.com', 'raw.githubusercontent.com') + '/HEAD/README.md';
    const res = await axios.get(rawUrl, { timeout: 10000 });
    return res.data.substring(0, 1500);
  } catch (err) {
    // 如果没有 README 或请求失败，返回空字符串
    return '';
  }
}

async function generateAISummary(about, readmeSnippet, repoName, options = {}) {
  if (geminiQuotaExhausted) {
    return null;
  }

  const aiClient = options.aiClient || ai;
  const sleepFn = options.sleepFn || sleep;
  if (!aiClient) {
    console.warn(`  ⚠️ Gemini SDK 不可用，跳过 AI 总结 (${repoName})。`);
    return null;
  }

  const prompt = `你是一位技术项目分析师。根据以下 GitHub 项目信息，用中文写一段简洁的项目说明（2-3句话）。

要求：
1. 第一句话说明项目是什么、核心功能。
2. 第二句话说明对个人开发者或普通用户可能有什么实际用途。
3. 语言通俗易懂，避免生硬翻译腔。
4. 只基于提供的信息总结，不要编造功能。

项目名称：${repoName}
项目简介（About）：${about}
README 片段：
${readmeSnippet || '无'}`;

  // 最多重试 2 次（首次 + 1次重试）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      return response.text.trim();
    } catch (err) {
      if (isGeminiQuotaError(err)) {
        geminiQuotaExhausted = true;
        console.warn(`  ⚠️ Gemini 免费额度已耗尽，后续项目跳过 AI 总结 (${repoName})。`);
        return null;
      }

      if (isGeminiRateLimitError(err) && attempt < 2) {
        console.warn(`  ⏳ Gemini 速率限制，等待 20 秒后重试 (${repoName})...`);
        await sleepFn(20000);
        continue;
      }
      console.warn(`  ⚠️ 项目 ${repoName} AI 总结失败: ${getErrorMessage(err)}`);
      return null;
    }
  }
  return null;
}

async function translateFallback(text) {
  try {
    const result = await translate(text, { from: 'en', to: 'zh-CN' });
    return result.text;
  } catch (err) {
    return null;
  }
}

async function enrichDescriptions(repos, options = {}) {
  console.log('🌐 正在处理项目描述（AI 总结 → 机器翻译 → 原文）...');

  const hasGemini = options.hasGemini ?? !!process.env.GEMINI_API_KEY;
  const fetchSnippet = options.fetchSnippet || fetchReadmeSnippet;
  const generateSummary = options.generateSummary || generateAISummary;
  const translateText = options.translateText || translateFallback;
  const sleepFn = options.sleepFn || sleep;

  if (!hasGemini) {
    console.warn('⚠️ 未设置 GEMINI_API_KEY，跳过 AI 总结，将使用机器翻译兜底。');
  }

  let aiCount = 0, translateCount = 0, originalCount = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    console.log(`  [${i + 1}/${repos.length}] 处理 ${repo.name}...`);

    // ── 第一层：Gemini AI 总结 ──
    if (hasGemini && !geminiQuotaExhausted) {
      const readmeSnippet = await fetchSnippet(repo.url);
      const summary = await generateSummary(repo.description, readmeSnippet, repo.name, { sleepFn });
      if (summary) {
        repo.description = summary;
        repo.descSource = 'ai';
        aiCount++;
        // Gemini 免费版限制 10 RPM，每次请求间隔 6.5 秒确保不超限
        if (i < repos.length - 1) await sleepFn(6500);
        continue;
      }
    }

    // ── 第二层：Google Translate 翻译兜底 ──
    const translated = await translateText(repo.description);
    if (translated) {
      repo.description = translated;
      repo.descSource = 'translate';
      translateCount++;
      if (i < repos.length - 1) await sleepFn(300);
      continue;
    }

    // ── 第三层：保留英文原文 ──
    repo.descSource = 'original';
    originalCount++;
  }

  console.log(`✅ 描述处理完成 — 🤖 AI总结: ${aiCount}  🌐 机器翻译: ${translateCount}  🔤 原文: ${originalCount}`);
  return repos;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
//  3. 格式化为 HTML，并按 PushPlus 限制拆分
// ============================================================
function getSourceLabel(source) {
  const labels = {
    ai: '🤖 AI总结',
    translate: '🌐 机器翻译',
    original: '🔤 原文',
    history: '🗂️ 历史中文说明',
  };
  return labels[source] || 'ℹ️ 描述';
}

function formatRepoCard(repo, options = {}) {
  const descriptionLimit = options.descriptionLimit || DESCRIPTION_CHAR_LIMIT;
  const meta = [
    getSourceLabel(repo.descSource),
    repo.language,
    `⭐ ${repo.stars || 0}`,
    `🍴 ${repo.forks || 0}`,
    repo.todayStars ? `📈 ${repo.todayStars}` : '',
  ].filter(Boolean);

  return `
  <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px;margin:0 0 10px">
    <p style="margin:0 0 6px"><span style="color:#8b949e;font-size:13px;margin-right:6px">#${escapeHTML(repo.rank)}</span><a href="${escapeHTML(repo.url)}" style="color:#58a6ff;font-size:16px;font-weight:600;text-decoration:none">${escapeHTML(repo.name)}</a></p>
    <p style="color:#c9d1d9;font-size:13px;line-height:1.55;margin:0 0 8px">${escapeHTML(truncateText(repo.description, descriptionLimit))}</p>
    <p style="color:#8b949e;font-size:12px;margin:0">${meta.map(escapeHTML).join(' · ')}</p>
  </div>`;
}

function formatHTML(repos, options = {}) {
  const today = options.today || formatDate();
  const pageLabel = options.pageLabel ? ` · ${options.pageLabel}` : '';
  const cards = repos.map((repo) => formatRepoCard(repo, options)).join('');

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#0d1117;color:#e6edf3;padding:16px">
  <div style="text-align:center;margin:0 0 16px">
    <h1 style="color:#58a6ff;margin:0;font-size:22px">🔥 GitHub Trending</h1>
    <p style="color:#8b949e;margin:6px 0 0;font-size:13px">${escapeHTML(today)} · 今日热门开源项目${escapeHTML(pageLabel)}</p>
  </div>${cards}
  <p style="text-align:center;margin:14px 0 0;padding-top:14px;border-top:1px solid #30363d"><a href="https://github.com/trending" style="color:#58a6ff;font-size:13px;text-decoration:none">在 GitHub 上查看完整列表 →</a></p>
</div>`;
}

function buildPushMessages(repos, options = {}) {
  const contentLimit = options.contentLimit || PUSHPLUS_CONTENT_LIMIT;
  const today = options.today || formatDate();
  const chunks = [];
  let currentChunk = [];

  for (const repo of repos) {
    const candidate = [...currentChunk, repo];
    const candidateHtml = formatHTML(candidate, {
      ...options,
      today,
      pageLabel: '第 999/999 条',
    });

    if (currentChunk.length > 0 && candidateHtml.length >= contentLimit) {
      chunks.push(currentChunk);
      currentChunk = [repo];
      const singleHtml = formatHTML(currentChunk, {
        ...options,
        today,
        pageLabel: '第 999/999 条',
      });
      if (singleHtml.length >= contentLimit) {
        throw new Error(`单个项目内容仍超过 PushPlus 安全上限：${repo.name}`);
      }
      continue;
    }

    if (currentChunk.length === 0 && candidateHtml.length >= contentLimit) {
      throw new Error(`单个项目内容仍超过 PushPlus 安全上限：${repo.name}`);
    }

    currentChunk = candidate;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  const total = chunks.length;
  return chunks.map((chunk, index) => {
    const pageSuffix = total > 1 ? ` · ${index + 1}/${total}` : '';
    return {
      title: `🔥 GitHub Trending · ${today}${pageSuffix}`,
      content: formatHTML(chunk, {
        ...options,
        today,
        pageLabel: total > 1 ? `第 ${index + 1}/${total} 条` : '',
      }),
      repos: chunk,
    };
  });
}

// ============================================================
//  4. 通过 PushPlus 推送到微信
// ============================================================
async function pushToWechat(messages, options = {}) {
  const token = options.token ?? PUSHPLUS_TOKEN;
  const httpClient = options.httpClient || axios;
  const contentLimit = options.contentLimit || PUSHPLUS_CONTENT_LIMIT;
  const pushMessages = Array.isArray(messages) ? messages : [{
    title: `🔥 GitHub Trending · ${formatDate()}`,
    content: messages,
  }];

  if (!token) {
    console.error('❌ 未设置 PUSHPLUS_TOKEN 环境变量！');
    console.log('📋 请设置环境变量后重试：');
    console.log('   Windows:  set PUSHPLUS_TOKEN=你的token');
    console.log('   Linux/Mac: export PUSHPLUS_TOKEN=你的token');
    throw new Error('未设置 PUSHPLUS_TOKEN 环境变量');
  }

  console.log(`📤 正在推送到微信，共 ${pushMessages.length} 条 ...`);

  for (let i = 0; i < pushMessages.length; i++) {
    const message = pushMessages[i];
    const contentLength = message.content.length;
    console.log(`  📦 第 ${i + 1}/${pushMessages.length} 条内容长度：${contentLength}/${contentLimit}`);

    if (contentLength >= contentLimit) {
      throw new Error(`第 ${i + 1} 条内容长度 ${contentLength} 超过 PushPlus 安全上限 ${contentLimit}`);
    }

    const res = await httpClient.post(PUSHPLUS_API, {
      token,
      title: message.title,
      content: message.content,
      template: 'html',
    });

    if (res.data && res.data.code === 200) {
      console.log(`  ✅ 第 ${i + 1}/${pushMessages.length} 条推送成功！消息流水号:`, res.data.data);
    } else {
      throw new Error(`推送失败: ${JSON.stringify(res.data)}`);
    }
  }
}

// ============================================================
//  主流程
// ============================================================
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const today = formatDateKey();
  const archiveRoot = process.env.TRENDING_ARCHIVE_DIR
    ? path.resolve(process.env.TRENDING_ARCHIVE_DIR)
    : null;
  let repos = [];
  let state = loadArchiveState(archiveRoot);
  let pushStatus = dryRun ? 'dry-run' : 'failed';
  let pushError = null;

  try {
    repos = await scrapeTrending();

    if (repos.length === 0) {
      throw new Error('未爬取到任何项目，可能页面结构已变更');
    }

    repos = classifyRepos(repos, state, {
      dedupDays: Number.parseInt(process.env.DEDUP_DAYS || '7', 10),
    });
    const newRepos = repos.filter((repo) => repo.deliveryStatus === 'new');
    const duplicateCount = repos.length - newRepos.length;
    console.log(`🧹 去重完成 — 新项目: ${newRepos.length}，近 7 天重复: ${duplicateCount}`);

    // 只处理将要推送的新项目；重复项目复用历史中文说明。
    if (newRepos.length > 0) {
      await enrichDescriptions(newRepos);
    }

    const qqMessages = buildQQMessages(newRepos, { today, date: today });

    // 本地调试：如果传入 --dry-run 参数，只打印不推送
    if (dryRun) {
      console.log('\n--- 预览 (dry-run 模式，不推送) ---\n');
      console.log(`完整榜单 ${repos.length} 个；新项目 ${newRepos.length} 个；重复 ${duplicateCount} 个。`);
      console.log(`预计发送 ${qqMessages.length} 条 QQ 消息：`);
      qqMessages.forEach((message, index) => {
        console.log(`  第 ${index + 1}/${qqMessages.length} 条：${Array.from(message).length} 字符`);
      });
      console.log('');
      const sourceLabel = { ai: '🤖 AI总结', translate: '🌐 机器翻译', original: '🔤 原文', history: '🗂️ 历史说明' };
      repos.forEach((r) => {
        const status = r.deliveryStatus === 'new' ? '🆕' : '🔁';
        console.log(`  ${status} #${r.rank} ${r.name} ⭐${r.stars}  [${sourceLabel[r.descSource] || '原文'}]`);
        console.log(`       ${truncateText(r.description)}`);
        console.log('');
      });
    } else {
      const target = loadQQTarget(archiveRoot);
      if (process.env.QQ_BOT_APP_ID && process.env.QQ_BOT_APP_SECRET) {
        await pushToQQ(qqMessages, { targetOpenid: target?.openid });
      } else if (PUSHPLUS_TOKEN) {
        // 兼容旧配置，但同样只推送去重后的新项目。
        if (newRepos.length === 0) {
          await pushToWechat('<p>今日暂无新上榜项目（已排除近 7 天推荐过的项目）。</p>');
        } else {
          await pushToWechat(buildPushMessages(newRepos, { today }));
        }
      } else {
        throw new Error('未配置 QQ 机器人，也没有可用的 PUSHPLUS_TOKEN');
      }
      pushStatus = 'success';

      state = updateStateAfterSuccessfulPush(state, repos, {
        pushedAt: new Date().toISOString(),
      });
      if (archiveRoot) saveArchiveState(archiveRoot, state);
      console.log('🎉 推送完成！');
    }
  } catch (err) {
    pushError = err;
    console.error('❌ 运行出错:', err.message);
  } finally {
    if (archiveRoot && repos.length > 0) {
      const filePath = saveDailyArchive(archiveRoot, repos, {
        date: today,
        pushStatus,
        pushError: pushError?.message,
      });
      console.log(`🗂️ 完整榜单已保存：${filePath}`);
    }
  }

  if (pushError) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildPushMessages,
  buildQQMessages,
  classifyRepos,
  enrichDescriptions,
  escapeHTML,
  formatHTML,
  formatRepoCard,
  generateAISummary,
  isGeminiQuotaError,
  pushToWechat,
  pushToQQ,
  resetGeminiQuotaState,
  scrapeTrending,
  truncateText,
};
