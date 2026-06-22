---
name: assess-appearance
description: 小莫(Momo)助手虚拟形象自定义 MCP Skill — 接收用户自然语言形象描述, 解析为标准化形象配置(AppearanceSpec), 供前端形象渲染系统消费. 不提供前端可视化选择器, 仅定义 AI 调用规范.
version: 1.0.0
author: chenyang
language: zh
tags: [momo, appearance, avatar, customization, mcp-skill]
---

# 小莫助手虚拟形象自定义 · MCP Skill 规范

> 模块: `assess_appearance`
> 适用: 任何接入 MCP 的 AI 助手, 需要根据用户自然语言指令自定义「小莫」虚拟形象时调用本 Skill。
> 示例指令: *「把小莫改成二维小猫形象」「让小莫变成赛博朋克风的机器人」「小莫换成一只戴眼镜的橘猫」*

---

## 一、元数据模块

### 1.1 Skill 名称
`assess-appearance`（小莫形象自定义 / Momo Appearance Customizer）

### 1.2 身份描述
本 Skill 是「小莫」虚拟形象的**自然语言 → 结构化配置**转换器。小莫是系统内置的 AI 助手虚拟形象（默认为友好的二维拟人形象）。本 Skill 不直接渲染形象，而是把用户的口语化描述解析成一份**确定性、可校验、可持久化**的形象配置对象 `AppearanceSpec`，交由前端形象渲染层（2D 立绘 / 3D 模型 / Lottie / 表情系统）消费。

### 1.3 触发使用场景
当用户意图**改变小莫的外观形象**时调用。典型触发语：
- 明确物种/形态：「把小莫改成小猫 / 小龙 / 狐狸 / 机器人」
- 明确维度/风格：「小莫变成二维 / 3D / 像素风 / 赛博朋克风」
- 明确配色/配饰：「小莫换成蓝色的，戴个领结」「让小莫戴眼镜」
- 综合描述：「把小莫改成一只戴着圆框眼镜、橘色毛、微笑的二维小猫」

**不触发**的场景（应回退普通对话）：
- 用户询问小莫**功能/能力**（非外观）
- 用户在讨论**项目里的其它 Agent 形象**（非小莫本体）
- 用户只是打招呼或闲聊

### 1.4 核心能力
1. **自然语言解析**：从口语化描述中抽取形象维度、形态、风格、配色、配饰、表情等维度。
2. **歧义消解**：对模糊描述做合理默认（如「小猫」未指定风格 → 默认 `chibi`；未指定配色 → 用该物种典型色）。
3. **参数校验**：按 `AppearanceSpec` JSON Schema 校验，越界/非法值回退到合法默认并产出 `warnings`。
4. **增量合并**：支持「只改某一项」（如「换个颜色」），保留用户原有形象的其余字段。
5. **可读摘要**：同步产出一句人类可读的形象摘要，便于前端 Toast / 确认弹窗展示。

---

## 二、执行规则模块

### 2.1 AI 接收形象描述后的生成约束

AI 在解析用户描述时**必须**遵守：

| 约束 | 说明 |
|---|---|
| **结构化优先** | 必须输出符合 `AppearanceSpec` 的 JSON 对象，禁止只输出自由文本描述。 |
| **字段合法** | 枚举字段只能取本规范「参数字典」中列出的值；未知值不得直传，需映射到最接近的合法值并记入 `warnings`。 |
| **最小完备** | 即使是局部修改，返回的 `spec` 也应是**完整**对象（合并后的全量），而非 diff。 |
| **色彩规范** | 所有颜色用 `#RRGGBB` 十六进制；不得用颜色名（`red`）或 `rgb()`。 |
| **默认保守** | 用户未提及的字段：若为「全新形象」用该物种/风格的典型默认；若为「局部修改」沿用现有值（由调用方传入 `current`）。 |
| **单义性** | 一个请求只产出一个 `spec`；若用户描述含多个互相矛盾的形象（如「小猫同时是机器人」），优先级：形态 > 风格 > 配饰，其余记入 `warnings`。 |

### 2.2 传参格式（AI 调用本 Skill 的入参）

调用方（AI 助手主控）向本 Skill 传递如下 JSON：

```jsonc
{
  "user_text": "把小莫改成二维小猫形象",   // 必填: 用户的原始自然语言描述
  "current": { ... }                      // 选填: 小莫当前 AppearanceSpec, 用于增量修改场景
}
```

### 2.3 AppearanceSpec（形象配置对象）

完整字段定义见同目录 `schema.json`。核心结构：

```jsonc
{
  "dimension": "2d",            // "2d" | "3d"  形象维度
  "form": {                     // 形态/物种
    "category": "animal",       // humanoid | animal | robot | creature | abstract
    "species": "cat",           // animal 时必填: cat|dog|fox|dragon|rabbit|panda|bear|bird|fish ...
    "variant": "小猫"            // 可选: 本地化变体名, 直接展示用
  },
  "style": "chibi",             // chibi|anime|pixel|flat|lowpoly|realistic|sketch|cyberpunk
  "palette": {                  // 配色
    "primary": "#E8A05C",       // 主色(主体毛色/皮肤/外壳)
    "secondary": "#FFFFFF",     // 次色(腹部/内耳/细节)
    "accent": "#FFB347"         // 点缀色(鼻头/腮红/能量光)
  },
  "accessories": ["圆框眼镜"],   // 配饰数组, 可空
  "expression": "happy",        // neutral|happy|curious|sleepy|cool|shy
  "props": [],                  // 持有道具, 可空
  "background": "soft-gradient" // 可选背景预设
}
```

### 2.4 处理流程（AI 内部执行步骤）

```
1. 读取 user_text; 若提供 current 则作为基线(局部修改模式), 否则为全新形象模式.
2. 关键词抽取:
   - 维度词: "二维/2D/扁平/平面"→2d; "三维/3D/立体"→3d
   - 形态词: "猫/小猫/喵"→cat; "狗/犬"→dog; "龙"→dragon; "机器人/机械"→robot ...
   - 风格词: "像素"→pixel; "赛博朋克/科技"→cyberpunk; "Q版/萌"→chibi; "写实"→realistic ...
   - 配色词: "橘色/橙色"→#E8A05C; "蓝色"→#3B82F6; "白色"→#FFFFFF ...(查颜色表)
   - 配饰词: "眼镜/领结/帽子/围巾"→accessories[]
3. 组装 AppearanceSpec, 越界值回退默认 + 记 warnings.
4. 局部修改模式: 用 { ...current, ...newFields } 合并, 未提及字段保留 current.
5. 生成人类可读 summary (一句中文).
6. 返回 §2.5 规定的结构.
```

### 2.5 返回数据规范

本 Skill **必须**返回如下 JSON（即使解析失败也要返回合法结构，不可抛异常中断会话）：

```jsonc
{
  "ok": true,                   // 解析是否成功产出可用 spec
  "spec": { ... },              // 完整 AppearanceSpec (合并后全量)
  "summary": "小莫已切换为: 二维 Q版橘色小猫, 戴圆框眼镜, 开心表情。",
  "warnings": [],               // 字符串数组; 越界值/歧义消解/缺失回退的提示, 无则空数组
  "changed_fields": ["dimension","form","style","palette"]  // 本次相对 current 实际变更的字段路径
}
```

解析完全失败（如用户描述根本不是形象相关）时：

```jsonc
{ "ok": false, "spec": null, "summary": "未能识别形象修改意图", "warnings": ["输入未包含可识别的形象描述"], "changed_fields": [] }
```

### 2.6 调用示例

**输入**（全新形象）：
```json
{ "user_text": "把小莫改成二维小猫形象" }
```
**输出**：
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
  "warnings": ["未指定风格, 已默认 chibi(Q版); 未指定配色, 已用橘猫典型色"],
  "changed_fields": ["dimension","form","style","palette","expression","background"]
}
```

**输入**（局部修改，传入 current）：
```json
{ "user_text": "给小莫戴个圆框眼镜", "current": { "dimension": "2d", "form": {"category":"animal","species":"cat"}, "style":"chibi", "palette":{"primary":"#E8A05C"}, "accessories":[], "expression":"curious" } }
```
**输出**（仅 accessories 变更，其余沿用 current）：
```json
{ "ok": true, "spec": { "...同current...": "", "accessories": ["圆框眼镜"] }, "summary": "已为小莫(二维小猫)戴上圆框眼镜。", "warnings": [], "changed_fields": ["accessories"] }
```

---

## 三、参数字典（枚举值参考）

### dimension
`2d`（平面立绘/动画） · `3d`（立体模型）

### form.category
`humanoid`（人形） · `animal`（动物） · `robot`（机器人） · `creature`（幻想生物） · `abstract`（抽象/几何）

### form.species（category=animal 时）
`cat` `dog` `fox` `dragon` `rabbit` `panda` `bear` `bird` `fish` `hamster` `owl` `axolotl`（六角恐龙）

### style
`chibi`（Q版萌系） · `anime`（日系动漫） · `pixel`（像素） · `flat`（扁平矢量） · `lowpoly`（低多边形） · `realistic`（写实） · `sketch`（手绘线稿） · `cyberpunk`（赛博朋克）

### expression
`neutral` `happy` `curious` `sleepy` `cool` `shy`

### 常用颜色表（口语 → hex）
橘色 `#E8A05C` · 橙色 `#FF8C00` · 红色 `#EF4444` · 蓝色 `#3B82F6` · 天蓝 `#38BDF8` · 绿色 `#22C55E` · 紫色 `#A855F7` · 粉色 `#EC4899` · 白色 `#FFFFFF` · 黑色 `#1F2937` · 灰色 `#9CA3AF` · 金色 `#FBBF24` · 银色 `#CBD5E1`

---

## 四、约束与边界

1. **不渲染**：本 Skill 只产出配置，不生成图片/模型文件。实际渲染由前端形象系统根据 `spec` 完成。
2. **不持久化**：是否保存为新默认形象由调用方决定；本 Skill 无副作用。
3. **安全**：拒绝明显违规描述（暴力/血腥/真人仿冒），返回 `ok:false` + 说明，不产出 spec。
4. **向后兼容**：`AppearanceSpec` 新增字段时给默认值，旧调用方不破坏。
5. **命名**：模块目录固定为 `assess_appearance`，主规范即本文件，机器可读 schema 见 `schema.json`，更多示例见 `examples.md`。
