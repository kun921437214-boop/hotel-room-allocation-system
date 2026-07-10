const { buildOverviewWorkbook } = require("../lib/overview-workbook");

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "仅支持生成工作总表" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const workbook = await buildOverviewWorkbook(body);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const filename = `活动住宿工作总表-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="accommodation-workbook.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(400).json({ ok: false, message: error.message || "工作总表生成失败" });
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
