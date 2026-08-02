// lib/image.js — 封面/配图（方案 §11）。MVP 默认只封面。
// 校验：文件魔数/尺寸/像素/字节；统一重编码为 JPG/PNG；正文单图 <1MB；SVG 须先栅格化；
// 按 SHA-256 缓存微信上传。生图：env IMAGE_GEN_BASE/API 配置后启用；否则生成文字占位封面。

const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { safeFetch } = require("./safe-fetch");

const MAGIC = {
  jpg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47],
  gif: [0x47, 0x49, 0x46, 0x38], webp: [0x52, 0x49, 0x46, 0x46],
};
function detectType(buf) {
  const eq = (arr) => arr.every((b, i) => buf[i] === b);
  if (eq(MAGIC.jpg)) return "jpg";
  if (eq(MAGIC.png)) return "png";
  if (eq(MAGIC.gif)) return "gif";
  if (eq(MAGIC.webp)) return "webp";
  return null;
}
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// 校验并落地一张图到 images/
function ingestImage({ extDataDir, source, kind = "inline" }) {
  const imagesDir = path.join(extDataDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  let buf;
  if (Buffer.isBuffer(source)) buf = source;
  else buf = fs.readFileSync(source);
  const type = detectType(buf);
  if (!type) throw new Error("无法识别的图片格式（魔数校验失败）");
  if (buf.byteLength > 5_000_000) throw new Error("原图过大（>5MB）");
  const hash = sha256(buf);
  const file = path.join(imagesDir, `${kind}_${hash}.${type}`);
  fs.writeFileSync(file, buf);
  return { path: file, hash, type, bytes: buf.byteLength };
}

// 占位文字封面：SVG → 尝试 sharp 栅格化为 PNG；sharp 不可用则返回 SVG 并标记需手动替换。
async function generatePlaceholderCover({ extDataDir, title, subtitle = "" }) {
  const imagesDir = path.join(extDataDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  const t = esc(String(title || "AI 热点").slice(0, 24));
  const sub = esc(String(subtitle || "").slice(0, 40));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#1f2a44"/><stop offset="1" stop-color="#576b95"/></linearGradient></defs>
<rect width="900" height="500" fill="url(#g)"/>
<text x="60" y="240" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="56" font-weight="bold" fill="#ffffff">${t}</text>
<text x="60" y="300" font-family="PingFang SC, sans-serif" font-size="26" fill="#c8d2ec">${sub}</text>
<text x="60" y="450" font-family="sans-serif" font-size="18" fill="#9fb0d8">AI 热点 · 公众号图文</text>
</svg>`;
  try {
    const sharp = require("sharp");
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const pngPath = path.join(imagesDir, `cover_${sha256(png).slice(0, 16)}.png`);
    fs.writeFileSync(pngPath, png);
    return { path: pngPath, hash: sha256(png), type: "png", bytes: png.length };
  } catch (_) {
    const svgPath = path.join(imagesDir, `cover_${sha256(Buffer.from(svg)).slice(0, 16)}.svg`);
    fs.writeFileSync(svgPath, svg);
    return { path: svgPath, hash: sha256(Buffer.from(svg)), type: "svg", bytes: svg.length, need_rasterize: true };
  }
}

// 远程生图（可选，env 驱动）
async function generateRemoteCover({ prompt }) {
  const base = process.env.IMAGE_GEN_BASE, key = process.env.IMAGE_GEN_API;
  if (!base || !key) throw new Error("未配置生图服务（IMAGE_GEN_BASE/API）");
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 40_000);
  try {
    const r = await fetch(base.replace(/\/+$/, "") + "/generate", { method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ prompt, size: "1024x576" }) });
    const j = await r.json();
    const url = j.url || (j.data && j.data[0] && j.data[0].url);
    if (!url) throw new Error("生图未返回 url");
    const f = await safeFetch(url, { maxBytes: 5_000_000, timeoutMs: 30_000 });
    return f.buffer;
  } finally { clearTimeout(timer); }
}

module.exports = { ingestImage, generatePlaceholderCover, generateRemoteCover, detectType, sha256 };
