const fs = require('node:fs');
const path = require('node:path');

const STATE_DIRECTORY = '.github-trending';
const STATE_FILE = 'state.json';
const QQ_TARGET_FILE = 'qq-target.json';
const DEFAULT_DEDUP_DAYS = Number.parseInt(process.env.DEDUP_DAYS || '30', 10);

function formatDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeRepoId(repoOrName) {
  const name = typeof repoOrName === 'string' ? repoOrName : repoOrName?.name;
  return String(name || '').replace(/\s+/g, '').replace(/^\/+|\/+$/g, '').toLowerCase();
}

function createEmptyState() {
  return { version: 1, repos: {} };
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw new Error(`读取 JSON 失败 (${filePath}): ${err.message}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function getStatePath(archiveRoot) {
  return path.join(archiveRoot, STATE_DIRECTORY, STATE_FILE);
}

function getQQTargetPath(archiveRoot) {
  return path.join(archiveRoot, STATE_DIRECTORY, QQ_TARGET_FILE);
}

function loadArchiveState(archiveRoot) {
  if (!archiveRoot) return createEmptyState();
  const state = readJson(getStatePath(archiveRoot), createEmptyState());
  return {
    version: 1,
    ...state,
    repos: state?.repos && typeof state.repos === 'object' ? state.repos : {},
  };
}

function saveArchiveState(archiveRoot, state) {
  writeJson(getStatePath(archiveRoot), state);
}

function loadQQTarget(archiveRoot) {
  if (!archiveRoot) return null;
  const data = readJson(getQQTargetPath(archiveRoot), null);
  return data?.openid ? data : null;
}

function saveQQTarget(archiveRoot, target) {
  writeJson(getQQTargetPath(archiveRoot), {
    version: 1,
    type: 'c2c',
    openid: target.openid,
    boundAt: target.boundAt || new Date().toISOString(),
  });
  return getQQTargetPath(archiveRoot);
}

function classifyRepos(repos, state, options = {}) {
  const now = options.now || new Date();
  const dedupDays = options.dedupDays ?? DEFAULT_DEDUP_DAYS;
  const cutoff = now.getTime() - dedupDays * 24 * 60 * 60 * 1000;

  return repos.map((repo) => {
    const repoId = normalizeRepoId(repo);
    const history = state?.repos?.[repoId];
    const pushedAt = history?.pushedAt ? new Date(history.pushedAt).getTime() : Number.NaN;
    const duplicate = Number.isFinite(pushedAt) && pushedAt >= cutoff;
    const classified = {
      ...repo,
      repoId,
      originalDescription: repo.description,
      deliveryStatus: duplicate ? 'duplicate' : 'new',
      lastPushedAt: duplicate ? history.pushedAt : null,
    };

    if (duplicate && history.localizedDescription) {
      classified.description = history.localizedDescription;
      classified.descSource = history.descSource || 'history';
    }
    return classified;
  });
}

function updateStateAfterSuccessfulPush(state, repos, options = {}) {
  const pushedAt = options.pushedAt || new Date().toISOString();
  const seenAt = options.seenAt || pushedAt;
  const next = {
    version: 1,
    updatedAt: seenAt,
    repos: { ...(state?.repos || {}) },
  };

  for (const repo of repos) {
    const repoId = repo.repoId || normalizeRepoId(repo);
    const previous = next.repos[repoId] || {};
    const entry = {
      ...previous,
      name: repo.name,
      url: repo.url,
      lastSeenAt: seenAt,
      originalDescription: repo.originalDescription || repo.description,
    };

    if (repo.deliveryStatus === 'new') {
      entry.pushedAt = pushedAt;
      entry.localizedDescription = repo.description;
      entry.descSource = repo.descSource || 'original';
    }
    next.repos[repoId] = entry;
  }
  return next;
}

function escapeYaml(value) {
  return JSON.stringify(String(value ?? ''));
}

function cleanMarkdownText(value) {
  return String(value ?? '').replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

function statusLabel(repo, pushStatus) {
  if (repo.deliveryStatus === 'duplicate') return '🔁 近 30 天已推荐，本次未推送';
  if (pushStatus === 'success') return '🆕 新项目，已推送到 QQ';
  if (pushStatus === 'dry-run') return '🧪 新项目，预览模式未推送';
  return '⚠️ 新项目，QQ 推送失败，下次继续重试';
}

function formatObsidianMarkdown(repos, options = {}) {
  const date = options.date || formatDateKey();
  const pushStatus = options.pushStatus || 'failed';
  const newCount = repos.filter((repo) => repo.deliveryStatus === 'new').length;
  const duplicateCount = repos.length - newCount;
  const errorMessage = options.pushError ? cleanMarkdownText(options.pushError) : '';
  const lines = [
    '---',
    `date: ${date}`,
    'source: GitHub Trending',
    `total: ${repos.length}`,
    `new_count: ${newCount}`,
    `duplicate_count: ${duplicateCount}`,
    `qq_push: ${pushStatus}`,
    'tags:',
    '  - github/trending',
    '  - AI学习',
    '---',
    '',
    `# GitHub Trending · ${date}`,
    '',
    `> 共 ${repos.length} 个项目；新项目 ${newCount} 个；近 30 天重复 ${duplicateCount} 个。`,
  ];

  if (errorMessage) {
    lines.push('', `> [!warning] QQ 推送失败`, `> ${errorMessage}`);
  }

  lines.push('', '## 项目榜单', '');
  for (const repo of repos) {
    const metadata = [
      repo.language || null,
      `⭐ ${repo.stars || 0}`,
      `🍴 ${repo.forks || 0}`,
      repo.todayStars || null,
    ].filter(Boolean).join(' · ');
    lines.push(
      `### ${repo.rank}. [${repo.name}](${repo.url})${repo.deliveryStatus === 'new' ? ' 🆕' : ''}`,
      '',
      `**状态：** ${statusLabel(repo, pushStatus)}`,
      '',
      cleanMarkdownText(repo.description || repo.originalDescription || '暂无描述'),
      '',
      metadata,
      '',
    );
  }

  lines.push('---', '', '[查看 GitHub Trending](https://github.com/trending)', '');
  return lines.join('\n');
}

function saveDailyArchive(archiveRoot, repos, options = {}) {
  const date = options.date || formatDateKey();
  const year = date.slice(0, 4);
  const filePath = path.join(archiveRoot, year, `${date}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, formatObsidianMarkdown(repos, { ...options, date }), 'utf8');
  return filePath;
}

module.exports = {
  classifyRepos,
  createEmptyState,
  formatDateKey,
  formatObsidianMarkdown,
  getQQTargetPath,
  getStatePath,
  loadArchiveState,
  loadQQTarget,
  normalizeRepoId,
  saveArchiveState,
  saveDailyArchive,
  saveQQTarget,
  updateStateAfterSuccessfulPush,
};
