import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMessages } from './agent.js';
import browser from './browser.js';
import config from './config.js';
import { CaptchaManager } from './captcha-manager.js';
import { getJwtToken, getApiKey } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));

// 静态托管前端页面
app.use(express.static(path.join(__dirname, '..', 'public')));

// 验证码管理器实例
const captchaManager = new CaptchaManager();

// 根路由及验证入口重定向
app.get('/captcha', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'captcha.html'));
});

// 接口：提供给前端的 Captcha 初始化参数
app.get('/api/captcha/config', async (req, res) => {
  try {
    const captchaConfig = await captchaManager.fetchCaptchaConfig();
    res.json(captchaConfig);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 接口：查询 Coding Plan 额度与余额
app.get('/api/quota', async (req, res) => {
  const jwtToken = getJwtToken('zai');
  const apiKey = getApiKey('zai');

  if (!jwtToken && !apiKey) {
    return res.status(401).json({ error: '未配置认证信息，请先登录' });
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (jwtToken) {
      headers['Authorization'] = `Bearer ${jwtToken}`;
    } else {
      headers['x-api-key'] = apiKey;
    }

    const [billingRes, balanceRes, usageRes] = await Promise.all([
      fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/current', { headers }),
      fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', { headers }).catch(() => null),
      fetch('https://zcode.z.ai/api/v1/zcode-plan/usage', { headers }).catch(() => null),
    ]);

    const result = {};

    if (billingRes.ok) {
      result.billing = await billingRes.json();
    } else {
      result.billing = { error: `HTTP ${billingRes.status}` };
    }

    if (balanceRes?.ok) {
      result.balance = await balanceRes.json();
    }

    if (usageRes?.ok) {
      result.usage = await usageRes.json();
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 接口：前端滑块通过后 POST 回传凭证
app.post('/api/captcha/submit', (req, res) => {
  const { verifyParam } = req.body;
  if (!verifyParam) {
    return res.status(400).json({ error: 'verifyParam 不能为空' });
  }

  captchaManager.submit(verifyParam);
  res.json({ success: true, message: '回调接收成功' });
});

// Z.AI 上游模型名大小写敏感，需精确映射
const MODEL_NAME_MAP = {
  'glm-5.2':     'GLM-5.2',
  'glm-5.1':     'GLM-5.1',
  'glm-5-turbo': 'GLM-5-Turbo',
  'glm-4.7':     'GLM-4.7',
};

/**
 * 判断 403 响应是否为验证码失效
 */
async function isCaptchaError(response) {
  try {
    const clone = response.clone();
    const text = await clone.text();
    return text.toLowerCase().includes('captcha')
      || text.includes('verify token')
      || text.includes('verify failed');
  } catch {
    return false;
  }
}

/**
 * 管道式转发上游响应到客户端
 */
async function pipeResponse(apiResponse, res, body) {
  res.status(apiResponse.status);

  const contentType = apiResponse.headers.get('content-type') || '';
  if (contentType) res.setHeader('content-type', contentType);

  const isStream = contentType.includes('event-stream') || body?.stream === true;

  if (isStream) {
    console.log('[Server] 开启 SSE 流式数据管道转发...');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      for await (const chunk of apiResponse.body) {
        res.write(chunk);
      }
    } catch (err) {
      console.error('[Server] 流传输中断:', err.message);
    } finally {
      res.end();
    }
  } else {
    try {
      const data = await apiResponse.json();
      res.json(data);
    } catch {
      const text = await apiResponse.text();
      res.send(text);
    }
  }
}

// 核心接口：兼容 Anthropic Messages 协议的网关接口
app.post('/v1/messages', async (req, res) => {
  const body = req.body;
  const modelName = body.model || '';

  // 识别 Provider
  let providerId = 'zai';
  if (modelName.startsWith('bigmodel/') || req.headers['x-provider'] === 'bigmodel') {
    providerId = 'bigmodel';
  }

  // 剥离前缀 (例如 'zai/glm-5.2' -> 'glm-5.2')
  if (typeof body.model === 'string' && body.model.includes('/')) {
    body.model = body.model.split('/').slice(1).join('/');
  }

  // 模型名映射（case-insensitive）
  if (typeof body.model === 'string') {
    const lower = body.model.toLowerCase();
    body.model = MODEL_NAME_MAP[lower] || body.model;
  }

  // Z.AI 上游仅接受块数组格式的 content，自动桥接纯字符串
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(msg => {
      if (typeof msg.content === 'string') {
        return { ...msg, content: [{ type: 'text', text: msg.content }] };
      }
      return msg;
    });
  }

  console.log(`[Server] 收到请求: model=${body.model}, provider=${providerId}`);

  const port = req.app.get('port') || config.port;
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let verifyParam;
    try {
      verifyParam = await captchaManager.getVerifyParam(port);
    } catch (err) {
      console.error('[Server] 获取验证凭证出错:', err.message);
      return res.status(500).json({
        error: { message: `无法完成人机校验: ${err.message}`, type: 'captcha_error' }
      });
    }

    let apiResponse;
    try {
      apiResponse = await sendMessages(providerId, body, verifyParam, req.headers);
    } catch (err) {
      console.error('[Server] 转发请求失败:', err.message);
      return res.status(500).json({
        error: { message: `网关转发异常: ${err.message}`, type: 'api_error' }
      });
    }

    // 判断是否验证码过期
    if (apiResponse.status === 403 && await isCaptchaError(apiResponse)) {
      console.warn(`[Server] 第 ${attempt}/${MAX_RETRIES} 次验证码失效，刷新重试...`);
      captchaManager.invalidate();
      continue;
    }

    // 成功或非验证码错误，转发给客户端
    return pipeResponse(apiResponse, res, body);
  }

  // 所有重试都失败
  return res.status(403).json({
    error: {
      message: '验证码多次失效，请检查浏览器或重启服务',
      type: 'captcha_expired'
    }
  });
});

// 开启服务
function startServer(port = config.port) {
  app.set('port', port);
  const server = app.listen(port, () => {
    console.log(`===================================================`);
    console.log(` ZCode API 桥接网关服务器已在本地启动！`);
    console.log(` 监听端口: http://localhost:${port}`);
    console.log(` 标准对话端点: http://localhost:${port}/v1/messages`);
    console.log(` 验证引擎: CloakBrowser (持久页面模式)`);
    console.log(`===================================================`);
  });

  // 优雅退出
  const shutdown = async () => {
    console.log('\n[Server] 正在关闭...');
    await captchaManager.close();
    await browser.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

export { startServer };
