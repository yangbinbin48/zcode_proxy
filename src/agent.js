import { getJwtToken, getApiKey } from './auth.js';
import config from './config.js';

const PROVIDERS = {
  zai: {
    // Coding Plan 端点（试用额度在这里）
    url: config.upstream.zai,
    // 备用：API Key 端点（无试用额度）
    fallbackUrl: config.upstream.zaiFallback
  },
  bigmodel: {
    url: config.upstream.bigmodel
  }
};

/**
 * 转发消息请求至底层的大模型提供商 API
 * @param {string} providerId 'zai' | 'bigmodel'
 * @param {object} body Anthropic Messages API 请求体
 * @param {string} verifyParam 阿里无痕验证 Token
 * @param {object} headers 传入的原始附加 headers
 * @returns {Promise<Response>} 返回 Fetch Response 对象
 */
async function sendMessages(providerId, body, verifyParam, headers = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`未知提供商: ${providerId}`);
  }

  // 优先使用 JWT Token（Coding Plan），回退到 API Key
  const jwtToken = getJwtToken(providerId);
  const apiKey = getApiKey(providerId);

  let targetUrl = provider.url;
  let authHeader;

  if (jwtToken) {
    // Coding Plan 模式：JWT Bearer 认证
    authHeader = { 'Authorization': `Bearer ${jwtToken}` };
    console.log(`[Agent] 使用 Coding Plan 模式 (JWT Token)`);
  } else if (apiKey) {
    // API Key 模式：回退到传统端点
    if (provider.fallbackUrl) {
      targetUrl = provider.fallbackUrl;
    }
    authHeader = { 'x-api-key': apiKey };
    console.log(`[Agent] 使用 API Key 模式 (回退)`);
  } else {
    throw new Error(`请先登录 (node cli.js login zai) 或手动配置 API Key。`);
  }

  // 整理请求头
  const requestHeaders = {
    'content-type': 'application/json',
    ...authHeader,
    'anthropic-version': '2023-06-01',
    'User-Agent': config.userAgent,
    'X-ZCode-App-Version': config.appVersion,
    'X-ZCode-Agent': 'glm',
    'HTTP-Referer': 'https://zcode.z.ai/'
  };

  // 动态附加阿里无痕验证参数
  if (verifyParam) {
    requestHeaders['X-Aliyun-Captcha-Verify-Param'] = verifyParam;
  }

  // 合并来自客户端的其他必要头信息（除特定认证头之外）
  for (const [k, v] of Object.entries(headers)) {
    const keyLower = k.toLowerCase();
    if (
      keyLower !== 'host' &&
      keyLower !== 'content-length' &&
      keyLower !== 'x-api-key' &&
      keyLower !== 'authorization' &&
      keyLower !== 'user-agent' &&
      !keyLower.startsWith('x-zcode') &&
      keyLower !== 'http-referer'
    ) {
      requestHeaders[k] = v;
    }
  }

  console.log(`[Agent] 正在转发请求至: ${targetUrl}`);
  console.log(`[Agent] 请求体: ${JSON.stringify(body).substring(0, 200)}`);

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body)
  });

  return response;
}

export { sendMessages };
