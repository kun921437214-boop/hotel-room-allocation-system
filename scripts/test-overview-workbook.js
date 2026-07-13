const assert = require("node:assert/strict");
const { buildOverviewWorkbook } = require("../lib/overview-workbook");

async function run() {
  const dates = ["2026-08-01", "2026-08-02"];
  const roomCapacityTotals = {
    诺富特: Object.fromEntries(dates.map((date) => [date, { 双标: 10, 大床: 5, 套房: 2 }]))
  };
  const workbook = await buildOverviewWorkbook({
    dates,
    roomCapacityTotals,
    needs: [{
      id: "REQ-001",
      name: "张三",
      gender: "男",
      phone: "13000000000",
      idNo: "110101199001010011",
      identity: "工作人员",
      companions: [{ name: "李四", gender: "男", phone: "13100000000", idNo: "110101199201010012", identity: "工作人员" }],
      hotel: "诺富特",
      roomNo: "801",
      roomType: "双标",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      note: "同住"
    }]
  });

  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["总表", "汇总", "工作人员", "评委", "嘉宾", "承办单位", "家长", "其他"]);
  const total = workbook.getWorksheet("总表");
  assert.deepEqual(/** @type {any[]} */ (total.getRow(1).values).slice(1), [
    "性质", "序号", "入住人姓名", "房间类型", "入住日期", "退房日期", "入住天数", "电话",
    "身份证号码", "性别", "安排酒店", "房间号", "舱位", "去程航班", "返程航班", "备注"
  ]);
  assert.equal(total.getCell("B2").value, 1);
  assert.equal(total.getCell("B3").value, 1);
  assert.equal(total.getCell("G2").value, 2);
  assert.equal(total.getCell("G3").value, null);
  assert.equal(total.getCell("K2").value, "诺富特");
  assert.equal(total.getCell("L2").value, "801");

  const staff = workbook.getWorksheet("工作人员");
  assert.equal(staff.getCell("K2").value, 1);
  assert.equal(staff.getCell("N2").value, 1);
  assert.equal(staff.getCell("K6").value, 1);
  assert.equal(staff.getCell("N6").value, 1);
  assert.equal(staff.getCell("K7").value, null);
  assert.equal(staff.getCell("N7").value, null);

  const summary = workbook.getWorksheet("汇总");
  assert.equal(summary.getCell("B3").value, 1);
  assert.equal(summary.getCell("E3").value, 1);
  assert.equal(summary.getCell("H3").value, 2);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
