const DEFAULT_QQ_CONTENT_LIMIT = Number.parseInt(process.env.QQ_CONTENT_LIMIT || '1800', 10);

async function createQQBot(options = {}) {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  return new QQBot({
    appId: options.appId,
    appSecret: options.appSecret,
    tokenPrefetch: 'sync',
    userAgent: 'github-trending-push/2.0',
    logger: options.logger,
  });
}

function truncate(value, limit) {
  const chars = Array.from(String(value ?? '').replace(/\s+/g, ' ').trim());
  if (chars.length <= limit) return chars.join('');
  return `${chars.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`;
}

function formatQQRepo(repo) {
  const metadata = [
    repo.language || null,
    `⭐ ${repo.stars || 0}`,
    repo.todayStars || null,
  ].filter(Boolean).join(' · ');
  return [
    `${repo.rank}. ${repo.name}`,
    truncate(repo.description, 320),
    metadata,
    repo.url,
  ].filter(Boolean).join('\n');
}

function splitOversizedBlock(block, limit) {
  const chars = Array.from(block);
  const parts = [];
  for (let index = 0; index < chars.length; index += limit) {
    parts.push(chars.slice(index, index + limit).join(''));
  }
  return parts;
}

function buildQQMessages(repos, options = {}) {
  const date = options.date || new Date().toISOString().slice(0, 10);
  const contentLimit = options.contentLimit || DEFAULT_QQ_CONTENT_LIMIT;
  if (repos.length === 0) {
    return [`🔥 GitHub Trending · ${date}\n\n今日暂无新上榜项目（已排除近 30 天推荐过的项目）。`];
  }

  const bodyBudget = Math.max(200, contentLimit - 100);
  const blocks = repos.flatMap((repo) => splitOversizedBlock(formatQQRepo(repo), bodyBudget));
  const chunks = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (current && Array.from(candidate).length > bodyBudget) {
      chunks.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((chunk, index) => {
    const page = chunks.length > 1 ? ` · ${index + 1}/${chunks.length}` : '';
    return `🔥 GitHub Trending · ${date}${page}\n🆕 今日新项目 ${repos.length} 个\n\n${chunk}`;
  });
}

function getQQDeliveryHint(error) {
  const code = Number(error?.bizCode);
  const hints = {
    40034100: '主动消息发送频率已达上限，请稍后重试。',
    40034105: '机器人没有主动消息权限，请检查 QQ 开放平台配置。',
    40034122: '互动召回额度已达上限；每日榜单应使用普通主动消息，而不是主动唤醒消息。',
    40054004: '机器人与目标用户没有好友关系，请重新完成私聊绑定。',
    40054013: '用户已拒绝机器人消息，请在手机 QQ 的机器人会话设置中开启“允许主动发送”。',
    40054016: '机器人当前处于离线状态，请检查 QQ 开放平台中的机器人状态。',
  };
  return hints[code] ? `QQ 错误码 ${code}：${hints[code]}` : null;
}

async function pushToQQ(messages, options = {}) {
  const appId = options.appId || process.env.QQ_BOT_APP_ID;
  const appSecret = options.appSecret || process.env.QQ_BOT_APP_SECRET;
  const targetOpenid = options.targetOpenid || process.env.QQ_BOT_TARGET_OPENID;
  if (!appId || !appSecret) {
    throw new Error('未设置 QQ_BOT_APP_ID 或 QQ_BOT_APP_SECRET');
  }
  if (!targetOpenid) {
    throw new Error('尚未绑定 QQ 私聊目标，请先运行“绑定 QQ 机器人”工作流');
  }

  const botFactory = options.botFactory || createQQBot;
  const bot = await botFactory({ appId, appSecret, logger: options.logger });
  const payloads = Array.isArray(messages) ? messages : [messages];
  const results = [];
  console.log(`📤 正在通过 QQ 机器人推送，共 ${payloads.length} 条 ...`);
  for (let index = 0; index < payloads.length; index += 1) {
    const content = payloads[index];
    if (Array.from(content).length > (options.contentLimit || DEFAULT_QQ_CONTENT_LIMIT)) {
      throw new Error(`第 ${index + 1} 条 QQ 消息超过内容上限`);
    }
    let result;
    try {
      result = await bot.sendText({ scope: 'c2c', targetId: targetOpenid }, content);
    } catch (error) {
      const hint = getQQDeliveryHint(error);
      if (hint) {
        throw new Error(`${error.message}\n💡 ${hint}`, { cause: error });
      }
      throw error;
    }
    results.push(result);
    const messageId = result?.id || result?.message_id || result?.messageId;
    const receipt = messageId ? `，消息 ID: ${messageId}` : '，QQ API 未返回消息 ID';
    console.log(`  ✅ 第 ${index + 1}/${payloads.length} 条主动消息请求成功${receipt}`);
  }
  return results;
}

async function waitForQQBinding(options = {}) {
  const appId = options.appId || process.env.QQ_BOT_APP_ID;
  const appSecret = options.appSecret || process.env.QQ_BOT_APP_SECRET;
  const keyword = options.keyword || '绑定 GitHub Trending';
  const timeoutMs = options.timeoutMs || 180_000;
  if (!appId || !appSecret) {
    throw new Error('未设置 QQ_BOT_APP_ID 或 QQ_BOT_APP_SECRET');
  }

  const botFactory = options.botFactory || createQQBot;
  const bot = await botFactory({ appId, appSecret, logger: options.logger || console });
  let timeoutHandle;
  let settled = false;
  let rejectBinding;

  const bindingPromise = new Promise((resolve, reject) => {
    rejectBinding = reject;
    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      bot.stop();
      reject(new Error(`等待 QQ 绑定消息超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    bot.on('message', async (_ctx, message) => {
      if (settled || message.replyTarget?.scope !== 'c2c') return;
      if (!String(message.content || '').includes(keyword)) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        await bot.sendText(message.replyTarget, '✅ GitHub Trending 已绑定，后续榜单会发送到这个会话。');
      } catch (err) {
        console.warn(`⚠️ 绑定确认消息发送失败，但 OpenID 已获取：${err.message}`);
      }
      resolve({
        openid: message.senderId,
        senderName: message.senderName || '',
        messageId: message.messageId,
      });
      bot.stop();
    });
  });

  const startPromise = bot.start().catch((err) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeoutHandle);
      rejectBinding(err);
    }
  });

  try {
    return await bindingPromise;
  } finally {
    clearTimeout(timeoutHandle);
    bot.stop();
    await startPromise.catch(() => {});
  }
}

module.exports = {
  buildQQMessages,
  createQQBot,
  formatQQRepo,
  getQQDeliveryHint,
  pushToQQ,
  waitForQQBinding,
};
