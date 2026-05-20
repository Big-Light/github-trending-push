const assert = require('node:assert/strict');

const {
  buildPushMessages,
  generateAISummary,
  pushToWechat,
  resetGeminiQuotaState,
  truncateText,
} = require('./index');

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
