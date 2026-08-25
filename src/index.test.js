const assert = require('node:assert/strict');

const {
  buildQQMessages,
  buildPushMessages,
  classifyRepos,
  generateAISummary,
  pushToQQ,
  pushToWechat,
  resetGeminiQuotaState,
  truncateText,
} = require('./index');
const {
  createEmptyState,
  formatObsidianMarkdown,
  updateStateAfterSuccessfulPush,
} = require('./archive');
const { getQQDeliveryHint, waitForQQBinding } = require('./qq');

function makeRepos(count, description) {
  return Array.from({ length: count }, (_, index) => ({
    rank: index + 1,
    name: `owner/repo-${index + 1}`,
    url: `https://github.com/owner/repo-${index + 1}`,
    description,
    language: index % 2 === 0 ? 'JavaScript' : 'Python',
    stars: `${1000 + index}`,
    forks: `${100 + index}`,
    todayStars: `${index + 1} stars today`,
    descSource: index % 2 === 0 ? 'ai' : 'translate',
  }));
}

async function run() {
  const longDescription = '这是一个很长的项目描述，用来模拟机器翻译或 AI 总结产生的长文本。'.repeat(80);

  const normalMessages = buildPushMessages(makeRepos(18, longDescription), {
    contentLimit: 19000,
    today: '2026/05/20',
  });

  assert.equal(normalMessages.reduce((sum, message) => sum + message.repos.length, 0), 18);
  assert.ok(normalMessages.every((message) => message.content.length < 19000));

  const splitMessages = buildPushMessages(makeRepos(18, longDescription), {
    contentLimit: 3500,
    today: '2026/05/20',
  });

  assert.ok(splitMessages.length > 1);
  assert.ok(splitMessages.every((message) => message.content.length < 3500));
  assert.match(splitMessages[0].title, /1\/\d+$/);

  const oneHugeRepo = buildPushMessages(makeRepos(1, '超长描述'.repeat(1000)), {
    contentLimit: 19000,
    descriptionLimit: 200,
    today: '2026/05/20',
  });

  assert.equal(oneHugeRepo.length, 1);
  assert.ok(oneHugeRepo[0].content.length < 19000);
  assert.ok(oneHugeRepo[0].content.includes('…'));
  assert.equal(Array.from(truncateText('a'.repeat(500), 200)).length, 200);

  const calls = [];
  await pushToWechat(splitMessages.slice(0, 2), {
    token: 'test-token',
    contentLimit: 19000,
    httpClient: {
      post: async (url, payload) => {
        calls.push({ url, payload });
        return { data: { code: 200, data: `ok-${calls.length}` } };
      },
    },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.payload.template === 'html'));

  const history = {
    version: 1,
    repos: {
      'owner/repo-1': {
        pushedAt: '2026-05-19T01:00:00.000Z',
        localizedDescription: '历史中文说明',
        descSource: 'ai',
      },
      'owner/repo-2': {
        pushedAt: '2026-05-01T01:00:00.000Z',
      },
    },
  };
  const classified = classifyRepos(makeRepos(3, 'original'), history, {
    now: new Date('2026-05-20T01:00:00.000Z'),
    dedupDays: 7,
  });
  assert.equal(classified[0].deliveryStatus, 'duplicate');
  assert.equal(classified[0].description, '历史中文说明');
  assert.equal(classified[1].deliveryStatus, 'new');
  assert.equal(classified[2].deliveryStatus, 'new');

  classified[1].description = '新的中文说明';
  classified[1].descSource = 'translate';
  const updatedState = updateStateAfterSuccessfulPush(history, classified, {
    pushedAt: '2026-05-20T02:00:00.000Z',
  });
  assert.equal(updatedState.repos['owner/repo-1'].pushedAt, '2026-05-19T01:00:00.000Z');
  assert.equal(updatedState.repos['owner/repo-2'].pushedAt, '2026-05-20T02:00:00.000Z');
  assert.equal(updatedState.repos['owner/repo-2'].localizedDescription, '新的中文说明');

  const markdown = formatObsidianMarkdown(classified, {
    date: '2026-05-20',
    pushStatus: 'success',
  });
  assert.match(markdown, /duplicate_count: 1/);
  assert.match(markdown, /近 7 天已推荐，本次未推送/);
  assert.match(markdown, /新项目，已推送到 QQ/);
  assert.match(markdown, /### 2\. \[owner\/repo-2\]\(https:\/\/github\.com\/owner\/repo-2\) 🆕/);
  assert.doesNotMatch(markdown, /### 1\. \[owner\/repo-1\]\(https:\/\/github\.com\/owner\/repo-1\) 🆕/);

  const qqMessages = buildQQMessages(classified.filter((repo) => repo.deliveryStatus === 'new'), {
    date: '2026-05-20',
    contentLimit: 650,
  });
  assert.ok(qqMessages.length >= 1);
  assert.ok(qqMessages.every((message) => Array.from(message).length <= 650));
  assert.match(buildQQMessages([], { date: '2026-05-20' })[0], /今日暂无新上榜项目/);

  const qqCalls = [];
  await pushToQQ(qqMessages, {
    appId: 'test-app',
    appSecret: 'test-secret',
    targetOpenid: 'test-openid',
    contentLimit: 650,
    botFactory: async () => ({
      sendText: async (target, content) => {
        qqCalls.push({ target, content });
        return { id: `qq-${qqCalls.length}` };
      },
    }),
  });
  assert.equal(qqCalls.length, qqMessages.length);
  assert.ok(qqCalls.every((call) => call.target.scope === 'c2c'));
  assert.match(getQQDeliveryHint({ bizCode: 40054013 }), /允许主动发送/);
  assert.equal(getQQDeliveryHint({ bizCode: 12345 }), null);

  await assert.rejects(pushToQQ(['test'], {
    appId: 'test-app',
    appSecret: 'test-secret',
    targetOpenid: 'test-openid',
    botFactory: async () => ({
      sendText: async () => {
        const error = new Error('消息发送失败');
        error.bizCode = 40054013;
        throw error;
      },
    }),
  }), /允许主动发送/);

  const bindingHandlers = {};
  let resolveBotStart;
  const fakeBindingBot = {
    on: (event, handler) => {
      bindingHandlers[event] = handler;
    },
    start: () => new Promise((resolve) => {
      resolveBotStart = resolve;
    }),
    stop: () => resolveBotStart?.(),
    sendText: async () => ({ id: 'binding-confirmation' }),
  };
  const bindingPromise = waitForQQBinding({
    appId: 'test-app',
    appSecret: 'test-secret',
    timeoutMs: 1000,
    botFactory: async () => fakeBindingBot,
  });
  setImmediate(() => bindingHandlers.message({}, {
    content: '绑定 GitHub Trending',
    senderId: 'private-openid',
    senderName: 'tester',
    messageId: 'incoming-message',
    replyTarget: { scope: 'c2c', targetId: 'private-openid', msgId: 'incoming-message' },
  }));
  const binding = await bindingPromise;
  assert.equal(binding.openid, 'private-openid');

  assert.deepEqual(createEmptyState(), { version: 1, repos: {} });

  resetGeminiQuotaState();
  let geminiCalls = 0;
  let sleepCalls = 0;
  const quotaError = new Error(JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota. Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier.',
    },
  }));

  const fakeAiClient = {
    models: {
      generateContent: async () => {
        geminiCalls += 1;
        throw quotaError;
      },
    },
  };

  const firstSummary = await generateAISummary('about', 'readme', 'owner/repo', {
    aiClient: fakeAiClient,
    sleepFn: async () => {
      sleepCalls += 1;
    },
  });
  const secondSummary = await generateAISummary('about', 'readme', 'owner/repo-2', {
    aiClient: fakeAiClient,
    sleepFn: async () => {
      sleepCalls += 1;
    },
  });

  assert.equal(firstSummary, null);
  assert.equal(secondSummary, null);
  assert.equal(geminiCalls, 1);
  assert.equal(sleepCalls, 0);
  resetGeminiQuotaState();
}

run()
  .then(() => {
    console.log('All tests passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
