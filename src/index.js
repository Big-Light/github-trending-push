const axios = require('axios');
const cheerio = require('cheerio');

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

    // 今日新增 Star (最后一个 span 通常包含 "xxx stars today")
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
//  2. 格式化为 HTML
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

    html += `
  <div style="background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
    <div style="margin-bottom: 8px;">
      <span style="color: #8b949e; font-size: 13px; margin-right: 8px;">#${repo.rank}</span>
      <a href="${repo.url}" style="color: #58a6ff; font-size: 16px; font-weight: 600; text-decoration: none;">${repo.name}</a>
    </div>
    <p style="color: #c9d1d9; font-size: 13px; line-height: 1.5; margin: 0 0 10px 0;">${repo.description}</p>
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
//  3. 通过 PushPlus 推送到微信
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
    const repos = await scrapeTrending();

    if (repos.length === 0) {
      console.error('❌ 未爬取到任何项目，可能页面结构已变更');
      process.exit(1);
    }

    const html = formatHTML(repos);

    // 本地调试：如果传入 --dry-run 参数，只打印不推送
    if (process.argv.includes('--dry-run')) {
      console.log('\n--- 预览 HTML (dry-run 模式，不推送) ---\n');
      console.log(`共 ${repos.length} 个项目：`);
      repos.forEach((r) => {
        console.log(`  #${r.rank} ${r.name} ⭐${r.stars} - ${r.description.substring(0, 60)}...`);
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
