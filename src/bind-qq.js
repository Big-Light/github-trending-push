const path = require('node:path');
const { saveQQTarget } = require('./archive');
const { waitForQQBinding } = require('./qq');

function parseTimeoutSeconds(argv) {
  const index = argv.indexOf('--timeout');
  if (index < 0) return 180;
  const value = Number.parseInt(argv[index + 1], 10);
  return Number.isFinite(value) && value > 0 ? value : 180;
}

function maskOpenid(openid) {
  const value = String(openid || '');
  if (value.length <= 10) return '***';
  return `${value.slice(0, 5)}…${value.slice(-5)}`;
}

async function main() {
  const archiveRoot = path.resolve(process.env.TRENDING_ARCHIVE_DIR || '.vault');
  const timeoutSeconds = parseTimeoutSeconds(process.argv);
  console.log('🔗 QQ Gateway 已开始连接。');
  console.log('📱 请在手机 QQ 中向机器人发送：绑定 GitHub Trending');
  console.log(`⏳ 最长等待 ${timeoutSeconds} 秒 ...`);

  const target = await waitForQQBinding({ timeoutMs: timeoutSeconds * 1000 });
  if (!target?.openid) throw new Error('没有从 QQ 消息中取得 OpenID');

  const filePath = saveQQTarget(archiveRoot, {
    openid: target.openid,
    boundAt: new Date().toISOString(),
  });
  console.log(`✅ 已绑定 QQ 用户 ${maskOpenid(target.openid)}`);
  console.log(`🔒 完整 OpenID 已写入私有 Vault：${filePath}`);
}

main().catch((err) => {
  console.error('❌ QQ 绑定失败:', err.message);
  process.exit(1);
});
