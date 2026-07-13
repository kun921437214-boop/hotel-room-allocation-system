# 部署与运维手册

## 系统边界

网页为静态前端，核心接口运行在 Vercel Serverless Functions，正式业务数据保存在飞书多维表格。浏览器会话缓存、待重试队列和未完成上传任务都不是正式备份。

当前未接入账号登录，这是明确保留的风险。接口已限制浏览器跨域请求，但知道生产接口地址的非浏览器客户端仍可能访问公开业务接口。正式处理敏感身份证和电话前，应优先接入企业身份认证并在后端执行权限校验。

## 环境配置

开发、预览和生产环境应分别配置，不共用测试 Base 与生产 Base。必需变量见 `.env.example`：

- `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_APP_TOKEN`
- `FEISHU_BASE_URL`
- `FEISHU_SYNC_TABLE_ID`、`FEISHU_SYNC_TABLE_NAME`、`FEISHU_SYNC_RECORD_KEY`
- `ALLOWED_ORIGINS`：多个域名使用英文逗号分隔
- `MAINTENANCE_TOKEN`：至少 32 字节随机值，只给运维脚本使用
- `ALLOW_LEGACY_STATE_SAVE=false`

秘密值只放 Vercel 环境变量或本机 `.env.local`，不得提交 Git。修改秘密后应立即重新部署，并废止旧值。

## 发布门禁

```bash
npm ci
npm run check
npm audit --omit=dev --audit-level=high
```

四道检查全部通过后再发布。生产发布完成后访问 `/api/health`，应返回 HTTP 200 且状态为 `ready`。健康接口只检查必要配置是否存在，不返回秘密值，也不读取业务数据。

## 发布与回滚

生产发布使用 GitHub 主分支或 Vercel CLI。每次发布前记录当前可用 Deployment URL 和 Git commit。

出现白屏、核心接口持续失败或数据异常时：

1. 暂停继续导入和编辑。
2. 在 Vercel Deployments 中将上一个已验证版本 Promote/Rollback 到生产。
3. 检查 `/api/health`、Vercel Function Logs 和飞书操作记录表。
4. 不要用浏览器缓存覆盖线上数据。

代码回滚不等于数据回滚。数据恢复必须按下方流程单独执行。

## 备份策略

建议至少采用 3-2-1 原则：飞书主数据、飞书内部操作前备份、NAS 或独立磁盘文件备份。NAS 文件备份每天运行，并保留至少 30 天：

```bash
BACKUP_SOURCE_URL="https://生产域名" \
BACKUP_DIR="/NAS/活动房务备份" \
BACKUP_RETENTION_DAYS=30 \
npm run backup:file
```

每日任务失败必须告警，不能只依赖人工查看。每周抽查最新备份：

```bash
npm run backup:verify -- "/NAS/活动房务备份/hotel-state-时间.json.gz"
```

每月在非生产 Base 做一次恢复演练，核对需求数、人数、日期、酒店、房型和人员明细。只有“能恢复并核对通过”的备份才算有效备份。

## 恢复流程

1. 通知所有操作人员停止写入。
2. 记录当前线上版本和需求数量。
3. 确认目标备份组 ID 和 SHA-256 校验。
4. 使用与目标环境对应的飞书变量执行：

```bash
CONFIRM_RESTORE_BACKUP="备份组ID" \
RESTORE_OPERATOR="操作人" \
node scripts/restore-backup.js "备份组ID"
```

恢复脚本会启用维护锁，并在恢复前再次备份当前状态。完成后重新读取线上数据，核对总需求、总人数和抽样人员，不应直接以脚本退出码作为唯一成功标准。

## 日志与排障

接口错误响应带 `requestId`。排障时同时记录：发生时间、页面操作、requestId、HTTP 状态码、浏览器版本、Vercel Deployment 和数据版本。日志不得复制密码、令牌、身份证号或完整电话。

常见检查顺序：

1. `/api/health` 是否为 200。
2. Vercel 是否有 429、5xx 或函数超时。
3. 飞书 OpenAPI 是否限流或无权限。
4. 页面是否存在待重试队列或版本冲突。
5. 操作记录表是否存在对应 operationId。

## 维护操作

查看表刷新属于维护操作，必须使用维护令牌：

```bash
MAINTENANCE_BASE_URL="https://生产域名" \
MAINTENANCE_TOKEN="维护令牌" \
npm run maintenance:refresh
```

旧版整份状态覆盖默认关闭。除紧急兼容窗口外，不得把 `ALLOW_LEGACY_STATE_SAVE` 改为 `true`。

## 已知剩余风险

1. 未接入账号登录和角色权限，无法识别真实操作人，也无法阻止获得接口地址的非浏览器客户端读取或修改数据。
2. 飞书多维表格不是关系型数据库，无法提供跨核心表和人员表的强事务、外键及数据库级唯一约束。
3. Serverless 实例内写队列不是全局分布式锁；版本校验、幂等键和操作前备份降低风险，但极端并发仍可能冲突。
4. 浏览器主文件 `app.js` 仍较大，已通过 lint 和自动化测试约束，但尚未完成全面 TypeScript 化和模块拆分。
5. 自动化测试覆盖核心数据规则、接口边界、安全响应和导出；真实飞书沙箱集成测试及完整浏览器端到端测试仍应继续补充。

当并发写入增加、人员数据长期保存或权限要求提高时，应将核心数据迁移到 PostgreSQL 等支持事务、索引、约束和审计的数据库，飞书保留为查看与协作镜像。
