const crypto = require("node:crypto");

module.exports = async function health(req, res) {
  const requestId = crypto.randomUUID();
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, code: "METHOD_NOT_ALLOWED", error: "仅支持健康检查。", requestId });
  }
  const required = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_APP_TOKEN"];
  const missing = required.filter((name) => !process.env[name]);
  const status = missing.length ? 503 : 200;
  return res.status(status).json({
    ok: !missing.length,
    status: missing.length ? "misconfigured" : "ready",
    code: missing.length ? "ENVIRONMENT_MISCONFIGURED" : "OK",
    missing,
    requestId,
    timestamp: new Date().toISOString()
  });
};

module.exports.config = { maxDuration: 10 };
