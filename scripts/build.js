const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

const root = path.resolve(__dirname, "..");
const runtimeFiles = [
  "app.js",
  "api/state.js",
  "api/export-workbook.js",
  "api/health.js",
  "lib/html-utils.js",
  "lib/client-sync-utils.js",
  "lib/overview-workbook.js",
  "lib/state-utils.js"
];

for (const file of runtimeFiles) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) throw new Error(`缺少运行文件：${file}`);
  childProcess.execFileSync(process.execPath, ["--check", absolute], { stdio: "inherit" });
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
for (const asset of ["styles.css", "lib/html-utils.js", "lib/client-sync-utils.js", "app.js"]) {
  if (!html.includes(asset)) throw new Error(`index.html 未引用必要资源：${asset}`);
}

const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
if (!Array.isArray(vercel.regions) || !vercel.regions.length) throw new Error("vercel.json 缺少部署区域配置。");
if (!Array.isArray(vercel.headers) || !vercel.headers.length) throw new Error("vercel.json 缺少安全响应头配置。");

const output = path.join(root, "public");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, "lib"), { recursive: true });
for (const file of ["index.html", "styles.css", "app.js", "lib/html-utils.js", "lib/client-sync-utils.js"]) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}

console.log(`生产构建检查通过：${runtimeFiles.length} 个运行文件，静态站点已输出到 public。`);
