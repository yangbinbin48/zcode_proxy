#!/usr/bin/env node

import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';
import * as auth from './auth.js';
import { startServer } from './server.js';
import browser from './browser.js';

const args = process.argv.slice(2);
const command = args[0];

// 简易终端颜色辅助
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function printUsage() {
  console.log(`\n${colors.bold}${colors.cyan}ZCode API 桥接网关 - 命令行工具${colors.reset}`);
  console.log(`\n使用方法:`);
  console.log(`  node src/cli.js serve [--port <端口>]         启动 API 桥接网关服务器 (默认端口 3000)`);
  console.log(`  node src/cli.js login zai                     通过官方 OAuth 授权登录 Z.AI 账号`);
  console.log(`  node src/cli.js import-auth                   导入当前目录下的 zcode_oauth_result.json 认证文件`);
  console.log(`  node src/cli.js set-key zai <APIKEY>          手动保存/覆盖 Z.AI 的 API Key`);
  console.log(`  node src/cli.js set-key bigmodel <APIKEY>     手动保存/覆盖 BigModel (智谱) 的 API Key`);
  console.log(`  node src/cli.js status                        查看当前网关的配置与密钥状态
  node src/cli.js quota                         查看当前的 Coding Plan 实时额度及余额
`);
}

async function handleLogin() {
  const provider = args[1];
  if (provider !== 'zai') {
    console.log(`${colors.red}目前命令行仅支持 'zai' (Z.AI) 自动 OAuth 登录。${colors.reset}`);
    console.log(`对于 BigModel，请使用: ${colors.yellow}node src/cli.js set-key bigmodel <api_key>${colors.reset} 进行配置。`);
    return;
  }

  const flow = new auth.ZaiAuthFlow();
  try {
    const { flowId, authorizeUrl } = await flow.init();
    console.log(`\n${colors.green}✔ OAuth 初始化成功！${colors.reset}`);
    console.log(`-----------------------------------------------------------------`);
    console.log(`正在通过 CloakBrowser 自动完成授权...`);
    console.log(`${colors.bold}${colors.blue}${authorizeUrl}${colors.reset}`);
    console.log(`-----------------------------------------------------------------`);

    // 直接打印 URL，用户自行在浏览器中打开授权
    console.log('请在浏览器中打开上方链接完成授权...');

    // 开始轮询状态
    let pollAttempts = 0;
    const maxPolls = 100;
    const interval = 2000;

    const pollTimer = setInterval(async () => {
      pollAttempts++;
      if (pollAttempts > maxPolls) {
        clearInterval(pollTimer);
        console.log(`${colors.red}❌ 登录超时，请重试。${colors.reset}`);
        return;
      }

      try {
        const data = await flow.poll(flowId);
        if (data.status === 'ready') {
          clearInterval(pollTimer);
          const accessToken = data.zai?.access_token;
          const zcodeJwtToken = data.token; // zcodejwttoken (无过期)
          if (!accessToken) {
            console.log(`${colors.red}❌ 未能在授权凭证中找到 Access Token${colors.reset}`);
            return;
          }
          try {
            const fullKey = await flow.exchangeAndSaveKey(accessToken, zcodeJwtToken);
            console.log(`\n${colors.green}✔ 登录成功！${colors.reset}`);
            console.log(`zcodejwt  : ${colors.cyan}已保存 (Coding Plan 模式，无过期)${colors.reset}`);
            console.log(`API Key   : ${colors.cyan}${fullKey.substring(0, 8)}...${colors.reset}\n`);
          } catch (err) {
            console.error(`\n${colors.red}❌ 兑换 API Key 失败:${colors.reset}`, err.message);
          }
        } else if (data.status === 'failed') {
          clearInterval(pollTimer);
          console.log(`${colors.red}❌ 授权失败或被拒绝。${colors.reset}`);
        }
      } catch (err) {
        // 忽略单次网络闪断
      }
    }, interval);

  } catch (err) {
    console.error(`${colors.red}❌ 登录初始化失败:${colors.reset}`, err.message);
  }
}

function handleSetKey() {
  const provider = args[1];
  const key = args[2];

  if (!provider || !key) {
    console.log(`${colors.red}❌ 参数错误。格式: node src/cli.js set-key <zai|bigmodel> <API_KEY>${colors.reset}`);
    return;
  }

  try {
    auth.configureApiKey(provider, key);
    console.log(`\n${colors.green}✔ 成功更新 ${provider} 的 API Key 凭证！${colors.reset}\n`);
  } catch (err) {
    console.error(`${colors.red}❌ 保存凭证失败:${colors.reset}`, err.message);
  }
}

function handleStatus() {
  const zaiKey = auth.getApiKey('zai');
  const zaiJwt = auth.getJwtToken('zai');
  const bmKey = auth.getApiKey('bigmodel');

  console.log(`\n${colors.bold}${colors.cyan}--- 当前密钥状态 ---${colors.reset}`);
  console.log(`Z.AI JWT  : ${zaiJwt ? `${colors.green}已配置 (Coding Plan 可用)${colors.reset}` : `${colors.yellow}未配置${colors.reset}`}`);
  console.log(`Z.AI Key  : ${zaiKey ? `${colors.green}已配置 (${zaiKey.substring(0, 8)}...)${colors.reset}` : `${colors.yellow}未配置${colors.reset}`}`);
  console.log(`BigModel  : ${bmKey ? `${colors.green}已配置 (${bmKey.substring(0, 8)}...)${colors.reset}` : `${colors.yellow}未配置${colors.reset}`}`);
  console.log(`配置文件   : ${colors.blue}${path.join(os.homedir(), '.zcode', 'cli', 'config.json')}${colors.reset}`);
  console.log(`当前模式   : ${zaiJwt ? `${colors.green}Coding Plan (试用额度可用)${colors.reset}` : `${colors.yellow}API Key (无试用额度)${colors.reset}`}\n`);
}

async function handleQuota() {
  const zaiJwt = auth.getJwtToken('zai');
  const zaiKey = auth.getApiKey('zai');

  if (!zaiJwt && !zaiKey) {
    console.log(`${colors.red}❌ 未配置认证信息，请先使用 login 或 set-key 完成登录。${colors.reset}`);
    return;
  }

  console.log(`\n${colors.bold}${colors.cyan}正在从 ZCode 官方拉取实时额度及余额数据...${colors.reset}`);
  
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (zaiJwt) {
      headers['Authorization'] = `Bearer ${zaiJwt}`;
    } else {
      headers['x-api-key'] = zaiKey;
    }

    const [currentRes, balanceRes] = await Promise.all([
      fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/current', { headers }),
      fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', { headers }).catch(() => null)
    ]);

    if (!currentRes.ok) {
      console.log(`${colors.red}❌ 接口请求失败 (HTTP ${currentRes.status})${colors.reset}`);
      return;
    }

    const currentData = await currentRes.json();
    console.log(`\n${colors.bold}${colors.green}--- 当前激活方案 ---${colors.reset}`);
    const plans = currentData.data?.plans || [];
    if (plans.length === 0) {
      console.log('无活跃方案');
    } else {
      plans.forEach(plan => {
        console.log(`方案名称: ${colors.cyan}${plan.name}${colors.reset}`);
        console.log(`方案说明: ${plan.description}`);
        console.log(`有效期限: ${new Date(plan.starts_at * 1000).toLocaleDateString()} 至 ${new Date(plan.ends_at * 1000).toLocaleDateString()}`);
      });
    }

    if (balanceRes && balanceRes.ok) {
      const balanceData = await balanceRes.json();
      console.log(`\n${colors.bold}${colors.green}--- 实时额度余额 (Tokens) ---${colors.reset}`);
      const balances = balanceData.data?.balances || [];
      if (balances.length === 0) {
        console.log('未查询到具体模型余额');
      } else {
        balances.forEach(bal => {
          const usedPercent = ((bal.used_units / bal.total_units) * 100).toFixed(2);
          console.log(`\n${colors.bold}模型: ${colors.cyan}${bal.show_name}${colors.reset}`);
          console.log(`  总额度: ${bal.total_units.toLocaleString()}`);
          console.log(`  已使用: ${bal.used_units.toLocaleString()} (${usedPercent}%)`);
          console.log(`  剩余额度: ${colors.green}${bal.remaining_units.toLocaleString()}${colors.reset}`);
          console.log(`  重置时间: ${new Date(bal.expires_at * 1000).toLocaleString()}`);
        });
      }
    } else {
      console.log(`${colors.yellow}⚠️ 无法获取实时余额细则。${colors.reset}`);
    }
    console.log();
  } catch (err) {
    console.error(`${colors.red}❌ 查询异常:${colors.reset}`, err.message);
  }
}

async function handleImportAuth() {
  const { default: fs } = await import('node:fs');
  const resultPath = path.join(process.cwd(), 'zcode_oauth_result.json');
  if (!fs.existsSync(resultPath)) {
    console.log(`${colors.red}❌ 未能在当前目录下找到 zcode_oauth_result.json 文件。${colors.reset}`);
    return;
  }

  try {
    const content = fs.readFileSync(resultPath, 'utf-8');
    const json = JSON.parse(content);
    const accessToken = json.zai?.access_token;
    const zcodeJwtToken = json.token; // zcodejwttoken (无过期)
    if (!accessToken) {
      console.log(`${colors.red}❌ JSON 文件中不含 zai.access_token 字段。${colors.reset}`);
      return;
    }

    console.log(`${colors.green}✔ 找到凭证，正在保存 zcodejwt 并兑换 API Key...${colors.reset}`);
    const flow = new auth.ZaiAuthFlow();
    const fullKey = await flow.exchangeAndSaveKey(accessToken, zcodeJwtToken);
    console.log(`\n${colors.green}✔ 导入成功！${colors.reset}`);
    console.log(`JWT Token : ${colors.cyan}已保存 (Coding Plan 模式)${colors.reset}`);
    console.log(`API Key   : ${colors.cyan}${fullKey.substring(0, 8)}...${colors.reset}\n`);
  } catch (err) {
    console.error(`${colors.red}❌ 导入失败:${colors.reset}`, err.message);
  }
}

function handleServe() {
  let port = parseInt(process.env.ZCODE_PORT || '3000', 10);
  const portIdx = args.indexOf('--port');
  if (portIdx !== -1 && args[portIdx + 1]) {
    const p = parseInt(args[portIdx + 1], 10);
    if (!isNaN(p)) port = p;
  }
  startServer(port);
}

// 主路由分发
async function main() {
  if (!command) {
    printUsage();
    return;
  }

  switch (command) {
    case 'serve':
      handleServe();
      break;
    case 'login':
      await handleLogin();
      break;
    case 'set-key':
      handleSetKey();
      break;
    case 'import-auth':
      await handleImportAuth();
      break;
    case 'status':
      handleStatus();
      break;
    case 'quota':
      await handleQuota();
      break;
    default:
      console.log(`${colors.red}❌ 未知命令: ${command}${colors.reset}`);
      printUsage();
      break;
  }
}

main();
