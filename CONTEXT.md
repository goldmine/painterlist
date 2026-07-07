# PainterList — 项目语境

## 排名标准
采用权威名单（维基百科关注度、艺术史教科书篇幅、主要博物馆馆藏覆盖）作为知名度与影响力的代理指标，而不构建自定义加权算法。

## JSON 字段
每位画家包含：
- `id` — 唯一标识
- `name` — 英文姓名
- `birth_year` / `death_year` — 生卒年
- `nationality` — 国籍
- `movement` — 主要艺术流派（数组，允许跨流派）
- `bio` — 人物生平经历简介（包含生平、贡献及影响）
- `rank` — 排名位次（1–1000）

## 地域策略
不主动平衡地域分布。排名完全基于全球知名度与影响力的客观指标，如实反映西方在艺术史话语权中的主导地位。将在文档中注明此偏向。

## 时间范围
涵盖从古希腊罗马有明确可考姓名记载的时期起（约前 5 世纪），至 1955 年（含）去世的画家。不包括史前/无明确作者的绘画。实际操作中，集中收录起始于 13 世纪末/14 世纪。

## 画家定义
指从事过至少一幅现存绘画作品（任何平面媒介：油画、水彩、壁画、蛋彩、水墨、丙烯、蜡画）创作，且在艺术史上最主要被归为画家的人。若某人的主要身份标签不是画家（如雕塑家、建筑师），但留下了重要绘画作品，仍可入选。

## 公有领域判定
采用 life+70 规则（作者去世后 70 年）。以 2026 年为基准，1955 年及之前去世的画家自动视为进入公有领域。若某法域期限更长，则取最长者为准。

## 画作数据集 (`paintings.json`)

脚本 `scripts/fetch_paintings.mjs` 从 Wikidata SPARQL 查询每位画家的代表画作，从 Wikimedia Commons 下载高分辨率原图，汇总为 `paintings.json`。

**工作流程：**
1. 通过 Wikipedia API 将画家姓名解析为 Wikidata QID（存入 `painters.json` 的 `wikidata_qid` 字段）
2. 批量 SPARQL 查询画作信息（标题、创作年份、馆藏机构、材质、流派），要求必须有图片
3. 从 `upload.wikimedia.org` 下载原始分辨率图片至 `paintings/` 目录
4. 所有元数据写入 `paintings.json`

**使用方式：**
```bash
# 全部 1000 位画家
node scripts/fetch_paintings.mjs

# 指定 rank 范围
node scripts/fetch_paintings.mjs --rank 1-50
node scripts/fetch_paintings.mjs --rank 5       # 单一位
```

**配置常量：**
- `MAX_PAINTINGS_PER_ARTIST = 100` — 每位画家最多取 100 幅
- `QID_BATCH_SIZE = 15` — 每次 SPARQL 查询 15 个 QID
- 失败自动重试（5 次 API / 3 次下载），带退避

**`paintings.json` 字段：**
- `painter_id` / `painter_name` / `painter_qid` — 关联 `painters.json`
- `title` — 画作标题
- `painting_qid` — 画作 Wikidata ID
- `year` — 创作年份
- `collection` — 馆藏机构
- `material` — 材质（如 "Oil on canvas"）
- `genre` — 流派（如 "Portrait"）
- `image_url` — Commons 的 Special:FilePath URL
- `local_path` — 本地文件路径

## 画像图片 (`images/`)

`scripts/fetch_images.mjs` 从 Wikipedia 获取每位画家的肖像图片，下载至 `images/` 目录。路径记录在 `painters.json` 的 `image_path` 字段。

## 已知限制

### 网络限制
当前构建环境（/root/painterlist）无法直接访问 Wikimedia 系列域名（Wikipedia、Wikidata、Commons）。画作下载脚本需在能访问外网的机器上运行。

### 画作覆盖
- 知名博物馆藏品覆盖较好（Louvre、Met、Rijksmuseum 等有大量高清扫描）
- 私人收藏或未上传 Commons 的作品缺失
- Wikidata 中有图片记录的画作才被收录
