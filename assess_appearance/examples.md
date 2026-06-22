# assess_appearance · 示例集

> 配套 `SKILL.md` 与 `schema.json`。每条 = 用户自然语言 → Skill 返回。所有 spec 均通过 `schema.json` 校验。

---

## 示例 1：二维小猫（基础全新形象）

**输入**
```json
{ "user_text": "把小莫改成二维小猫形象" }
```
**输出**
```json
{
  "ok": true,
  "spec": {
    "dimension": "2d",
    "form": { "category": "animal", "species": "cat", "variant": "小猫" },
    "style": "chibi",
    "palette": { "primary": "#E8A05C", "secondary": "#FFFFFF", "accent": "#FFB347" },
    "accessories": [],
    "expression": "curious",
    "props": [],
    "background": "soft-gradient"
  },
  "summary": "小莫已切换为: 二维 Q版橘色小猫, 好奇表情。",
  "warnings": ["未指定风格, 已默认 chibi(Q版)", "未指定配色, 已用橘猫典型色"],
  "changed_fields": ["dimension", "form", "style", "palette", "expression", "background"]
}
```

---

## 示例 2：赛博朋克机器人（3D + 风格 + 配色）

**输入**
```json
{ "user_text": "让小莫变成赛博朋克风的蓝色3D机器人" }
```
**输出**
```json
{
  "ok": true,
  "spec": {
    "dimension": "3d",
    "form": { "category": "robot", "variant": "赛博机器人" },
    "style": "cyberpunk",
    "palette": { "primary": "#3B82F6", "secondary": "#1F2937", "accent": "#38BDF8" },
    "accessories": [],
    "expression": "cool",
    "props": [],
    "background": "neon-grid"
  },
  "summary": "小莫已切换为: 3D 赛博朋克风蓝色机器人, 酷表情。",
  "warnings": [],
  "changed_fields": ["dimension", "form", "style", "palette", "expression", "background"]
}
```

---

## 示例 3：戴眼镜的橘猫（局部修改 — 增量合并）

**输入**（携带当前形象 `current`）
```json
{
  "user_text": "给小莫戴个圆框眼镜",
  "current": {
    "dimension": "2d",
    "form": { "category": "animal", "species": "cat" },
    "style": "chibi",
    "palette": { "primary": "#E8A05C", "secondary": "#FFFFFF", "accent": "#FFB347" },
    "accessories": [],
    "expression": "curious"
  }
}
```
**输出**（仅 `accessories` 变更，其余沿用 current）
```json
{
  "ok": true,
  "spec": {
    "dimension": "2d",
    "form": { "category": "animal", "species": "cat" },
    "style": "chibi",
    "palette": { "primary": "#E8A05C", "secondary": "#FFFFFF", "accent": "#FFB347" },
    "accessories": ["圆框眼镜"],
    "expression": "curious"
  },
  "summary": "已为小莫(二维 Q版小猫)戴上圆框眼镜。",
  "warnings": [],
  "changed_fields": ["accessories"]
}
```

---

## 示例 4：像素风幼龙（幻想生物 + 道具）

**输入**
```json
{ "user_text": "小莫变成一只像素风的绿色小龙, 拿着一颗星星" }
```
**输出**
```json
{
  "ok": true,
  "spec": {
    "dimension": "2d",
    "form": { "category": "creature", "species": "dragon", "variant": "幼龙" },
    "style": "pixel",
    "palette": { "primary": "#22C55E", "secondary": "#A7F3D0", "accent": "#FBBF24" },
    "accessories": [],
    "expression": "happy",
    "props": ["星星"],
    "background": "starfield"
  },
  "summary": "小莫已切换为: 二维像素风绿色幼龙, 手持星星, 开心表情。",
  "warnings": [],
  "changed_fields": ["dimension", "form", "style", "palette", "expression", "props", "background"]
}
```

---

## 示例 5：歧义消解（"小猫同时是机器人"）

**输入**
```json
{ "user_text": "把小莫改成一只机器小猫" }
```
**输出**（form 优先 animal/cat，机器特征映射为 cyberpunk 风格 + 配色，并记 warning）
```json
{
  "ok": true,
  "spec": {
    "dimension": "2d",
    "form": { "category": "animal", "species": "cat", "variant": "机器小猫" },
    "style": "cyberpunk",
    "palette": { "primary": "#9CA3AF", "secondary": "#1F2937", "accent": "#38BDF8" },
    "accessories": [],
    "expression": "cool",
    "props": [],
    "background": "neon-grid"
  },
  "summary": "小莫已切换为: 二维赛博朋克风机器小猫。",
  "warnings": ["『机器小猫』含矛盾形态, 已按 animal/cat 解析, 机器特征映射为 cyberpunk 风格"],
  "changed_fields": ["dimension", "form", "style", "palette", "expression", "background"]
}
```

---

## 示例 6：未识别意图（失败回退）

**输入**
```json
{ "user_text": "小莫你能帮我写代码吗" }
```
**输出**
```json
{
  "ok": false,
  "spec": null,
  "summary": "未能识别形象修改意图",
  "warnings": ["输入未包含可识别的形象描述, 已回退普通对话"],
  "changed_fields": []
}
```

---

## 示例 7：安全拒绝（违规描述）

**输入**
```json
{ "user_text": "把小莫改成血腥恐怖的样子" }
```
**输出**
```json
{
  "ok": false,
  "spec": null,
  "summary": "该形象描述不符合规范, 已拒绝",
  "warnings": ["描述含暴力/恐怖元素, 违反形象安全策略"],
  "changed_fields": []
}
```
