import { launch as cbLaunch } from 'cloakbrowser';
import path from 'node:path';
import os from 'node:os';

const USER_DATA_DIR = path.join(os.homedir(), '.cloakbrowser', 'profiles', 'zcode');

let browserInstance = null;
let currentMode = null;

/**
 * 启动 CloakBrowser 实例
 * @param {object} opts
 * @param {boolean} opts.headless - 是否无头模式（默认 true）
 * @returns {Promise<import('cloakbrowser').Browser>}
 */
async function launch(opts = {}) {
  const headless = opts.headless !== false;
  const requestedMode = headless ? 'headless' : 'headed';

  // 检查现有实例是否还活着
  if (browserInstance && currentMode === requestedMode) {
    try {
      browserInstance.contexts();
      return browserInstance;
    } catch {
      browserInstance = null;
    }
  }

  // 模式不匹配，先关闭现有实例
  if (browserInstance) {
    console.log(`[Browser] 模式切换 ${currentMode} → ${requestedMode}，重启...`);
    await close();
  }

  console.log(`[Browser] 正在启动 CloakBrowser (${headless ? '无头' : '有头'})...`);

  browserInstance = await cbLaunch({
    headless,
    userDataDir: USER_DATA_DIR,
    args: ['--no-sandbox', '--no-first-run', '--disable-default-apps'],
  });

  browserInstance.on('disconnected', () => {
    console.log('[Browser] 实例断开连接');
    browserInstance = null;
    currentMode = null;
  });

  currentMode = requestedMode;
  return browserInstance;
}

/**
 * 打开新页面并导航到指定 URL
 * @param {string} url
 * @param {object} opts
 * @param {boolean} opts.headless - 是否无头（默认 true）
 * @returns {Promise<import('playwright-core').Page>}
 */
async function newPage(url, opts = {}) {
  const browser = await launch(opts);
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();

  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }
  return page;
}

/**
 * 关闭浏览器实例
 */
async function close() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (e) { /* ignore */ }
    browserInstance = null;
    currentMode = null;
  }
}

export default { launch, newPage, close };
