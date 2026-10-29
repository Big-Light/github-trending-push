const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WIDTH = 1170;
const HEIGHT = 1560;
const COLORS = {
  background: '#f4f4f6', white: '#ffffff', ink: '#202124', text: '#45464b',
  muted: '#777980', line: '#d8d9dd', tile: '#f4f4f6', blue: '#0878d8',
  paleBlue: '#eaf5fc', red: '#d84235',
};

function xml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function metric(value) {
  const n = Number(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function compactNumber(value) {
  const n = metric(value);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');
}

function dailyStars(repo) {
  return metric(repo.todayStars);
}

function daysSince(isoDate, date) {
  if (!isoDate) return null;
  const start = Date.parse(isoDate);
  const end = Date.parse(`${date}T23:59:59+08:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(1, Math.floor((end - start) / 86400000) + 1);
}

function shorten(value, limit = 80) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.length <= limit ? clean : `${chars.slice(0, limit - 1).join('').trimEnd()}…`;
}

function charWidth(char, size) {
  return /[\u1100-\u9fff\uf900-\ufaff]/u.test(char) ? size : /[A-Z0-9]/.test(char) ? size * 0.62 : size * 0.52;
}

function wrap(value, maxWidth, fontSize, maxLines = 3) {
  const words = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim());
  const lines = [];
  let current = '';
  let width = 0;
  for (const char of words) {
    const next = charWidth(char, fontSize);
    if (current && width + next > maxWidth) {
      lines.push(current.trim());
      current = '';
      width = 0;
      if (lines.length === maxLines) break;
    }
    current += char;
    width += next;
  }
  if (current && lines.length < maxLines) lines.push(current.trim());
  if (lines.length === maxLines && lines.join('').length < words.length) {
    lines[maxLines - 1] = shorten(lines[maxLines - 1], Math.max(2, Array.from(lines[maxLines - 1]).length - 1)) + '…';
  }
  return lines;
}

function text(x, y, value, size = 24, color = COLORS.text, weight = 400, anchor = 'start') {
  return `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}">${xml(value)}</text>`;
}

function lines(x, y, value, width, size = 24, color = COLORS.text, weight = 400, lineHeight = 36, maxLines = 3) {
  return wrap(value, width, size, maxLines).map((line, i) => text(x, y + i * lineHeight, line, size, color, weight)).join('');
}

function rect(x, y, width, height, fill, radius = 0) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"/>`;
}

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><style>text{font-family:Arial,'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif}</style>${rect(0, 0, WIDTH, HEIGHT, COLORS.background)}${body}</svg>`;
}

function header(date) {
  return `<circle cx="70" cy="75" r="6" fill="${COLORS.blue}"/>${text(88, 84, 'GITHUB 飙升日报', 24, COLORS.muted, 700)}${text(1100, 84, date, 23, COLORS.muted, 600, 'end')}<path d="M65 118 H1105" stroke="${COLORS.line}" stroke-width="2"/>`;
}

function ownerLabel(repo) {
  return repo.ownerType === 'Organization' ? '组织账号' : repo.ownerType === 'User' ? '个人账号' : '';
}

function headline(repo) {
  const source = repo.description || repo.originalDescription || '';
  return shorten(source.split(/[。.!！?？]/)[0] || source || '项目简介待补充', 34);
}

function whyGrowing(repo) {
  const pieces = [`今天新增 ${dailyStars(repo).toLocaleString('en-US')} 星`];
  if (repo.trendingDays > 1) pieces.push(`连续 ${repo.trendingDays} 天进入日榜`);
  else pieces.push('今天进入日榜');
  if (Number.isFinite(repo.previousDailyStars)) {
    const delta = dailyStars(repo) - repo.previousDailyStars;
    pieces.push(`较上次记录${delta >= 0 ? '多' : '少'} ${Math.abs(delta).toLocaleString('en-US')} 星`);
  }
  return `${pieces.join('，')}。`;
}

function prepareReport(repos, options = {}) {
  const date = options.date;
  const items = repos.map((repo) => ({ ...repo, ageDays: daysSince(repo.createdAt, date) }))
    .filter((repo) => repo.name && repo.url && dailyStars(repo) > 0);
  const rising = [...items].sort((a, b) => dailyStars(b) - dailyStars(a)).slice(0, 10);
  const risingIds = new Set(rising.map((repo) => repo.repoId || repo.name.toLowerCase()));
  const others = items.filter((repo) => !risingIds.has(repo.repoId || repo.name.toLowerCase()));
  // 新锐榜从当日日榜剩余项目中优先选较新的仓库，再按当日涨星排列。
  const newcomers = others.sort((a, b) => (a.ageDays ?? Infinity) - (b.ageDays ?? Infinity))
    .slice(0, 10).sort((a, b) => dailyStars(b) - dailyStars(a));
  return { date, rising, newcomers };
}

function rankPage(title, repos, date, label) {
  let body = header(date);
  body += text(65, 188, title, 52, COLORS.ink, 750);
  const top = repos[0];
  const intro = top
    ? `今日${title}收录 ${repos.length} 个项目。${top.name.split('/').pop()} 以新增 ${dailyStars(top).toLocaleString('en-US')} 星领跑；下方展示项目简介、总星数和在榜天数。`
    : `今天没有符合条件的${title}项目。`;
  body += rect(65, 218, 1040, 112, COLORS.white, 22);
  body += lines(88, 262, intro, 994, 22, COLORS.text, 400, 34, 2);
  repos.forEach((repo, index) => {
    const y = 345 + index * 116;
    body += rect(65, y, 1040, 105, COLORS.white, 19);
    body += text(86, y + 43, String(index + 1).padStart(2, '0'), 30, COLORS.blue, 700);
    body += text(142, y + 41, shorten(repo.name.split('/').pop(), 21), 30, COLORS.ink, 700);
    const badge = ownerLabel(repo);
    if (badge) body += rect(550, y + 19, 112, 30, COLORS.tile, 6) + text(606, y + 41, badge, 18, COLORS.muted, 600, 'middle');
    body += text(142, y + 78, shorten(headline(repo), 28), 22, COLORS.text, 400);
    body += text(1084, y + 43, `+${dailyStars(repo).toLocaleString('en-US')}/天`, 31, COLORS.blue, 700, 'end');
    body += text(1084, y + 79, `${compactNumber(repo.stars)}★ · 在榜 ${repo.trendingDays || 1} 天`, 19, COLORS.muted, 400, 'end');
  });
  body += text(65, 1530, label, 18, COLORS.muted, 500);
  return svg(body);
}

function infoBox(x, y, width, label, value, highlight = false) {
  return rect(x, y, width, 92, COLORS.tile, 15) + text(x + 20, y + 31, label, 19, COLORS.muted, 600)
    + text(x + 20, y + 68, value, 31, highlight ? COLORS.blue : COLORS.ink, 700);
}

function detailCard(repo, y, rank, group) {
  const x = 65;
  let body = rect(x, y, 1040, 670, COLORS.white, 28);
  body += text(x + 36, y + 56, `${group} ${String(rank).padStart(2, '0')}`, 27, COLORS.blue, 700);
  body += text(x + 230, y + 56, `在榜 ${repo.trendingDays || 1} 天`, 21, COLORS.muted, 400);
  const badge = ownerLabel(repo);
  if (badge) body += rect(x + 410, y + 30, 116, 31, COLORS.tile, 6) + text(x + 468, y + 53, badge, 18, COLORS.muted, 600, 'middle');
  body += text(x + 550, y + 55, shorten([repo.language, repo.license].filter(Boolean).join(' · '), 34), 20, COLORS.muted);
  body += text(x + 36, y + 120, shorten(repo.name.split('/').pop(), 28), 49, COLORS.ink, 750);
  body += text(x + 36, y + 165, headline(repo), 27, COLORS.text, 600);
  body += infoBox(x + 36, y + 190, 305, '每日涨星', `+${dailyStars(repo).toLocaleString('en-US')}/天`, true);
  body += infoBox(x + 353, y + 190, 305, '总星数', `${compactNumber(repo.stars)}★`);
  body += infoBox(x + 670, y + 190, 334, '上线', repo.ageDays ? `${repo.ageDays} 天` : '日期未公开');
  body += rect(x + 36, y + 294, 968, 147, COLORS.tile, 15);
  body += text(x + 56, y + 327, '是什么', 20, COLORS.muted, 700);
  body += lines(x + 56, y + 361, repo.description || repo.originalDescription || '项目暂无公开说明。', 925, 23, COLORS.text, 400, 33, 3);
  body += rect(x + 36, y + 451, 968, 137, COLORS.paleBlue, 15);
  body += text(x + 56, y + 484, '为什么涨', 20, COLORS.blue, 700);
  body += lines(x + 56, y + 518, whyGrowing(repo), 925, 23, COLORS.text, 400, 33, 2);
  body += text(x + 36, y + 625, repo.url.replace(/^https?:\/\//, ''), 19, COLORS.muted);
  return body;
}

function detailPage(first, second, date, firstRank, group) {
  let body = header(date) + detailCard(first, 138, firstRank, group);
  if (second) body += detailCard(second, 828, firstRank + 1, group);
  return svg(body);
}

function summaryPage(report) {
  const all = [...report.rising, ...report.newcomers];
  const top = [...all].sort((a, b) => dailyStars(b) - dailyStars(a))[0];
  const fresh = all.filter((repo) => repo.ageDays !== null && repo.ageDays <= 30);
  const continuing = all.filter((repo) => (repo.trendingDays || 1) > 1);
  const cards = [
    { title: '涨星最多的项目', body: top ? `${top.name} 今天新增 ${dailyStars(top).toLocaleString('en-US')} 星，总星数 ${compactNumber(top.stars)}。这是当日榜单中最突出的增长。` : '今天没有可用的涨星数据。', tags: top ? [top.name] : [] },
    { title: '新项目在榜单中的位置', body: `本期展示的 ${all.length} 个项目中，有 ${fresh.length} 个仓库创建于最近 30 天。新锐榜优先展示较新仓库，并按当天涨星排序。`, tags: fresh.slice(0, 5).map((r) => r.name.split('/').pop()) },
    { title: '持续获得关注', body: `${continuing.length} 个项目连续多天进入日榜。在榜天数来自本日报的历史记录；新增星数来自 GitHub Trending 当日页面。`, tags: continuing.slice(0, 5).map((r) => r.name.split('/').pop()) },
  ];
  let body = header(report.date);
  body += text(65, 215, '今天这三件事', 67, COLORS.ink, 750);
  body += text(65, 263, '用当天数据快速看懂项目热度。', 27, COLORS.text, 600);
  cards.forEach((card, index) => {
    const y = 302 + index * 396;
    body += rect(65, y, 1040, 374, COLORS.white, 27);
    body += text(94, y + 62, String(index + 1).padStart(2, '0'), 29, COLORS.blue, 700);
    body += text(94, y + 116, card.title, 39, COLORS.ink, 750);
    body += lines(94, y + 163, card.body, 970, 26, COLORS.text, 400, 40, 3);
    let tagX = 94;
    card.tags.forEach((tag) => {
      const width = Math.min(240, Math.max(100, Array.from(tag).length * 14 + 30));
      if (tagX + width > 1065) return;
      body += rect(tagX, y + 310, width, 42, COLORS.tile, 21);
      body += text(tagX + width / 2, y + 339, shorten(tag, 16), 20, COLORS.blue, 650, 'middle');
      tagX += width + 10;
    });
  });
  body += text(65, 1525, '数据来源：GitHub Trending · GitHub 仓库公开信息', 18, COLORS.muted);
  return svg(body);
}

function buildPages(report) {
  const pages = [];
  if (report.rising.length) pages.push({ name: '01-涨星榜', svg: rankPage('涨星榜', report.rising, report.date, '按当日新增星数排序') });
  if (report.newcomers.length) pages.push({ name: '02-新锐榜', svg: rankPage('新锐榜', report.newcomers, report.date, '优先选择较新仓库，按当日新增星数排序') });
  for (const [group, repos] of [['涨星', report.rising], ['新锐', report.newcomers]]) {
    for (let index = 0; index < repos.length; index += 2) {
      pages.push({ name: `${String(pages.length + 1).padStart(2, '0')}-${group}详情-${index + 1}`, svg: detailPage(repos[index], repos[index + 1], report.date, index + 1, group) });
    }
  }
  pages.push({ name: `${String(pages.length + 1).padStart(2, '0')}-今日观察`, svg: summaryPage(report) });
  return pages;
}

function findChrome() {
  const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'google-chrome-stable', 'chromium'];
  for (const candidate of candidates.filter(Boolean)) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function saveImageReport(archiveRoot, report, options = {}) {
  const folder = path.join(archiveRoot, report.date.slice(0, 4), `${report.date}-images`);
  fs.mkdirSync(folder, { recursive: true });
  const chrome = options.chromeBin || findChrome();
  if (!chrome) throw new Error('未找到 Chrome，无法导出 PNG 图片日报');
  const pages = buildPages(report);
  for (const page of pages) {
    const svgPath = path.join(folder, `${page.name}.svg`);
    fs.writeFileSync(svgPath, page.svg, 'utf8');
    const pngPath = path.join(folder, `${page.name}.png`);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trending-chrome-'));
    try {
      const result = spawnSync(chrome, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
        `--user-data-dir=${profile}`, `--screenshot=${pngPath}`,
        `--window-size=${WIDTH},${HEIGHT}`, `file://${svgPath}`,
      ], { encoding: 'utf8', timeout: 30000 });
      if (result.error || result.status !== 0 || !fs.existsSync(pngPath)) {
        throw new Error(`Chrome 图片生成失败：${result.error?.message || result.stderr || '未生成 PNG'}`);
      }
      fs.rmSync(svgPath);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
  return { folder, pages: pages.map((page) => `${page.name}.png`), format: 'png' };
}

module.exports = { buildPages, compactNumber, dailyStars, daysSince, prepareReport, saveImageReport, whyGrowing };
