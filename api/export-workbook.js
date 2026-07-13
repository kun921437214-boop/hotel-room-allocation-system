const crypto = require("crypto");
const { buildOverviewWorkbook } = require("../lib/overview-workbook");

const MAX_EXPORT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_NEEDS = 2000;

class ExportError extends Error {
  constructor(message, status = 400, code = "EXPORT_FAILED") {
    super(message);
    this.name = "ExportError";
    this.status = status;
    this.code = code;
  }
}

function isAllowedBrowserOrigin(req) {
  const headers = req.headers || {};
  const origin = String(headers.origin || "").trim().replace(/\/$/, "");
  if (!origin) return true;
  const protocol = String(headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http")).split(",")[0].trim();
  const host = String(headers["x-forwarded-host"] || headers.host || "").split(",")[0].trim();
  const configured = String(process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
  return new Set([`${protocol}://${host}`, ...configured]).has(origin);
}

function setSecurityHeaders(req, res) {
  const origin = String(req.headers?.origin || "").trim();
  if (origin && isAllowedBrowserOrigin(req)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
}

function logExport(level, details) {
  const payload = JSON.stringify({ timestamp: new Date().toISOString(), event: "workbook_export", ...details });
  if (level === "error") console.error(payload);
  else console.info(payload);
}

async function handler(req, res) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  setSecurityHeaders(req, res);
  if (!isAllowedBrowserOrigin(req)) {
    return res.status(403).json({ ok: false, code: "CROSS_ORIGIN_FORBIDDEN", error: "不允许跨站访问。", requestId });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED", error: "仅支持生成工作总表。", requestId });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_EXPORT_BODY_BYTES) {
      throw new ExportError("导出数据过大，请缩小筛选范围后重试。", 413, "EXPORT_TOO_LARGE");
    }
    if (!Array.isArray(body.needs)) {
      throw new ExportError("导出数据格式无效。", 400, "INVALID_EXPORT_DATA");
    }
    if (body.needs.length > MAX_EXPORT_NEEDS) {
      throw new ExportError(`单次最多导出 ${MAX_EXPORT_NEEDS} 条需求。`, 413, "TOO_MANY_EXPORT_ROWS");
    }
    const workbook = await buildOverviewWorkbook(body);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const filename = `活动住宿工作总表-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="accommodation-workbook.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    logExport("info", { requestId, status: 200, durationMs: Date.now() - startedAt, needs: Array.isArray(body.needs) ? body.needs.length : 0, bytes: buffer.length });
    return res.status(200).send(buffer);
  } catch (error) {
    const status = Number(error.status) || 400;
    logExport("error", { requestId, status, durationMs: Date.now() - startedAt, error: error.message || "工作总表生成失败" });
    return res.status(status).json({ ok: false, requestId, code: error.code || "EXPORT_FAILED", error: error.message || "工作总表生成失败" });
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
