# ZCode API Bridge Gateway

将 ZCode (zcode.z.ai) Coding Plan 额度转为标准 Anthropic Messages API，支持自动阿里云无痕验证。

## 快速开始

```bash
cp .env.example .env    # 编辑配置
npm install
node src/cli.js serve   # 或 npm start
```

服务默认监听 `http://localhost:3000`，对话端点 `/v1/messages`。

## 使用

```bash
# 启动服务
node src/cli.js serve [--port 3000]

# OAuth 登录 Z.AI（获取 Coding Plan 额度）
node src/cli.js login zai

# 导入已有的 OAuth 凭证
node src/cli.js import-auth

# 手动设置 API Key
node src/cli.js set-key zai <API_KEY>

# 查看当前状态
node src/cli.js status
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ZCODE_PORT` | 3000 | 服务端口 |
| `CAPTCHA_CACHE_TTL` | 45000 | 验证码缓存时长 (ms) |
| `CAPTCHA_CONFIG_CACHE_TTL` | 600000 | Captcha 配置缓存时长 (ms) |
| `ZAI_UPSTREAM_URL` | zcode.z.ai/... | Z.AI Coding Plan 端点 |
| `ZAI_FALLBACK_URL` | api.z.ai/... | Z.AI API Key 端点 |
| `BIGMODEL_UPSTREAM_URL` | open.bigmodel.cn/... | BigModel 端点 |

## 项目结构

```
├── src/
│   ├── cli.js              # CLI 入口
│   ├── server.js           # Express 路由 + 网关逻辑
│   ├── agent.js            # 上游请求转发
│   ├── auth.js             # OAuth + API Key 管理
│   ├── browser.js          # CloakBrowser 浏览器管理
│   ├── captcha-manager.js  # 验证码生命周期（持久页面 + 自动续期）
│   └── config.js           # 配置读取
├── public/
│   └── captcha.html        # 验证页面（阿里云无痕 SDK）
├── package.json
├── .env.example
└── .gitignore
```

## 技术栈

- Node.js 18+ (ESM)
- Express
- CloakBrowser (Playwright 内置反检测)
- 阿里云无痕验证 SDK
