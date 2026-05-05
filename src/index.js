const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');
const translate = require('google-translate-api-x');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ============================================================
//  配置
// ============================================================
const GITHUB_TRENDING_URL = 'https://github.com/trending';
const PUSHPLUS_API = 'http://www.pushplus.plus/send';
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;

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

async function generateAISummary(about, readmeSnippet, repoName) {
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
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      return response.text.trim();
    } catch (err) {
      const isRateLimit = err.message && (err.message.includes('429') || err.message.toLowerCase().includes('quota') || err.message.toLowerCase().includes('rate'));
      if (isRateLimit && attempt < 2) {
        console.warn(`  ⏳ Gemini 速率限制，等待 20 秒后重试 (${repoName})...`);
        await sleep(20000);
        continue;
      }
      console.warn(`  ⚠️ 项目 ${repoName} AI 总结失败: ${err.message}`);
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

async function enrichDescriptions(repos) {
  console.log('🌐 正在处理项目描述（AI 总结 → 机器翻译 → 原文）...');

  const hasGemini = !!process.env.GEMINI_API_KEY;
  if (!hasGemini) {
    console.warn('⚠️ 未设置 GEMINI_API_KEY，跳过 AI 总结，将使用机器翻译兜底。');
  }

  let aiCount = 0, translateCount = 0, originalCount = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    console.log(`  [${i + 1}/${repos.length}] 处理 ${repo.name}...`);

    // ── 第一层：Gemini AI 总结 ──
    if (hasGemini) {
      const readmeSnippet = await fetchReadmeSnippet(repo.url);
      const summary = await generateAISummary(repo.description, readmeSnippet, repo.name);
      if (summary) {
        repo.description = summary;
        repo.descSource = 'ai';
        aiCount++;
        // Gemini 免费版限制 10 RPM，每次请求间隔 6.5 秒确保不超限
        if (i < repos.length - 1) await sleep(6500);
        continue;
      }
    }

    // ── 第二层：Google Translate 翻译兜底 ──
    const translated = await translateFallback(repo.description);
    if (translated) {
      repo.description = translated;
      repo.descSource = 'translate';
      translateCount++;
      if (i < repos.length - 1) await sleep(300);
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
//  3. 格式化为 HTML
// ============================================================
function formatHTML(repos) {
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  });

  // 语言对应颜色
  const langColors = {
    JavaScript: '#f1e05a',
    TypeScript: '#3178c6',
    Python: '#3572A5',
    Java: '#b07219',
    Go: '#00ADD8',
    Rust: '#dea584',
    'C++': '#f34b7d',
    C: '#555555',
    'C#': '#178600',
    Ruby: '#701516',
    PHP: '#4F5D95',
    Swift: '#F05138',
    Kotlin: '#A97BFF',
    Dart: '#00B4AB',
    Shell: '#89e051',
    HTML: '#e34c26',
    CSS: '#563d7c',
    Vue: '#41b883',
    Svelte: '#ff3e00',
    Jupyter: '#DA5B0B',
  };

  let html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 800px; margin: 0 auto; background: #0d1117; color: #e6edf3; padding: 20px; border-radius: 12px;">
  <div style="text-align: center; margin-bottom: 24px;">
    <h1 style="color: #58a6ff; margin: 0; font-size: 22px;">🔥 GitHub Trending</h1>
    <p style="color: #8b949e; margin: 6px 0 0 0; font-size: 13px;">${today} · 今日热门开源项目</p>
  </div>`;

  repos.forEach((repo) => {
    const langDot = repo.language
      ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${langColors[repo.language] || '#8b949e'};margin-right:4px;vertical-align:middle;"></span><span style="color:#8b949e;font-size:12px;margin-right:12px;">${repo.language}</span>`
      : '';

    const todayBadge = repo.todayStars
      ? `<span style="color:#57ab5a;font-size:12px;">📈 ${repo.todayStars}</span>`
      : '';

    // 来源标识徽章
    const sourceBadges = {
      ai:        `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:#1a237e;color:#82b1ff;margin-bottom:8px;">🤖 AI 总结</span>`,
      translate: `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:#1b2a3b;color:#90caf9;margin-bottom:8px;">🌐 机器翻译</span>`,
      original:  `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:#2d1b00;color:#ffb74d;margin-bottom:8px;">🔤 原文</span>`,
    };
    const sourceBadge = sourceBadges[repo.descSource] || '';

    html += `
  <div style="background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
    <div style="margin-bottom: 8px;">
      <span style="color: #8b949e; font-size: 13px; margin-right: 8px;">#${repo.rank}</span>
      <a href="${repo.url}" style="color: #58a6ff; font-size: 16px; font-weight: 600; text-decoration: none;">${repo.name}</a>
    </div>
    ${sourceBadge}
    <p style="color: #c9d1d9; font-size: 13px; line-height: 1.6; margin: 0 0 10px 0;">${repo.description}</p>
    <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">
      ${langDot}
      <span style="color: #8b949e; font-size: 12px;">⭐ ${repo.stars}</span>
      <span style="color: #8b949e; font-size: 12px;">🍴 ${repo.forks}</span>
      ${todayBadge}
    </div>
  </div>`;
  });

  html += `
  <div style="text-align: center; margin-top: 16px; padding-top: 16px; border-top: 1px solid #30363d;">
    <a href="https://github.com/trending" style="color: #58a6ff; font-size: 13px; text-decoration: none;">在 GitHub 上查看完整列表 →</a>
  </div>
</div>`;

  return html;
}

// ============================================================
//  4. 通过 PushPlus 推送到微信
// ============================================================
async function pushToWechat(html) {
  if (!PUSHPLUS_TOKEN) {
    console.error('❌ 未设置 PUSHPLUS_TOKEN 环境变量！');
    console.log('📋 请设置环境变量后重试：');
    console.log('   Windows:  set PUSHPLUS_TOKEN=你的token');
    console.log('   Linux/Mac: export PUSHPLUS_TOKEN=你的token');
    process.exit(1);
  }

  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  });

  console.log('📤 正在推送到微信 ...');

  const res = await axios.post(PUSHPLUS_API, {
    token: PUSHPLUS_TOKEN,
    title: `🔥 GitHub Trending · ${today}`,
    content: html,
    template: 'html',
  });

  if (res.data && res.data.code === 200) {
    console.log('✅ 推送成功！消息流水号:', res.data.data);
  } else {
    console.error('❌ 推送失败:', JSON.stringify(res.data));
    process.exit(1);
  }
}

// ============================================================
//  主流程
// ============================================================
async function main() {
  try {
    let repos = await scrapeTrending();

    if (repos.length === 0) {
      console.error('❌ 未爬取到任何项目，可能页面结构已变更');
      process.exit(1);
    }

    // 翻译描述为中文
    repos = await enrichDescriptions(repos);

    const html = formatHTML(repos);

    // 本地调试：如果传入 --dry-run 参数，只打印不推送
    if (process.argv.includes('--dry-run')) {
      console.log('\n--- 预览 (dry-run 模式，不推送) ---\n');
      console.log(`共 ${repos.length} 个项目：`);
      const sourceLabel = { ai: '🤖 AI总结', translate: '🌐 机器翻译', original: '🔤 原文' };
      repos.forEach((r) => {
        console.log(`  #${r.rank} ${r.name} ⭐${r.stars}  [${sourceLabel[r.descSource] || '?'}]`);
        console.log(`       ${r.description}`);
        console.log('');
      });
      return;
    }

    await pushToWechat(html);
    console.log('🎉 全部完成！');
  } catch (err) {
    console.error('❌ 运行出错:', err.message);
    process.exit(1);
  }
}

main();
