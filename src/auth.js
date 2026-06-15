import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CONFIG_DIR = path.join(os.homedir(), '.zcode', 'cli');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

// 默认的 ZCode 映射配置
const PROVIDER_METADATA = {
  zai: {
    baseURL: 'https://api.z.ai/api/anthropic',
    displayName: 'Z.AI Coding Plan',
    mainModel: 'zai/glm-5.1',
    liteModel: 'zai/glm-4.7',
    models: {
      'glm-5.1': { name: 'GLM-5.1' },
      'glm-4.7': { name: 'GLM-4.7' }
    }
  },
  bigmodel: {
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    displayName: 'Bigmodel Coding Plan',
    mainModel: 'bigmodel/glm-5.1',
    liteModel: 'bigmodel/glm-4.7',
    models: {
      'glm-5.1': { name: 'GLM-5.1' },
      'glm-4.7': { name: 'GLM-4.7' }
    }
  }
};

/**
 * 读取本地 ~/.zcode/cli/config.json
 */
function readConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return {};
    }
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error('[Auth] 读取配置文件失败:', err.message);
    return {};
  }
}

/**
 * 写入本地配置文件，保证格式与 ZCode 代理兼容
 */
function writeConfig(config) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[Auth] 配置文件已更新:', CONFIG_PATH);
    return true;
  } catch (err) {
    console.error('[Auth] 写入配置文件失败:', err.message);
    return false;
  }
}

/**
 * 配置并更新 API Key 到配置文件中
 */
function configureApiKey(providerId, apiKey) {
  if (providerId !== 'zai' && providerId !== 'bigmodel') {
    throw new Error('不支持的 Provider ID: ' + providerId);
  }
  const config = readConfig();
  const meta = PROVIDER_METADATA[providerId];

  // 构建与 ZCode 结构完全吻合的 JSON 树
  const provider = config.provider || {};
  const currentProvider = provider[providerId] || {};
  const options = currentProvider.options || {};
  const models = currentProvider.models || {};

  options.apiKeyRequired = true;
  options.baseURL = meta.baseURL;
  if (apiKey) {
    options.apiKey = apiKey.trim();
  }

  const updatedModels = {
    ...models,
    'glm-5.1': { ...models['glm-5.1'], name: 'GLM-5.1' },
    'glm-4.7': { ...models['glm-4.7'], name: 'GLM-4.7' }
  };

  const model = config.model || {};
  const mainModel = model.main || meta.mainModel;
  const liteModel = model.lite || meta.liteModel;

  config.provider = {
    ...provider,
    [providerId]: {
      ...currentProvider,
      kind: 'anthropic',
      name: meta.displayName,
      options,
      models: updatedModels
    }
  };

  config.model = {
    ...model,
    main: mainModel,
    lite: liteModel
  };

  return writeConfig(config);
}

/**
 * 获取指定 provider 的 API Key
 */
function getApiKey(providerId) {
  const config = readConfig();
  return config.provider?.[providerId]?.options?.apiKey || null;
}

/**
 * 获取指定 provider 的 JWT Token (Coding Plan 用)
 * 优先使用 headless-credentials.json 中的最新 Token，
 * 该文件由 CloakBrowser 登录流程生成，Token 更新鲜且不易过期。
 */
function getJwtToken(providerId) {
  // 1. 优先尝试 headless-credentials.json（CloakBrowser 登录产物）
  if (providerId === 'zai') {
    try {
      const headlessPath = path.join(os.homedir(), '.zcode', 'headless-credentials.json');
      if (fs.existsSync(headlessPath)) {
        const headless = JSON.parse(fs.readFileSync(headlessPath, 'utf-8'));
        if (headless.zai_token) {
          return headless.zai_token;
        }
      }
    } catch (err) {
      // 读取失败时静默回退到 config.json
    }
  }

  // 2. 回退到 config.json 中的 jwtToken
  const config = readConfig();
  return config.provider?.[providerId]?.options?.jwtToken || null;
}

/**
 * 保存 JWT Token 到配置文件
 */
function saveJwtToken(providerId, jwtToken) {
  const config = readConfig();
  const provider = config.provider || {};
  const currentProvider = provider[providerId] || {};
  const options = currentProvider.options || {};

  options.jwtToken = jwtToken.trim();

  config.provider = {
    ...provider,
    [providerId]: {
      ...currentProvider,
      options
    }
  };

  return writeConfig(config);
}

/**
 * Z.AI 独有的 OAuth 流程
 */
class ZaiAuthFlow {
  constructor(apiBaseUrl = 'https://zcode.z.ai/api/v1') {
    this.apiBaseUrl = apiBaseUrl;
    this.pollToken = crypto.randomBytes(32).toString('hex');
  }

  async init() {
    console.log('[Auth] 正在向 Z.AI 发起 OAuth 初始化请求...');
    const url = `${this.apiBaseUrl}/oauth/cli/init`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.pollToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ provider: 'zai' })
    });

    if (!response.ok) {
      throw new Error(`初始化失败: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    const flowId = json.data?.flow_id;
    const authorizeUrl = json.data?.authorize_url;

    if (!flowId || !authorizeUrl) {
      throw new Error('返回的 OAuth 流程数据不完整');
    }

    return {
      flowId,
      authorizeUrl
    };
  }

  async poll(flowId) {
    const url = `${this.apiBaseUrl}/oauth/cli/poll/${encodeURIComponent(flowId)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.pollToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`轮询失败: ${response.status}`);
    }

    const json = await response.json();
    return json.data; // 返回结构通常包含 status: "ready" | "pending"
  }

  /**
   * 将 OAuth Access Token 兑换为业务 Token，并拉取 API Key
   * 同时保存 zcodejwttoken 供 Coding Plan 使用
   * @param {string} accessToken - zai.access_token (OAuth 业务 token, 1h 过期)
   * @param {string} [zcodeJwtToken] - poll 返回的 token 字段 (zcodejwttoken, 无过期)
   */
  async exchangeAndSaveKey(accessToken, zcodeJwtToken) {
    // 保存 zcodejwttoken (Coding Plan 认证用，无过期)
    if (zcodeJwtToken) {
      saveJwtToken('zai', zcodeJwtToken);
      console.log('[Auth] zcodejwttoken 已保存 (Coding Plan 认证，无过期)');
    }

    console.log('[Auth] 登录成功，正在获取 Z.AI 业务凭证...');
    const bizToken = await this._fetchBizToken(accessToken);
    const { orgId, projId } = await this._getOrgAndProject(bizToken);
    const fullKey = await this._getOrCreateApiKey(bizToken, orgId, projId);
    configureApiKey('zai', fullKey);
    console.log('[Auth] Z.AI 登录与密钥配置成功！');
    return fullKey;
  }

  async _fetchBizToken(accessToken) {
    const loginRes = await fetch('https://api.z.ai/api/auth/z/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: accessToken })
    });
    if (!loginRes.ok) throw new Error('兑换业务 Token 失败');
    const loginJson = await loginRes.json();
    const bizToken = loginJson.data?.access_token || loginJson.data?.accessToken;
    if (!bizToken) throw new Error('返回数据中不含业务凭证');
    return bizToken;
  }

  async _getOrgAndProject(bizToken) {
    console.log('[Auth] 正在查询项目列表...');
    const infoRes = await fetch('https://api.z.ai/api/biz/customer/getCustomerInfo', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${bizToken}` }
    });
    if (!infoRes.ok) throw new Error('查询机构信息失败');
    const infoJson = await infoRes.json();

    const orgs = infoJson.data?.organizations || [];
    const targetOrg = orgs.find(o => o.organizationName?.includes('默认机构')) || orgs[0];
    if (!targetOrg) throw new Error('找不到可用的机构');

    const projects = targetOrg.projects || [];
    const targetProj = projects.find(p => p.projectName?.includes('默认项目')) || projects[0];
    if (!targetProj) throw new Error('找不到可用的项目');

    console.log(`[Auth] 使用机构: ${targetOrg.organizationName}，项目: ${targetProj.projectName}`);
    return { orgId: targetOrg.organizationId, projId: targetProj.projectId };
  }

  async _getOrCreateApiKey(bizToken, orgId, projId) {
    const keyUrl = `https://api.z.ai/api/biz/v1/organization/${orgId}/projects/${projId}/api_keys`;
    const keysRes = await fetch(keyUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${bizToken}` }
    });
    if (!keysRes.ok) throw new Error('查询 API Keys 失败');
    const keysJson = await keysRes.json();
    const keys = keysJson.data || [];

    let keyObj = keys.find(k => k.name === 'zcode-api-key');
    if (!keyObj) {
      console.log('[Auth] zcode-api-key 不存在，正在为您创建...');
      const createRes = await fetch(keyUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${bizToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'zcode-api-key' })
      });
      if (!createRes.ok) throw new Error('创建 API Key 失败');
      const createJson = await createRes.json();
      keyObj = createJson.data;
    }

    const apiKey = keyObj?.apiKey;
    if (!apiKey) throw new Error('获取 API Key 失败');

    console.log('[Auth] 正在解密复制 Secret Key...');
    const copyRes = await fetch(`${keyUrl}/copy/${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${bizToken}` }
    });
    if (!copyRes.ok) throw new Error('获取 Secret Key 失败');
    const copyJson = await copyRes.json();
    const secretKey = copyJson.data?.secretKey;
    if (!secretKey) throw new Error('未能解密 Secret Key');

    return `${apiKey}.${secretKey}`;
  }
}

export {
  readConfig,
  writeConfig,
  configureApiKey,
  getApiKey,
  getJwtToken,
  saveJwtToken,
  ZaiAuthFlow
};
