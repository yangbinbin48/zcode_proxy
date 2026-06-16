export default {
  port: parseInt(process.env.ZCODE_PORT || '3000', 10),

  // 验证码缓存时长 (ms)
  captchaCacheTTL: parseInt(process.env.CAPTCHA_CACHE_TTL || '45000', 10),
  // Captcha 配置缓存时长 (ms)
  captchaConfigCacheTTL: parseInt(process.env.CAPTCHA_CONFIG_CACHE_TTL || '600000', 10),

  // ZCode 应用版本号
  appVersion: process.env.ZCODE_APP_VERSION || '3.1.0',

  upstream: {
    zai: process.env.ZAI_UPSTREAM_URL || 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages',
    zaiFallback: process.env.ZAI_FALLBACK_URL || 'https://api.z.ai/api/anthropic/v1/messages',
    bigmodel: process.env.BIGMODEL_UPSTREAM_URL || 'https://open.bigmodel.cn/api/anthropic/v1/messages',
  },

  userAgent: process.env.UPSTREAM_USER_AGENT || 'ZCode/3.1.0',
};
