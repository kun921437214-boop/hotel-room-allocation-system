const crypto = require("crypto");
const { buildOverviewWorkbook } = require("../lib/overview-workbook");

const MAX_EXPORT_BODY_BYTES = 2 * 1024 * 1024;

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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, requestId, message: "仅支持生成工作总表" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_EXPORT_BODY_BYTES) {
      const error = new Error("导出数据过大，请缩小筛选范围后重试。");
      error.status = 413;
      throw error;
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
    return res.status(status).json({ ok: false, requestId, message: error.message || "工作总表生成失败" });
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
