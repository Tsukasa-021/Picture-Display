/* 暖光集 · 图片画廊 后端服务
 * 纯 Node 实现，无第三方依赖。
 * 启动：node server.js
 * 访问：http://localhost:8000/
 *
 * 提供的接口：
 *   GET    /api/photos            获取全部上传照片
 *   POST   /api/photos            上传照片（JSON：{data,t,c,tags,d,y}）
 *   DELETE /api/photos            删除全部上传照片
 *   DELETE /api/photos/:id        删除单张上传照片
 *   GET    /api/categories        获取分类列表与重命名映射
 *   POST   /api/categories/rename 重命名分类（{from,to}）
 *   DELETE /api/categories/:name  删除分类
 *   GET    /api/demo/deleted      获取已删除的演示照片 id
 *   DELETE /api/demo/:id          标记某演示照片为已删除
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8000;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DATA_FILE = path.join(ROOT, "data.json");
const MAX_BODY = 50 * 1024 * 1024; // 50MB

const DEFAULT_CATS = ["自然", "城市", "人像", "美食", "建筑", "静物", "上传"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* ---------- 数据持久化 ---------- */
let data;

function defaultData() {
  return {
    uploads: [],
    categories: DEFAULT_CATS.slice(),
    renameMap: {},
    deletedDemo: [],
    nextUploadId: 1,
  };
}

function loadData() {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    data = defaultData();
  }
  data.uploads = Array.isArray(data.uploads) ? data.uploads : [];
  data.categories =
    Array.isArray(data.categories) && data.categories.length ? data.categories : DEFAULT_CATS.slice();
  data.renameMap =
    data.renameMap && typeof data.renameMap === "object" && !Array.isArray(data.renameMap)
      ? data.renameMap
      : {};
  data.deletedDemo = Array.isArray(data.deletedDemo) ? data.deletedDemo : [];
  data.nextUploadId = Math.max(
    Number(data.nextUploadId) || 1,
    data.uploads.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0) + 1
  );
  saveData();
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("保存数据失败：", e);
  }
}

// 当前显示名称：先查重命名映射，再回退到原始名称
function disp(name) {
  return data.renameMap[name] || name;
}

/* ---------- 工具 ---------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}

function dataUrlToFile(dataUrl) {
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(String(dataUrl));
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const extMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  let buf;
  try {
    buf = Buffer.from(m[2], "base64");
  } catch (e) {
    return null;
  }
  return { ext: extMap[mime] || "bin", buf };
}

/* ---------- 照片接口 ---------- */
async function addPhoto(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: "无效的 JSON" });
  }
  const parsed = dataUrlToFile(body.data);
  if (!parsed) return sendJson(res, 400, { error: "无效的图片数据" });

  const id = data.nextUploadId++;
  const filename = "photo_" + Date.now().toString(36) + "_" + id + "." + parsed.ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), parsed.buf);

  const photo = {
    id,
    src: "/uploads/" + filename,
    t: String(body.t || "未命名"),
    c: String(body.c || "未分类"),
    tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
    d: String(body.d || "上传的照片"),
    y: Number(body.y) || new Date().getFullYear(),
  };
  data.uploads.push(photo);
  saveData();
  sendJson(res, 200, photo);
}

function removeFileForPhoto(p) {
  try {
    const name = path.basename(String(p.src || ""));
    if (name) fs.unlinkSync(path.join(UPLOAD_DIR, name));
  } catch (e) {
    /* 文件不存在时忽略 */
  }
}

function deleteAllPhotos(res) {
  data.uploads.forEach(removeFileForPhoto);
  data.uploads = [];
  saveData();
  sendJson(res, 200, { ok: true });
}

function deleteOnePhoto(res, id) {
  const idx = data.uploads.findIndex((p) => String(p.id) === String(id));
  if (idx < 0) return sendJson(res, 404, { error: "照片不存在" });
  const [p] = data.uploads.splice(idx, 1);
  removeFileForPhoto(p);
  saveData();
  sendJson(res, 200, { ok: true });
}

/* ---------- 分类接口 ---------- */
async function renameCategory(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendJson(res, 400, { error: "无效的 JSON" });
  }
  const from = String(body.from || "");
  const to = String(body.to || "").trim();
  if (!from || !to || from === to) return sendJson(res, 400, { error: "参数无效" });
  if (data.categories.includes(to)) return sendJson(res, 400, { error: "已存在同名分类" });

  // 上传照片直接改到新分类
  data.uploads.forEach((p) => {
    if (disp(p.c) === from) p.c = to;
  });
  // 分类列表替换
  data.categories = data.categories.map((c) => (c === from ? to : c));
  // 重命名映射：原本指向 from 的改为 to
  Object.keys(data.renameMap).forEach((k) => {
    if (data.renameMap[k] === from) data.renameMap[k] = to;
  });
  // 若 from 是原始默认分类名，记下映射（用于演示照片）
  if (DEFAULT_CATS.includes(from) && !(from in data.renameMap)) {
    data.renameMap[from] = to;
  }
  saveData();
  sendJson(res, 200, { categories: data.categories, renameMap: data.renameMap });
}

function deleteCategory(res, name) {
  name = String(name);
  if (!data.categories.includes(name)) return sendJson(res, 404, { error: "分类不存在" });

  // 该分类下的照片归入「未分类」
  data.uploads.forEach((p) => {
    if (disp(p.c) === name) p.c = "未分类";
  });
  Object.keys(data.renameMap).forEach((k) => {
    if (data.renameMap[k] === name) data.renameMap[k] = "未分类";
  });
  if (DEFAULT_CATS.includes(name) && !(name in data.renameMap)) {
    data.renameMap[name] = "未分类";
  }

  data.categories = data.categories.filter((c) => c !== name);

  // 若有照片归入「未分类」，补上该分类
  const hasUnclassified =
    data.uploads.some((p) => p.c === "未分类") ||
    Object.values(data.renameMap).includes("未分类");
  if (hasUnclassified && !data.categories.includes("未分类")) {
    data.categories.push("未分类");
  }

  saveData();
  sendJson(res, 200, { categories: data.categories, renameMap: data.renameMap });
}

/* ---------- 演示照片删除接口 ---------- */
function deleteDemo(res, id) {
  const sid = String(id);
  if (!data.deletedDemo.includes(sid)) data.deletedDemo.push(sid);
  saveData();
  sendJson(res, 200, data.deletedDemo);
}

/* ---------- 静态文件 ---------- */
function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/zjl.html" : pathname;
  const filePath = path.normalize(path.join(ROOT, rel));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Forbidden");
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not Found");
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------- 路由 ---------- */
function handleApi(req, res, method, pathname) {
  const seg = pathname.split("/").filter(Boolean); // e.g. ["api","photos","5"]
  const a = seg[1];
  const b = seg[2];

  if (a === "photos") {
    if (method === "GET" && !b) return sendJson(res, 200, data.uploads);
    if (method === "POST" && !b) return addPhoto(req, res);
    if (method === "DELETE" && !b) return deleteAllPhotos(res);
    if (method === "DELETE" && b) return deleteOnePhoto(res, b);
  }
  if (a === "categories") {
    if (method === "GET" && !b)
      return sendJson(res, 200, { categories: data.categories, renameMap: data.renameMap });
    if (method === "POST" && b === "rename") return renameCategory(req, res);
    if (method === "DELETE" && b) return deleteCategory(res, b);
  }
  if (a === "demo") {
    if (b === "deleted" && method === "GET") return sendJson(res, 200, data.deletedDemo);
    if (b && method === "DELETE") return deleteDemo(res, b);
  }
  return sendJson(res, 404, { error: "接口不存在" });
}

/* ---------- 启动 ---------- */
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
loadData();

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (e) {
    return sendJson(res, 400, { error: "无效的请求路径" });
  }
  if (pathname.startsWith("/api/")) {
    handleApi(req, res, req.method, pathname);
  } else {
    serveStatic(req, res, pathname);
  }
});

server.listen(PORT, () => {
  console.log("暖光集 · 画廊服务已启动");
  console.log("请访问： http://localhost:" + PORT + "/");
});
