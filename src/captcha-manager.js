import browser from './browser.js';
import config from './config.js';

/**
 * 验证码生命周期管理器
 * - 持久化页面：首次验证后保持页面常驻，过期时通过 evaluate 重置 SDK
 * - 并发排队：多个请求共享同一个 verifyParam，不重复触发验证
 * - 自动续期：403 时 invalidate + 重新验证
 */
export class CaptchaManager {
  constructor() {
    this.cachedVerifyParam = null;
    this.pendingPromise = null;
    this.resolveCallback = null;
    this.rejectCallback = null;
    this.captchaPage = null;

    // Captcha 配置缓存
    this.captchaConfigCache = null;
    this.captchaConfigCacheTime = 0;
  }

  /**
   * 从 ZCode 拉取 captcha 配置 (prefix/region/sceneId)
   */
  async fetchCaptchaConfig() {
    const now = Date.now();
    if (this.captchaConfigCache && now - this.captchaConfigCacheTime < config.captchaConfigCacheTTL) {
      return this.captchaConfigCache;
    }

    try {
      console.log('[Captcha] 正在从 ZCode 官方拉取最新配置...');
      const res = await fetch(`https://zcode.z.ai/api/v1/client/configs?app_version=${config.appVersion}&platform=win32`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const captchaConfig = json.data?.configs?.captcha;
      if (captchaConfig) {
        this.captchaConfigCache = captchaConfig;
        this.captchaConfigCacheTime = now;
        return captchaConfig;
      }
    } catch (err) {
      console.error('[Captcha] 获取配置失败, 使用默认:', err.message);
    }

    // 默认兜底
    return {
      enabled: true,
      prefix: 'no8xfe',
      region: 'sgp',
      sceneId: '11xygtvd'
    };
  }

  /**
   * 确保验证页面常驻 — 首次打开，后续通过 CDP 重置 SDK
   */
  async ensureVerificationPage(port) {
    if (this.captchaPage && !this.captchaPage.isClosed()) {
      // 复用已有页面，重置 SDK
      try {
        console.log('[Captcha] 复用已有页面，重置 SDK...');
        await this.captchaPage.evaluate(() => {
          if (typeof window.__resetCaptcha === 'function') {
            return window.__resetCaptcha();
          }
        });
        return;
      } catch (err) {
        console.warn('[Captcha] 页面 evaluate 失败，重新打开:', err.message);
        try { await this.captchaPage.close(); } catch {}
        this.captchaPage = null;
      }
    }

    // 打开新页面
    console.log('[Captcha] 正在打开验证页面...');
    const browserInstance = await browser.launch();
    const context = browserInstance.contexts()[0] || await browserInstance.newContext();
    this.captchaPage = await context.newPage();
    await this.captchaPage.goto(`http://localhost:${port}/captcha`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    this.captchaPage.on('close', () => {
      console.log('[Captcha] 验证页面已关闭');
      this.captchaPage = null;
    });
  }

  /**
   * 获取验证参数 — 有缓存直接返回，没有则触发验证并阻塞等待
   */
  async getVerifyParam(port) {
    if (this.cachedVerifyParam) {
      return this.cachedVerifyParam;
    }

    // 并发排队：已有请求在等，共享同一个 promise
    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    this.pendingPromise = new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;
    });

    // 触发验证
    this.ensureVerificationPage(port).catch(err => {
      console.error('[Captcha] 浏览器启动失败:', err.message);
      if (this.rejectCallback) {
        this.rejectCallback(new Error('浏览器启动失败: ' + err.message));
        this.pendingPromise = null;
        this.resolveCallback = null;
        this.rejectCallback = null;
      }
    });

    return this.pendingPromise;
  }

  /**
   * 浏览器页面回传验证参数
   */
  submit(verifyParam) {
    console.log('[Captcha] 收到验证参数，长度:', verifyParam.length);

    if (this.resolveCallback) {
      this.resolveCallback(verifyParam);
      this.pendingPromise = null;
      this.resolveCallback = null;
      this.rejectCallback = null;
    }

    // 缓存，应对并发请求
    this.cachedVerifyParam = verifyParam;
    this._clearCacheTimer = setTimeout(() => {
      this.cachedVerifyParam = null;
    }, config.captchaCacheTTL);
  }

  /**
   * 失效当前缓存（403 时调用）
   */
  invalidate() {
    console.log('[Captcha] 验证参数已失效');
    this.cachedVerifyParam = null;
    if (this._clearCacheTimer) {
      clearTimeout(this._clearCacheTimer);
      this._clearCacheTimer = null;
    }
  }

  /**
   * 关闭持久化页面
   */
  async close() {
    if (this.captchaPage) {
      try { await this.captchaPage.close(); } catch {}
      this.captchaPage = null;
    }
  }
}
