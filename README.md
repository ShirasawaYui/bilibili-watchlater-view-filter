# B站稍后再看 · 播放量筛选

在 B 站「稍后再看」列表页按播放量阈值筛选卡片，支持隐藏 / 淡化双模式。数据来自列表接口精确值，判定恒为 `≥`。

> **已完全兼容** [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved) 的「稍后再看重定向」功能。两个脚本可同时启用、互不干扰，筛选计数准确无误。

## 功能

- **播放量阈值筛选**：输入下限（支持 `10000` / `1.5万` / `2亿`），低于阈值的卡片被隐藏或淡化
- **隐藏 / 淡化双模式**：隐藏 = 不达标的卡片消失；淡化 = 不达标卡片留在原位变灰（opacity 0.22），方便核对
- **精确数据源**：一次请求 `x/v2/history/toview` 接口获取全部 BV 的精确播放量（整数），不依赖卡片上的缩写文本
- **临时显示全部**：一键唤回所有被筛掉的卡片，阈值不动，再点恢复
- **动态套用**：MutationObserver 自动检测无限滚动新增卡片并实时套用过滤
- **配置持久化**：阈值、启用状态、模式、面板主题自动保存到 localStorage，刷新不丢
- **亮 / 深主题切换**：面板标题栏一键切换亮色、深色；配色取自 B 站界面实色（面板底色比页面提/沉一档 + 描边 + 投影），暗色沉稳不突兀，控件边界清晰
- **降级容错**：接口不可用时自动降级为解析卡片缩写文本（约 ±5% 误差），面板黄色提示

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [ScriptCat 脚本猫](https://scriptcat.org/)
2. 点击下方链接安装脚本（或下载 `.user.js` 文件拖入管理器）

**[➤ 安装脚本](https://github.com/ShirasawaYui/bilibili-watchlater-view-filter/raw/main/bilibili-watchlater-view-filter.user.js)**

3. 打开 [B 站稍后再看](https://www.bilibili.com/watchlater/list)，右上角出现「播放量筛选」面板

## 使用

面板位于页面右上角：

```
播放量筛选                    [暗色]
播放量 ≥ [ 10000      ]
[✓] 启用  [●] 隐藏  ( ) 淡化  [临时显示全部]
──────────────────────────────
已淡化 28 / 可见 12 · 全量 948
数据源：接口精确值 ✓  未匹配 0
[刷新数据] [立即重算]
```

| 控件 | 说明 |
|---|---|
| 暗色 / 亮色（标题栏） | 一键切换面板主题，按钮文字显示当前主题，偏好自动保存 |
| 阈值输入框 | 支持纯数字、`1.5万`、`2亿`；清空 = 不筛 |
| 启用 | 功能总开关，取消勾选即全部还原 |
| 隐藏 / 淡化 | 被筛卡片的呈现方式 |
| 临时显示全部 | 阈值不变，唤回全部卡片；再点恢复筛选 |
| 刷新数据 | 重新请求接口获取最新播放量 |
| 立即重算 | 手动触发一次全量过滤 |

判定语义恒为 **`≥`（大于等于）**：阈值设 10000 时，恰好 10000 播放的视频**保留**。

## 与 Bilibili-Evolved 的兼容性

本脚本已针对 [Bilibili-Evolved](https://github.com/the1812/Bilibili-Evolved) 的「**稍后再看重定向**」功能做了完整适配：

该功能会将稍后再看列表页的卡片链接从 `/list/watchlater/?bvid=...` 改写为 `/video/BV.../`，并将卡片容器从 `<div>` 改写为 `<a>` 标签以实现整卡可点击跳转。本脚本的处理方式：

- **卡片选择器使用纯 class 匹配**（`.video-card--grid`），不限定 HTML 标签，`<div>` / `<a>` 均可命中
- **BV 号提取兼容三种结构**：卡片自身是 `<a href="/video/BV...">`、卡片内含 `a.bili-cover-card`、卡片内任意 `<a>` 链接含 BV 号
- **MutationObserver 监听子树变动**，插件包 wrapper 或替换节点后自动重新套用过滤

两个脚本同时启用时，筛选、计数、模式切换均正常工作，无冲突。

## 工作原理

```
页面加载 → fetch x/v2/history/toview → 构建 BV → 精确播放量 Map
                                                ↓
MutationObserver 检测 DOM 变动 → applyAll()
                                    ├─ 提取卡片 BV 号（三重回退）
                                    ├─ 查 Map 得精确播放量
                                    ├─ ≥ 阈值 → 清除过滤 class
                                    └─ < 阈值 → 添加 wlvf-hidden / wlvf-dim
```

- 不写内联 `display`，只增删自有 class，恢复时不干扰 B 站自身的 `v-show` 状态
- `@grant none`，运行在页面上下文，直接搭页面自己的 fetch 携带 cookie
- `@match` 仅限定 `watchlater/list*` 和 `list/watchlater*` 两个路径，不影响其他页面

## 已知限制

- 降级模式（接口不可用时）使用卡片缩写文本解析，精度约 ±5%
- B 站前端改版导致 class 名变化时，选择器需同步更新（集中在脚本顶部 `SELECTORS` 常量）
- 隐藏模式会压缩页面高度，可能促使无限滚动提前加载下一批卡片

## 致谢

思路参考（MIT，未复制代码）：
- [B站稍后观看时长统计助手](https://greasyfork.org/zh-CN/scripts/541838)（特比欧炸）— `@match` 作用域与深色适配思路
- [B站视频按播放数量过滤](https://greasyfork.org/zh-CN/scripts/438093)（cakiihana）— 阈值输入 / localStorage 持久化 / 隐藏-淡化交互模式

## License

[MIT](LICENSE)
