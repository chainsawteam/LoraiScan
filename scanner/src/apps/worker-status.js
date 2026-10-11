#!/usr/bin/env node

const { spawnSync } = require('child_process');

const DEFAULT_SERVICES = [
  { chain: 'BSC', service: 'scan-bsc' },
  { chain: 'ETH', service: 'scan-eth' },
  { chain: 'BASE', service: 'scan-base' },
  { chain: 'ARB', service: 'scan-arb' },
  { chain: 'ROBIN', service: 'scan-robin' }
];

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  gray: '\x1b[90m'
};

function parseArgs(argv) {
  const args = {
    since: '24h',
    recent: '30m',
    services: DEFAULT_SERVICES,
    json: false,
    color: process.stdout.isTTY && !process.env.NO_COLOR
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--since' && next) {
      args.since = next;
      i += 1;
    } else if (arg === '--recent' && next) {
      args.recent = next;
      i += 1;
    } else if (arg === '--services' && next) {
      const requested = new Set(next.split(',').map(item => item.trim().toLowerCase()).filter(Boolean));
      args.services = DEFAULT_SERVICES.filter(item => requested.has(item.chain.toLowerCase()) || requested.has(item.service.toLowerCase()));
      i += 1;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--no-color') {
      args.color = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`用法: node src/apps/worker-status.js [options]

参数:
  --since <duration>      主统计窗口，默认 24h
  --recent <duration>     健康检查窗口，默认 30m
  --services <list>       逗号分隔: bsc,eth,base,arb,robin 或 scan-bsc,...
  --json                  输出 JSON，方便脚本处理
  --no-color              关闭颜色，只保留边框排版

示例:
  npm run worker:status
  npm run worker:status -- --since 6h --services bsc,eth,arb
  node src/apps/worker-status.js --since 24h --json`);
}

function runCompose(args, options = {}) {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...options
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error
  };
}

function parseEnv(output) {
  const env = {};
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) {
      continue;
    }
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function maskUrl(value) {
  if (!value) {
    return '';
  }
  try {
    const url = new URL(value);
    const localHost = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.)/.test(url.hostname);
    if (localHost || !url.pathname || url.pathname === '/') {
      return value;
    }
    return `${url.protocol}//${url.host}/...`;
  } catch (_) {
    return value;
  }
}

function emptyMetrics() {
  return {
    method: {
      subscriptions: 0,
      blocks: 0,
      matched: 0,
      qualified: 0,
      targetLogs: 0,
      uniqueTargets: new Set(),
      wouldScan: 0,
      uniqueWouldScan: new Set(),
      triggered: 0,
      uniqueTriggered: new Set(),
      cooldown: 0,
      uniqueCooldown: new Set(),
      existingAudit: 0,
      uniqueExistingAudit: new Set(),
      belowThreshold: 0,
      queueDrops: 0,
      timeouts: 0,
      errors: 0,
      methods: new Map(),
      triggerMethods: new Map(),
      skipReasons: new Map(),
      samples: []
    },
    token: {
      lines: 0,
      uniqueTokens: new Set(),
      triggered: 0,
      uniqueTriggered: new Set(),
      skipped: 0,
      uniqueSkipped: new Set(),
      aveFailures: 0,
      uniqueAveFailures: new Set(),
      skipReasons: new Map(),
      samples: []
    },
    events: {
      newPools: 0,
      liquidityMatches: 0,
      proxyUpgradeMatches: 0,
      proxyUpgradeTriggered: 0,
      flapFactoryEvents: 0,
      flapFactoryTriggered: 0,
      contractValueObserved: 0,
      contractValueQueueDrops: 0
    },
    subscriptions: {
      connected: 0,
      errors: 0
    },
    lines: 0
  };
}

function incMap(map, key) {
  if (!key) {
    return;
  }
  map.set(key, (map.get(key) || 0) + 1);
}

function pushSample(samples, line, limit = 8) {
  samples.push(line);
  if (samples.length > limit) {
    samples.shift();
  }
}

function matchAddress(line, key) {
  const match = line.match(new RegExp(`${key}=(0x[a-fA-F0-9]{40})`));
  return match ? match[1].toLowerCase() : '';
}

function parseLogs(logs) {
  const metrics = emptyMetrics();

  for (const rawLine of logs.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    metrics.lines += 1;

    if (line.includes('subscription connected')) {
      metrics.subscriptions.connected += 1;
    }
    if (line.includes('subscription error')) {
      metrics.subscriptions.errors += 1;
    }

    if (line.includes('method-call subscription connected')) {
      metrics.method.subscriptions += 1;
    }

    if (line.includes('method-call block=')) {
      const blockSummary = line.match(/method-call block=.*txs=(\d+).*matched=(\d+).*qualified=(\d+)/);
      if (blockSummary) {
        metrics.method.blocks += 1;
        metrics.method.matched += Number(blockSummary[2]);
        metrics.method.qualified += Number(blockSummary[3]);
      }
      if (line.includes('timeout')) {
        metrics.method.timeouts += 1;
      }
      if (line.includes('处理失败') || line.includes(' error') || line.includes(' Error') || line.includes('subscription error')) {
        metrics.method.errors += 1;
      }
    }

    if (line.includes('method-call queue 已满')) {
      metrics.method.queueDrops += 1;
    }
    if (line.includes('contract-value queue 已满')) {
      metrics.events.contractValueQueueDrops += 1;
    }
    if (line.includes('contract-value OBSERVE')) {
      metrics.events.contractValueObserved += 1;
    }

    if (line.includes('method-call target=')) {
      metrics.method.targetLogs += 1;
      const target = matchAddress(line, 'target');
      if (target) {
        metrics.method.uniqueTargets.add(target);
      }
      const methodMatch = line.match(/method=([^ ]+)/);
      const method = methodMatch ? methodMatch[1] : '';
      incMap(metrics.method.methods, method);

      const reasonMatch = line.match(/reason=([^ ]+)/);
      const reason = reasonMatch ? reasonMatch[1] : '';
      incMap(metrics.method.skipReasons, reason);

      if (line.includes('reason=audit_disabled')) {
        metrics.method.wouldScan += 1;
        if (target) {
          metrics.method.uniqueWouldScan.add(target);
        }
        pushSample(metrics.method.samples, line);
      }
      if (line.includes('LORAI 已触发')) {
        metrics.method.triggered += 1;
        incMap(metrics.method.triggerMethods, method);
        if (target) {
          metrics.method.uniqueTriggered.add(target);
        }
        pushSample(metrics.method.samples, line);
      }
      if (line.includes('reason=cooldown')) {
        metrics.method.cooldown += 1;
        if (target) {
          metrics.method.uniqueCooldown.add(target);
        }
      }
      if (line.includes('reason=existing_audit')) {
        metrics.method.existingAudit += 1;
        if (target) {
          metrics.method.uniqueExistingAudit.add(target);
        }
      }
      if (line.includes('跳过 valueUsd=')) {
        metrics.method.belowThreshold += 1;
      }
    }

    if (line.includes('discovery=') && line.includes('[subscribe] new-pool')) {
      metrics.events.newPools += 1;
    }
    if (line.includes('liquidity=') && line.includes('[subscribe] matched')) {
      metrics.events.liquidityMatches += 1;
    }
    if (line.includes('proxy-upgrade=') && (line.includes('matched') || line.includes('Upgraded'))) {
      metrics.events.proxyUpgradeMatches += 1;
    }
    if (line.includes('proxy-upgrade=') && line.includes('LORAI 已触发')) {
      metrics.events.proxyUpgradeTriggered += 1;
    }
    if (line.includes('flap-vault-factory factory=')) {
      metrics.events.flapFactoryEvents += 1;
      if (line.includes('LORAI 已触发')) {
        metrics.events.flapFactoryTriggered += 1;
      }
    }

    if (line.match(/token=0x[a-fA-F0-9]{40}/)) {
      metrics.token.lines += 1;
      const token = matchAddress(line, 'token');
      if (token) {
        metrics.token.uniqueTokens.add(token);
      }
      if (line.includes('LORAI 已触发')) {
        metrics.token.triggered += 1;
        if (token) {
          metrics.token.uniqueTriggered.add(token);
        }
        pushSample(metrics.token.samples, line);
      }
      if (line.includes('LORAI 跳过')) {
        metrics.token.skipped += 1;
        if (token) {
          metrics.token.uniqueSkipped.add(token);
        }
        const reasonMatch = line.match(/reason=([^ ]+)/);
        incMap(metrics.token.skipReasons, reasonMatch ? reasonMatch[1] : '');
      }
      if (line.includes('Ave 查询失败')) {
        metrics.token.aveFailures += 1;
        if (token) {
          metrics.token.uniqueAveFailures.add(token);
        }
      }
    }
  }

  return metrics;
}

function serializeMetrics(metrics) {
  return {
    method: {
      subscriptions: metrics.method.subscriptions,
      blocks: metrics.method.blocks,
      matched: metrics.method.matched,
      qualified: metrics.method.qualified,
      targetLogs: metrics.method.targetLogs,
      uniqueTargets: metrics.method.uniqueTargets.size,
      wouldScan: metrics.method.wouldScan,
      uniqueWouldScan: metrics.method.uniqueWouldScan.size,
      triggered: metrics.method.triggered,
      uniqueTriggered: metrics.method.uniqueTriggered.size,
      cooldown: metrics.method.cooldown,
      uniqueCooldown: metrics.method.uniqueCooldown.size,
      existingAudit: metrics.method.existingAudit,
      uniqueExistingAudit: metrics.method.uniqueExistingAudit.size,
      belowThreshold: metrics.method.belowThreshold,
      queueDrops: metrics.method.queueDrops,
      timeouts: metrics.method.timeouts,
      errors: metrics.method.errors,
      methods: Object.fromEntries(metrics.method.methods),
      triggerMethods: Object.fromEntries(metrics.method.triggerMethods),
      skipReasons: Object.fromEntries(metrics.method.skipReasons),
      samples: metrics.method.samples
    },
    token: {
      lines: metrics.token.lines,
      uniqueTokens: metrics.token.uniqueTokens.size,
      triggered: metrics.token.triggered,
      uniqueTriggered: metrics.token.uniqueTriggered.size,
      skipped: metrics.token.skipped,
      uniqueSkipped: metrics.token.uniqueSkipped.size,
      aveFailures: metrics.token.aveFailures,
      uniqueAveFailures: metrics.token.uniqueAveFailures.size,
      skipReasons: Object.fromEntries(metrics.token.skipReasons),
      samples: metrics.token.samples
    },
    events: metrics.events,
    subscriptions: metrics.subscriptions,
    lines: metrics.lines
  };
}

function statusFrom(service, env, recent) {
  if (!service.running) {
    return { level: 'DOWN', reason: '容器未运行' };
  }

  const prefix = service.chain;
  const methodEnabled = env[`${prefix}_METHOD_CALL_MONITOR_ENABLED`] !== '0';
  const subscribeEnabled = env[`${prefix}_METHOD_CALL_SUBSCRIBE_ENABLED`] !== '0';
  const issues = [];

  if (methodEnabled && subscribeEnabled && recent.method.blocks === 0) {
    issues.push('最近窗口没有处理 method-call 区块');
  }
  if (recent.method.queueDrops > 0) {
    issues.push(`method-call 队列丢弃=${recent.method.queueDrops}`);
  }
  if (recent.subscriptions.errors > 0 || recent.method.errors > 0) {
    issues.push(`最近错误=${recent.subscriptions.errors + recent.method.errors}`);
  }

  if (issues.length > 0) {
    return { level: 'WARN', reason: issues.join('; ') };
  }

  return { level: 'OK', reason: '最近日志正常' };
}

function inspectService(item, args) {
  const ps = runCompose(['ps', item.service]);
  const running = ps.ok && /\bUp\b/.test(ps.stdout);

  let env = {};
  if (running) {
    const envResult = runCompose([
      'exec',
      '-T',
      item.service,
      'sh',
      '-lc',
      `env | grep -E "^${item.chain}_(WS_RPC|RPC|LORAI_AUDIT_RPC_URL|LORAI_AUDIT_ENABLED|LORAI_AUDIT_MIN_LIQUIDITY_USD|METHOD_CALL_|PROXY_UPGRADE_|DISCOVERY_|SUBSCRIBE_ENABLED|LIQUIDITY_CALIBRATION_|FLAP_VAULT_)" | sort`
    ]);
    if (envResult.ok) {
      env = parseEnv(envResult.stdout);
    }
  }

  const logs = runCompose(['logs', '--since', args.since, item.service]);
  const recentLogs = runCompose(['logs', '--since', args.recent, item.service]);
  const metrics = parseLogs(logs.stdout);
  const recentMetrics = parseLogs(recentLogs.stdout);

  const service = {
    ...item,
    running,
    ps: ps.stdout.trim(),
    psError: ps.stderr.trim(),
    env,
    metrics: serializeMetrics(metrics),
    recent: serializeMetrics(recentMetrics)
  };
  service.health = statusFrom({ ...item, running }, env, recentMetrics);
  return service;
}

function pad(value, width) {
  return padEndDisplay(value, width);
}

function paint(text, color, enabled = true) {
  if (!enabled || !color || !ANSI[color]) {
    return String(text);
  }
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, '');
}

function charWidth(char) {
  const code = char.codePointAt(0);
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(value) {
  let width = 0;
  for (const char of stripAnsi(value)) {
    width += charWidth(char);
  }
  return width;
}

function truncateDisplay(value, width) {
  const text = String(value);
  if (displayWidth(text) <= width) {
    return text;
  }

  let used = 0;
  let output = '';
  for (const char of stripAnsi(text)) {
    const next = charWidth(char);
    if (used + next > width - 1) {
      break;
    }
    output += char;
    used += next;
  }
  return `${output}…`;
}

function padEndDisplay(value, width) {
  const text = truncateDisplay(value, width);
  const missing = width - displayWidth(text);
  return `${text}${' '.repeat(Math.max(0, missing))}`;
}

function padStartDisplay(value, width) {
  const text = truncateDisplay(value, width);
  const missing = width - displayWidth(text);
  return `${' '.repeat(Math.max(0, missing))}${text}`;
}

function healthLabel(level) {
  if (level === 'OK') {
    return '正常';
  }
  if (level === 'WARN') {
    return '警告';
  }
  if (level === 'DOWN') {
    return '停止';
  }
  return level;
}

function coloredHealth(level, color) {
  return paint(healthLabel(level), level === 'OK' ? 'green' : level === 'WARN' ? 'yellow' : 'red', color);
}

function yesNo(value) {
  if (value === '1' || value === true) {
    return '是';
  }
  if (value === '0' || value === false) {
    return '否';
  }
  return value || '-';
}

function compactCount(total, unique) {
  return `${total}/${unique}`;
}

function terminalWidth() {
  return Math.min(Math.max(process.stdout.columns || 120, 96), 160);
}

function renderTable(headers, rows, options = {}) {
  const color = options.color !== false;
  const numericColumns = new Set(options.numericColumns || []);
  const minWidths = options.widths || headers.map(header => displayWidth(header));
  const widths = headers.map((header, index) => {
    const values = rows.map(row => row[index] || '');
    const max = Math.max(displayWidth(header), minWidths[index] || 0, ...values.map(displayWidth));
    return Math.min(max, options.maxWidth || 18);
  });

  const border = {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    horizontal: '─',
    vertical: '│',
    topJoin: '┬',
    midLeft: '├',
    midJoin: '┼',
    midRight: '┤',
    bottomJoin: '┴'
  };

  const line = (left, join, right) => `${left}${widths.map(width => border.horizontal.repeat(width + 2)).join(join)}${right}`;
  const row = cells => `${border.vertical}${cells.map((cell, index) => {
    const value = numericColumns.has(index) ? padStartDisplay(cell, widths[index]) : padEndDisplay(cell, widths[index]);
    return ` ${value} `;
  }).join(border.vertical)}${border.vertical}`;

  const output = [];
  output.push(paint(line(border.topLeft, border.topJoin, border.topRight), 'gray', color));
  output.push(row(headers.map(header => paint(header, 'bold', color))));
  output.push(paint(line(border.midLeft, border.midJoin, border.midRight), 'gray', color));
  for (const cells of rows) {
    output.push(row(cells));
  }
  output.push(paint(line(border.bottomLeft, border.bottomJoin, border.bottomRight), 'gray', color));
  return output.join('\n');
}

function renderBox(title, lines, options = {}) {
  const color = options.color !== false;
  const width = Math.min(options.width || terminalWidth(), terminalWidth());
  const innerWidth = width - 4;
  const cleanTitle = ` ${title} `;
  const topFill = Math.max(0, width - displayWidth(cleanTitle) - 2);
  const output = [];

  output.push(`${paint('┌', 'gray', color)}${paint(cleanTitle, 'cyan', color)}${paint('─'.repeat(topFill), 'gray', color)}${paint('┐', 'gray', color)}`);
  for (const line of lines) {
    output.push(`${paint('│', 'gray', color)} ${padEndDisplay(line, innerWidth)} ${paint('│', 'gray', color)}`);
  }
  output.push(`${paint('└', 'gray', color)}${paint('─'.repeat(width - 2), 'gray', color)}${paint('┘', 'gray', color)}`);
  return output.join('\n');
}

function formatTopMap(map, limit = 6) {
  const entries = Object.entries(map || {})
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  return entries.map(([key, value]) => `${key}:${value}`).join(', ') || '-';
}

function compactSample(line) {
  const target = matchAddress(line, 'target');
  const token = matchAddress(line, 'token');
  const method = (line.match(/method=([^ ]+)/) || [])[1];
  const runId = (line.match(/run_id=([^ ]+)/) || [])[1];
  const reason = (line.match(/reason=([^ ]+)/) || [])[1];
  const valueUsd = (line.match(/valueUsd=([0-9.]+)/) || [])[1];
  const liquidityUsd = (line.match(/liquidityUsd=([0-9.]+)/) || [])[1];
  const address = target || token || '-';
  const parts = [];

  parts.push(target ? `合约=${address}` : `Token=${address}`);
  if (method) {
    parts.push(`方法=${method}`);
  }
  if (runId) {
    parts.push(`run_id=${runId}`);
  }
  if (reason) {
    parts.push(`原因=${reason}`);
  }
  if (valueUsd) {
    parts.push(`价值=${valueUsd}`);
  } else if (liquidityUsd) {
    parts.push(`流动性=${liquidityUsd}`);
  }

  return parts.join(' ');
}

function printService(service, args) {
  const env = service.env;
  const prefix = service.chain;
  const method = service.metrics.method;
  const token = service.metrics.token;
  const events = service.metrics.events;
  const recent = service.recent;
  const errors = method.errors + service.metrics.subscriptions.errors;
  const recentErrors = recent.method.errors + recent.subscriptions.errors;
  const title = `${service.chain} ${service.service} ${coloredHealth(service.health.level, args.color)} - ${service.health.reason}`;
  const lines = [
    `容器        ${service.running ? paint('运行中', 'green', args.color) : paint('未运行', 'red', args.color)}`,
    `RPC         监听=${maskUrl(env[`${prefix}_WS_RPC`]) || '-'}  LORAI提交=${maskUrl(env[`${prefix}_LORAI_AUDIT_RPC_URL`]) || '-'}`,
    `敏感函数    开启=${yesNo(env[`${prefix}_METHOD_CALL_MONITOR_ENABLED`])} 订阅=${yesNo(env[`${prefix}_METHOD_CALL_SUBSCRIBE_ENABLED`])} 真实审计=${yesNo(env[`${prefix}_METHOD_CALL_TRIGGER_AUDIT`])} 门槛=${env[`${prefix}_METHOD_CALL_MIN_VALUE_USD`] || '-'} 函数=${env[`${prefix}_METHOD_CALL_SELECTORS`] ? '自定义' : '默认全集'} 默认签名=${yesNo(env[`${prefix}_METHOD_CALL_USE_DEFAULT_SIGNATURES`])}`,
    `Flap工厂    开启=${yesNo(env[`${prefix}_FLAP_VAULT_FACTORY_MONITOR_ENABLED`])} 订阅=${yesNo(env[`${prefix}_FLAP_VAULT_FACTORY_SUBSCRIBE_ENABLED`])} 真实审计=${yesNo(env[`${prefix}_FLAP_VAULT_FACTORY_TRIGGER_AUDIT`])} portal=${env[`${prefix}_FLAP_VAULT_PORTAL_ADDRESS`] || '-'}`,
    `统计 ${args.since}  敏感区块=${method.blocks} 命中=${method.matched} 达标=${method.qualified} 检查合约=${method.uniqueTargets} 已提交=${compactCount(method.triggered, method.uniqueTriggered)} 观察命中=${compactCount(method.wouldScan, method.uniqueWouldScan)}`,
    `跳过/错误    cooldown=${compactCount(method.cooldown, method.uniqueCooldown)} 已审计=${compactCount(method.existingAudit, method.uniqueExistingAudit)} 未达标=${method.belowThreshold} 队列丢弃=${method.queueDrops} 错误=${errors}`,
    `Token路径    检查Token=${token.uniqueTokens} 已提交=${compactCount(token.triggered, token.uniqueTriggered)} 跳过=${compactCount(token.skipped, token.uniqueSkipped)} Ave失败=${compactCount(token.aveFailures, token.uniqueAveFailures)}`,
    `链上事件     新池=${events.newPools} 流动性事件=${events.liquidityMatches} 代理升级=${events.proxyUpgradeMatches} Flap工厂=${events.flapFactoryEvents}/${events.flapFactoryTriggered} 合约价值观察=${events.contractValueObserved} 合约价值丢弃=${events.contractValueQueueDrops}`,
    `健康 ${args.recent}  method区块=${recent.method.blocks} 达标=${recent.method.qualified} 已提交=${recent.method.triggered} 观察命中=${recent.method.wouldScan} 错误=${recentErrors}`,
    `方法Top      ${formatTopMap(method.methods)}`,
    `提交方法     ${formatTopMap(method.triggerMethods)}`,
    `跳过原因     method=${formatTopMap(method.skipReasons)}  token=${formatTopMap(token.skipReasons)}`
  ];

  const samples = [...method.samples, ...token.samples].slice(-6);
  if (samples.length > 0) {
    lines.push('最近样本');
    for (const sample of samples.slice(-3)) {
      lines.push(`  - ${compactSample(sample)}`);
    }
  }

  console.log('');
  console.log(renderBox(title, lines, { color: args.color }));
}

function printSummary(results, args) {
  const title = `Worker 状态检查  主窗口=${args.since}  健康窗口=${args.recent}`;
  console.log(renderBox(paint(title, 'bold', args.color), [
    `说明: 已提交/观察命中/Token提交 均为 总次数/去重数。观察命中表示 dry-run 或 audit_disabled 场景下如果开启审计会触发。`
  ], { color: args.color }));

  const headers = ['链', '状态', '容器', '区块', '合约', '达标', '已提交', '观察命中', 'Token', 'Token提交', '错误', '丢弃'];
  const rows = results.map(service => {
    const method = service.metrics.method;
    const token = service.metrics.token;
    const errors = method.errors + service.metrics.subscriptions.errors;
    const drops = method.queueDrops + service.metrics.events.contractValueQueueDrops;
    return [
      service.chain,
      coloredHealth(service.health.level, args.color),
      service.running ? paint('运行', 'green', args.color) : paint('停止', 'red', args.color),
      method.blocks,
      method.uniqueTargets,
      method.qualified,
      compactCount(method.triggered, method.uniqueTriggered),
      compactCount(method.wouldScan, method.uniqueWouldScan),
      token.uniqueTokens,
      compactCount(token.triggered, token.uniqueTriggered),
      errors,
      drops
    ];
  });

  console.log('');
  console.log(paint('总览', 'cyan', args.color));
  console.log(renderTable(headers, rows, {
    color: args.color,
    widths: [6, 6, 6, 8, 8, 8, 10, 10, 8, 10, 8, 8],
    numericColumns: [3, 4, 5, 8, 10, 11]
  }));

  console.log('');
  console.log(paint('详情', 'cyan', args.color));
  for (const service of results) {
    printService(service, args);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (args.services.length === 0) {
    console.error('No services selected.');
    process.exit(1);
  }

  const results = args.services.map(service => inspectService(service, args));
  if (args.json) {
    console.log(JSON.stringify({ since: args.since, recent: args.recent, services: results }, null, 2));
    return;
  }
  printSummary(results, args);
}

main();
