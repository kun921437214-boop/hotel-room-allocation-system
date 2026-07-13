const assert = require("node:assert/strict");
const { escapeHtml } = require("../lib/html-utils");
const health = require("../api/health");
const exportWorkbook = require("../api/export-workbook");

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; }
  };
}

async function run() {
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">&'`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");

  const previous = {
    id: process.env.FEISHU_APP_ID,
    secret: process.env.FEISHU_APP_SECRET,
    token: process.env.FEISHU_APP_TOKEN
  };
  process.env.FEISHU_APP_ID = "test";
  process.env.FEISHU_APP_SECRET = "test";
  process.env.FEISHU_APP_TOKEN = "test";
  const healthResponse = response();
  await health({ method: "GET" }, healthResponse);
  assert.equal(healthResponse.statusCode, 200);
  assert.equal(healthResponse.body.ok, true);

  const crossOriginResponse = response();
  await exportWorkbook({
    method: "POST",
    headers: { origin: "https://attacker.example", host: "hotel.example", "x-forwarded-proto": "https" },
    body: { needs: [] }
  }, crossOriginResponse);
  assert.equal(crossOriginResponse.statusCode, 403);
  assert.equal(crossOriginResponse.body.code, "CROSS_ORIGIN_FORBIDDEN");

  const invalidResponse = response();
  await exportWorkbook({ method: "POST", headers: {}, body: {} }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalidResponse.body.code, "INVALID_EXPORT_DATA");

  if (previous.id === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previous.id;
  if (previous.secret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = previous.secret;
  if (previous.token === undefined) delete process.env.FEISHU_APP_TOKEN; else process.env.FEISHU_APP_TOKEN = previous.token;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
