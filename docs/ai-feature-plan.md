# Sidebar Highlights — AI 功能开发计划

> 目标版本：v1.41.0 → v1.45.0（分 6 个里程碑迭代）
> 撰写日期：2026-09-02
> 基线：v1.40.3（`cc8f289`）

---

## 0. 现状核实

计划中的每条设计都基于对当前代码的实际检查，以下是与本次功能直接相关的既有事实：

| 事实 | 位置 | 对本计划的影响 |
| --- | --- | --- |
| 插件**没有任何网络调用**（无 `fetch` / `requestUrl`） | 全仓库 grep 无命中 | AI 是全新的能力面，需要从零建立 provider 抽象、错误处理与隐私边界 |
| 侧栏使用**自研的行内 Markdown 渲染器**，不是 Obsidian 的 `MarkdownRenderer` | `src/renderers/highlight-renderer.ts:459` `renderMarkdownToElement`，`:513` `parseMarkdownSegments` | 只支持 `**` `*` `~~` `` ` `` `[]()` `[[]]` 六种行内语法，**完全没有块级能力**，也就无从渲染 mermaid |
| 搜索命中高亮靠**遍历文本节点**实现 | `src/renderers/highlight-renderer.ts:410` `highlightSearchMatches` | 若整体换成 `MarkdownRenderer`，该逻辑会踩进 mermaid 生成的 SVG 内部，必须做子树排除 |
| 脚注定义解析**只取一行** | `main.ts:2568` `extractFootnotes`，正则 `/^\[\^(\w+)\]:\s*(.+)$/gm` | **这是 mermaid 写进评论的硬阻塞**：`.` 不匹配换行，多行脚注会被截断成第一行 |
| 行内脚注 `^[...]` 结构上不能含换行 | `src/managers/inline-footnote-manager.ts:80` | 多行 AI 结果只能走标准脚注 `[^n]:` 路径 |
| 评论渲染入口单一 | `src/renderers/highlight-renderer.ts:378` | 富渲染只需改一处，风险可控 |
| 设置为**单一扁平接口** + 版本化迁移 | `main.ts:106` `CommentPluginSettings`，`main.ts:169` `DEFAULT_SETTINGS`，`main.ts:453` 迁移分支 | AI 设置应作为嵌套子对象加入，并推进 `settingsVersion` |
| 备份只快照**四个关键字段** | `main.ts:791` `createBackup` 的 `criticalData` | 天然不含 AI 配置 —— **API Key 不会进备份文件**，这个性质要在加字段时守住 |
| `manifest.json` 声明 `isDesktopOnly: false` | `manifest.json` | 移动端必须可用，直接决定网络层选型（见 §4.2） |
| 构建为单文件 esbuild，externals 仅 obsidian/electron/codemirror | `esbuild.config.mjs` | **不引入 mermaid、markdown-it、SDK 等任何运行时依赖**，全部复用 Obsidian 内置能力 |
| i18n 为打包式 JSON，双语 | `src/i18n.ts`，`locale/en.json`、`locale/zh-cn.json` | 所有新文案必须同时补两份 |

---

## 1. 目标与非目标

### 目标

1. **Provider 可配置**：用户自行填写服务商、Base URL、API Key、模型，支持多套配置（Profile）并可切换与连通性测试。
2. **预置常用提示词**：总结、解释、翻译、追问、提取标签、生成图示，开箱即用。
3. **自定义提示词**：用户可增删改自己的提示词，带变量插值，可导入导出。
4. **Mermaid 与富内容渲染**：评论与 AI 生成内容中的 mermaid 代码块、表格、列表、代码块能在侧栏正确渲染，并可放大查看。
5. **AI 结果可落盘**：生成结果以标准 Markdown 脚注写回笔记，不引入私有格式 —— 与插件"没有此插件也读得懂"的既有理念一致。

### 非目标（本轮明确不做）

- 不做向量检索 / RAG / 全库语义搜索。
- 不做多轮对话式聊天面板（结果面板仅支持"重新生成 / 追加一句要求"）。
- 不做本地模型推理（但支持指向本地 OpenAI 兼容服务，如 Ollama / LM Studio）。
- 不做云端同步的提示词市场。
- 不自带 mermaid 运行时，完全依赖 Obsidian 已注册的代码块处理器。

---

## 2. 总体架构

```
main.ts
 ├─ settings.ai: AiSettings                    // 新增设置子树
 └─ aiService: AiService                       // 插件生命周期内单例

src/ai/
 ├─ types.ts                 AiProfile / AiRequest / AiResult / AiError / PromptPreset
 ├─ registry.ts              内置 provider 描述表（默认 URL、鉴权方式、默认模型）
 ├─ providers/
 │   ├─ provider.ts          Provider 接口 + 共用的响应/错误归一化
 │   ├─ openai-compatible.ts OpenAI / DeepSeek / Moonshot / SiliconFlow / OpenRouter / Ollama / LM Studio
 │   ├─ anthropic.ts         Messages API
 │   └─ gemini.ts            generateContent
 ├─ ai-service.ts            调度：解析 Profile → 组装消息 → 调用 → 归一化错误 → 中止
 ├─ prompt-library.ts        内置预设 + 用户预设 + 变量插值
 └─ context-builder.ts       {{selection}} {{comments}} {{note}} … 的取值与裁剪

src/renderers/
 └─ rich-markdown-renderer.ts   块级渲染（mermaid/表格/代码/列表），懒渲染 + 降级

src/modals/
 ├─ ai-result-modal.ts          结果预览：插入/复制/重生成/追加要求
 ├─ ai-prompt-editor-modal.ts   自定义提示词 CRUD
 └─ diagram-zoom-modal.ts       mermaid 放大查看
```

**依赖方向**：`views` / `renderers` → `ai` → `obsidian`。`src/ai/` 不反向依赖 UI，便于用 jest 直接单测。

---

## 3. 数据模型

追加到 `CommentPluginSettings`（`main.ts:106`），作为一个嵌套子对象，避免把二十多个字段摊平进已经很长的扁平接口：

```ts
export interface AiProfile {
    id: string;
    name: string;                 // 用户可读名，如 "DeepSeek 主力"
    providerId: BuiltinProviderId | 'custom';
    baseUrl: string;
    apiKey: string;               // 明文存于 data.json，见 §7
    model: string;
    temperature?: number;
    maxTokens?: number;
    extraHeaders?: Record<string, string>;
}

// 运行时视图：所有字段都已解析
export interface PromptPreset {
    id: string;
    name: string;
    icon?: string;                // lucide 图标名
    system?: string;
    template: string;             // 含 {{变量}} 的用户消息模板
    builtin: boolean;             // 内置预设不可删，只可"覆盖"
    outputTarget: 'preview' | 'comment' | 'both';
    enabled: boolean;
    sortOrder: number;
}

// 落盘形式：对内置 id 而言这是**补丁**而非整份拷贝。
// 停用一个内置预设只写入 { id, enabled: false }，模板仍跟随插件版本更新；
// 存整份拷贝会把模板永久冻结在用户点开关那一刻的版本。删掉补丁即恢复出厂。
export interface StoredPrompt {
    id: string;
    name?: string; icon?: string; system?: string; template?: string;
    outputTarget?: 'preview' | 'comment' | 'both';
    enabled?: boolean; sortOrder?: number;
}

export interface AiSettings {
    enabled: boolean;             // 总开关，默认 false
    profiles: AiProfile[];
    activeProfileId: string | null;
    prompts: StoredPrompt[];      // 仅存用户新增的与对内置的补丁
    defaultTargetLanguage: string;
    contextCharLimit: number;     // 默认 4000，注入正文上下文的上限
    includeNoteContext: boolean;  // 默认 false：默认只发高亮本身
    includeExistingComments: boolean;
    confirmBeforeSend: boolean;   // 默认 true，首次发送前确认
    streaming: boolean;           // 默认 false，见 §4.2
    renderRichContent: boolean;   // 评论富渲染总开关，默认 true
    renderMermaid: boolean;       // 默认 true
    maxDiagramHeight: number;     // 侧栏内图示最大高度 px，默认 320
}
```

**不要提升 `settingsVersion`。** 实施时核实：`migrateSettings`（`main.ts:1508`）从 `{...DEFAULT_SETTINGS}` 重建后只显式拷回 14 个字段，`displayModes`、`customPatterns`、`tabSettings`、`fileFilters`、`collapsedGroups`、各字号与全部任务设置都不在名单内 —— 一旦版本号变化，这些设置会被静默重置。改为版本号保持 `'1.14.0'`，只在 `safeMergeSettings`（`main.ts:481`）里为 `ai` 做深合并；`merged` 是浅拷贝，因此必须克隆，否则编辑 profile 会改到模块级的默认对象。

---

## 4. 里程碑

### M0 — 基础设施与 Provider（预计 1.5 天）

**产出**

- `src/ai/types.ts`、`src/ai/registry.ts`、`src/ai/providers/*`、`src/ai/ai-service.ts`
- 设置页新增 **AI** 区块（`main.ts:3221` `HighlightSettingTab.display()` 内，紧随 Comments 区块之后）
- Profile 的增删改、切换、"测试连接"按钮

**内置 provider 描述表**

| id | 默认 Base URL | 鉴权 | 备注 |
| --- | --- | --- | --- |
| `openai` | `https://api.openai.com/v1` | `Authorization: Bearer` | |
| `anthropic` | `https://api.anthropic.com/v1` | `x-api-key` + `anthropic-version` | 见 §4.2 的浏览器直连头 |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` | |
| `deepseek` | `https://api.deepseek.com/v1` | Bearer | OpenAI 兼容 |
| `moonshot` | `https://api.moonshot.cn/v1` | Bearer | OpenAI 兼容 |
| `siliconflow` | `https://api.siliconflow.cn/v1` | Bearer | OpenAI 兼容 |
| `openrouter` | `https://openrouter.ai/api/v1` | Bearer | OpenAI 兼容 |
| `ollama` | `http://localhost:11434/v1` | 无 | OpenAI 兼容 |
| `lmstudio` | `http://localhost:1234/v1` | 无 | OpenAI 兼容 |
| `custom` | 用户填写 | 用户选择 | 兜底 |

九个里有六个复用同一个 `openai-compatible.ts`，真正需要单独实现的只有 Anthropic 与 Gemini。

#### 4.1 Provider 接口

```ts
export interface Provider {
    readonly id: string;
    complete(req: AiRequest, signal: AbortSignal): Promise<AiResult>;
    stream?(req: AiRequest, signal: AbortSignal): AsyncIterable<string>;
    listModels?(profile: AiProfile): Promise<string[]>;
}
```

`stream` 为可选：M0 阶段所有 provider 只实现 `complete`。

#### 4.2 网络层选型 —— 关键约束

这是本计划里最容易踩坑的一处，先把结论写死：

- **默认走 Obsidian 的 `requestUrl`**。它绕过 CORS、桌面与移动端行为一致，但**不支持流式**，只能等完整响应。
- **流式走原生 `fetch` + `ReadableStream`**，作为 `streaming: true` 时的可选路径，且必须能优雅回退：一旦 `fetch` 抛错（CORS、证书、移动端 WebView 限制），自动降级为 `requestUrl` 非流式重试一次，并在 Notice 中说明。
- **Anthropic 从浏览器上下文直连需要 `anthropic-dangerous-direct-browser-access: true` 头**，否则会被 CORS 拒绝。走 `requestUrl` 时不需要，走 `fetch` 流式时必须带上。这个差异要写进 `anthropic.ts` 的注释里，否则以后一定有人踩。
- 移动端（`Platform.isMobile`）强制 `requestUrl`，并在设置页把"流式输出"开关标注为"仅桌面端"。

因此 **M0 只做非流式**，流式推迟到 M5 —— 先让功能跑通、正确，再谈体验。

#### 4.3 错误归一化

所有 provider 的失败都归一到 `AiError { kind, message, status?, retriable }`，`kind` 取值：`auth` / `rate-limit` / `quota` / `network` / `timeout` / `bad-request` / `server` / `aborted` / `unknown`。UI 只认 `kind`，文案走 i18n。

**API Key 绝不出现在任何 `console` 输出或 Notice 文案里** —— 错误对象在归一化时就要把 header 剥掉。

**验收**：填入一个 OpenAI 兼容 Key，点"测试连接"返回模型可用；Key 错误时提示"鉴权失败"而非抛原始 JSON；断网时提示"网络不可达"。

---

### M1 — 提示词库（预计 1.5 天）

**内置预设**（`src/ai/prompt-library.ts` 中以常量定义，随插件版本演进）

| id | 名称 | 模板要点 |
| --- | --- | --- |
| `summarize` | 总结 | 把 `{{selection}}` 压缩成 3 条要点，保留原文术语 |
| `explain` | 解释 | 用通俗语言解释 `{{selection}}`，必要时举一个例子 |
| `translate` | 翻译 | 将 `{{selection}}` 翻译成 `{{targetLang}}`，只输出译文 |
| `ask` | 追问 | 针对 `{{selection}}` 提出 3 个值得深挖的问题 |
| `tags` | 提取标签 | 输出 3–5 个 `#tag`，直接可粘进笔记 |
| `diagram` | 生成图示 | **要求仅输出一个 ```mermaid 代码块**，据 `{{selection}}` 画出其中的流程或关系 |

`diagram` 是把 §5 的渲染能力接到用户手上的那条线：预设产出 mermaid，富渲染负责把它画出来。

**变量**

`{{selection}}`（高亮正文）、`{{comments}}`（该高亮已有评论，换行拼接）、`{{note}}`（整篇正文，受 `contextCharLimit` 截断）、`{{context}}`（高亮前后各 N 字）、`{{noteTitle}}`、`{{filePath}}`、`{{tags}}`、`{{collection}}`、`{{targetLang}}`、`{{input}}`（触发时弹出输入框现填）。

未知变量原样保留并在预览里标黄，不静默吞掉。

**自定义**

`ai-prompt-editor-modal.ts` 提供：名称、图标、system、模板（多行 textarea，下方列出可用变量，点击插入）、输出目标、启用开关、排序。内置预设可"复制为自定义"或"就地覆盖"，覆盖后可一键还原。整个 `prompts` 数组支持 JSON 导入导出，方便分享。

**验收**：新建一个自定义提示词并在侧栏调用成功；导出 JSON 后清空设置再导入，提示词完整还原。

---

### M2 — 交互入口与结果面板（预计 2.5 天）

**入口（三处）**

1. **高亮卡片右键菜单**：`src/renderers/highlight-renderer.ts` 的 `options.onContextMenu` 已有回调，在 `sidebar-view.ts` 的实现里追加一个 "AI" 子菜单，列出已启用的预设。
2. **卡片操作区图标**：`addActionButtons`（`highlight-renderer.ts:361`，目前是空壳，只建了个 `comment-buttons` 容器）里加一个 sparkles 图标按钮，点击弹出同样的预设菜单。这个空方法正好是为此预留的位置。
3. **命令面板**：为每个启用的预设注册命令（`AI: 总结当前高亮` 等），可绑快捷键；作用对象是当前选中的高亮，没有选中则取编辑器当前选区。

**结果面板** `ai-result-modal.ts`

- 顶部：预设名 + 使用的 Profile/模型，可即时切换 Profile 重跑
- 主体：**用 §5 的富渲染器渲染**，因此 mermaid 结果在这里就能直接看到
- 生成中显示 spinner 与"停止"按钮（`AbortController`）
- 底部：`插入为评论` / `复制` / `重新生成` / `追加要求`（在原请求后再补一条 user 消息重跑）
- Esc 关闭时若正在生成，先 abort 再关

**发送前确认**：`confirmBeforeSend` 为 true 时，首次对某个 vault 发送前弹一次确认，明确告知"以下内容将发送到 {provider} 的 {baseUrl}"并展示实际载荷字符数。勾选"不再提示"后写回设置。

**验收**：选中高亮 → 右键 → 总结 → 面板流出结果 → 插入为评论 → 侧栏该高亮下出现新评论且笔记文件已改动。

---

### M3 — 写回与多行脚注支持（预计 2 天）

**这是全计划技术风险最高的一环**，因为它要动已被大量测试覆盖的既有解析路径。

**问题**：`extractFootnotes`（`main.ts:2568`）的正则 `/^\[\^(\w+)\]:\s*(.+)$/gm` 中 `.` 不匹配换行，所以

```markdown
[^1]: 这是 AI 生成的图示
    ```mermaid
    graph TD; A-->B;
    ```
```

只会被读成 `这是 AI 生成的图示`，后面三行全部丢失。而 Obsidian 本身是支持这种缩进续行的多行脚注的 —— 也就是说当前解析比 Obsidian 更窄。

**改造范围**（每一处都要动，漏一处就会产生孤儿定义或误删）：

| 位置 | 改动 |
| --- | --- |
| `main.ts:2568` `extractFootnotes` | 改为逐行扫描：遇到 `[^key]:` 起头后，持续吸收后续「空行」或「以 4 空格 / Tab 缩进」的行，直到遇到非缩进的非空行为止；拼接时剥掉统一缩进 |
| `main.ts:1876` 附近的孤儿定义清理 | 删除定义时要连同其所有续行一起删，不能只删首行 |
| 写入路径（M3 新增 `src/ai/comment-writer.ts`） | 多行内容写为标准脚注并对续行加 4 空格缩进；单行内容维持现有行为（尊重 `useInlineFootnotes` 设置） |
| `src/renderers/highlight-renderer.ts:378` | 渲染前不再假定内容是单行 |

**兼容性要求**：`extractFootnotes` 的现有单行行为必须**逐字节不变**。先补一组针对现有行为的快照测试，再改实现 —— 这一步不能省。

**新增测试** `src/utils/multiline-footnote.test.ts`：单行定义、4 空格续行、Tab 续行、中间夹空行、续行里含 ``` 围栏、两个定义相邻、定义后紧跟正文段落（不应被吸收）、CRLF 换行。

**验收**：把一个含 mermaid 围栏的多行脚注写进笔记，重载插件后侧栏完整显示；删除该高亮时脚注定义被整块清除，笔记里不留残行。

---

### M4 — Mermaid 与富内容渲染（预计 2.5 天）

**核心思路：两级渲染，而不是整体替换。**

现有的 `renderMarkdownToElement` 又快又可控，且搜索高亮逻辑依赖它产出的扁平文本节点。直接换成 `MarkdownRenderer` 会同时损失性能和搜索高亮。所以：

```ts
// src/renderers/rich-markdown-renderer.ts
const BLOCK_HINT = /^\s{0,3}(```|~~~|#{1,6}\s|>\s|[-*+]\s|\d+\.\s|\|)/m;

export function needsRichRender(text: string): boolean {
    return BLOCK_HINT.test(text);
}
```

- **不含块级构造** → 沿用 `renderMarkdownToElement`（绝大多数评论走这条路，零成本）
- **含块级构造** → 走 `MarkdownRenderer.render(app, text, el, sourcePath, component)`

**实现要点**

1. **生命周期**：`MarkdownRenderer.render` 需要一个 `Component`。为每次富渲染创建 `MarkdownRenderChild`，并 `component.addChild(child)` 挂到侧栏视图（`HighlightsSidebarView` 继承自 `ItemView`，本身就是 Component）。**列表重建时必须解绑**，否则 mermaid 的 observer 会泄漏。
2. **懒渲染**：用一个共享的 `IntersectionObserver`，卡片进入视口才触发富渲染，占位符先按估算高度撑开，避免滚动跳动。侧栏可能同时有上百个高亮。
3. **异步与失败降级**：mermaid 语法错误会抛异常且是异步的。用 `try/catch` + `MutationObserver` 检测 `.mermaid` 容器内是否出现错误节点；失败时把该块降级为普通 `<pre><code>` 并在角上给一个"语法错误"提示，**绝不让整条评论渲染失败**。
4. **搜索高亮兼容**：`highlightSearchMatches` 增加子树排除 —— 跳过 `svg`、`pre`、`code`、`.mermaid`、`math` 内部的文本节点。否则会往 SVG 的 `<text>` 里插 `<span>`，把图画坏。
5. **窄侧栏适配**：
   - `.highlight-comment .mermaid svg { max-width: 100%; height: auto; }`
   - 容器 `overflow-x: auto`，`max-height: var(--sh-diagram-max-height)`（绑定 `maxDiagramHeight` 设置），超出时底部渐隐并显示"点击放大"
   - 点击打开 `diagram-zoom-modal.ts`：全屏模态、滚轮缩放、拖拽平移、复制源码、导出 SVG
6. **主题**：不做任何主题干预。Obsidian 内置的 mermaid 处理器已跟随明暗主题，自己插手只会在用户换主题时出错。
7. **点击穿透**：评论区已有 `commentDiv` 的 click 跳转监听（`highlight-renderer.ts:379`）。富渲染后内部会出现链接、复选框、SVG，必须在这些元素上 `stopPropagation`，否则点图等于点评论、会跳走。

**设置项**：`renderRichContent`（总开关）、`renderMermaid`、`maxDiagramHeight`。关掉后完全回到 v1.40 行为，给性能敏感的用户一条退路。

**验收**：含 mermaid 的评论在侧栏渲染为图；点击放大可缩放拖拽；故意写错语法时降级为代码块且其余部分正常；一屏 200 条高亮时滚动不卡顿（Performance 面板长任务 < 50ms）。

---

### M5 — 流式、批量与打磨（预计 2 天）

- **流式输出**：为 `openai-compatible` / `anthropic` / `gemini` 实现 `stream()`，SSE 解析共用一个 `parseSse` 工具。桌面端可用，移动端与失败时按 §4.2 回退。结果面板边流边渲染 —— 但**富渲染只在流结束后跑一次**，流式过程用纯文本，避免半截 mermaid 反复抛错。
- **批量操作**：对一个 Collection 或当前笔记的全部高亮批量执行某个预设。串行执行 + 进度条 + 随时中止 + 失败项汇总，绝不并发轰炸 API。
- **用量记录**（可选）：记录每次调用的 tokens 与预估成本，设置页展示本月累计，可清空。纯本地。
- **i18n**：`locale/en.json` 与 `locale/zh-cn.json` 补齐 `ai.*` 全部键。
- **文档**：README 新增 "AI" 章节；CHANGELOG 记录；设置页 AI 区块顶部放一段隐私说明。

---

## 5. 安全与隐私

这是一个操作用户全部笔记内容的插件接上外部网络，隐私边界必须显式设计，而不是"顺便"。

1. **默认关闭**：`ai.enabled` 默认 `false`。用户不配置就完全没有网络行为。
2. **默认最小上下文**：`includeNoteContext` 默认 `false` —— 默认只发送高亮文本本身，而不是整篇笔记。想发整篇要用户自己勾。
3. **发送前确认**：首次发送弹窗明示目标 URL、provider 与载荷大小。
4. **Key 存储**：明文存在 `data.json`，这是 Obsidian 插件的现实约束，**必须在设置页直说**："API Key 以明文保存在 `.obsidian/plugins/sidebar-highlights/data.json`，该文件会随 vault 同步。请勿在共享 vault 中填写。" 输入框用 `type="password"`，旁边给显示/隐藏切换。
5. **不进备份**：`createBackup`（`main.ts:791`）目前只快照 `settingsVersion` / `collections` / `customColorNames` / `highlights` 四项，AI 配置天然不在其中 —— **加字段时要守住这条**，在该函数上方加一行注释说明为什么 `ai` 不应该被加进去。
6. **不进日志**：错误归一化时剥除所有 header；任何 `console.error` 前先过一遍脱敏函数。
7. **不做遥测**：插件不向任何非用户配置的地址发起请求。

---

## 6. 测试计划

| 层级 | 范围 | 文件 |
| --- | --- | --- |
| 单测 | 变量插值：全部变量、未知变量、嵌套花括号、空值 | `src/ai/prompt-library.test.ts` |
| 单测 | 上下文裁剪：超长笔记按 `contextCharLimit` 截断且不切断多字节字符 | `src/ai/context-builder.test.ts` |
| 单测 | 请求构造与错误归一化：各 provider 的 body 形状、401/429/500/超时/abort 映射 | `src/ai/providers/*.test.ts`（mock `requestUrl`） |
| 单测 | **多行脚注解析**（重点）：见 M3 用例清单 | `src/utils/multiline-footnote.test.ts` |
| 单测 | `needsRichRender` 判定：围栏、表格、列表、引用、标题、行内代码（不应触发） | `src/renderers/rich-markdown-renderer.test.ts` |
| 单测 | 搜索高亮子树排除：SVG/pre/code 内的文本节点不被改写 | 扩展现有 `markdown-renderer.test.ts` |
| 回归 | `extractFootnotes` 现有单行行为逐字节不变 | 改动前先补快照测试 |
| 手测 | 每个 provider 各跑通一次真实调用（含本地 Ollama） | — |
| 手测 | 移动端（iOS/Android）：`requestUrl` 通路、mermaid 渲染、窄屏放大模态 | — |

`jest` + `jest-environment-jsdom` 已配置好，provider 测试全部 mock `requestUrl`，**不得在 CI 中发起真实网络调用**。

---

## 7. 风险清单

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 多行脚注改造破坏既有解析 | 高 —— 会影响所有用户的存量评论 | 改动前先补快照测试锁住现有行为；改动只扩不改；灰度到一个 patch 版本单独发 |
| `MarkdownRenderer` 拖慢侧栏 | 中 | 两级渲染 + `IntersectionObserver` 懒渲染 + 总开关可关 |
| mermaid 语法错误导致整条评论渲染失败 | 中 | 逐块 try/catch + 降级为代码块 |
| Obsidian 内部 mermaid 实现变更 | 中 | 不依赖其内部 DOM 结构，只依赖公开的 `MarkdownRenderer.render` |
| 移动端 CORS / WebView 限制 | 中 | 移动端强制 `requestUrl`；流式仅桌面 |
| 用户误把整个 vault 发给外部 API | 高（隐私） | 默认最小上下文 + 发送前确认 + 明确文案 |
| Key 随 vault 同步泄漏 | 高 | 设置页显式警告 + 排除出备份 |
| 富渲染后点击事件冲突 | 低 | 内部交互元素统一 `stopPropagation` |

---

## 8. 排期汇总

| 里程碑 | 内容 | 工作量 | 可独立发布 |
| --- | --- | --- | --- |
| M0 | Provider 抽象 + 设置 + 连通性测试 | 1.5 天 | 否 |
| M1 | 提示词库（内置 + 自定义） | 1.5 天 | 否 |
| M2 | 交互入口 + 结果面板 | 2.5 天 | ✅ v1.41.0（AI 基础可用） |
| M3 | 多行脚注 + 写回 | 2 天 | ✅ v1.42.0（单独发，便于回滚） |
| M4 | Mermaid 与富渲染 | 2.5 天 | ✅ v1.43.0 |
| M5 | 流式 + 批量 + 打磨 | 2 天 | ✅ v1.44.0 |

**合计约 12 个工作日。**

建议顺序上把 **M3 单独发一个版本**：它动的是存量数据的解析路径，一旦有问题要能干净回滚，不该和 AI 的新代码混在同一个版本里。

---

## 实施记录

| 里程碑 | 状态 | 与计划的偏离 |
| --- | --- | --- |
| M0 | 已完成 | 不提升 `settingsVersion`（原因见 §3）；另需给 `tsconfig.json` 加 `typeRoots`，否则构建会被仓库外的 `@types/d3-dispatch` 打断 |
| M1 | 已完成 | 内置预设的覆盖改存补丁而非整份拷贝（见 §3 的 `StoredPrompt`）；`parseStoredPrompts` 放在 `prompt-library.ts` 而非 modal 中，以便脱离 Obsidian UI 单测 |
| M2 | 已完成 | 入口三处：卡片 AI 按钮（复用 `comment-buttons` 容器）、右键菜单顶部、命令面板（`registerAiPromptCommands`，设置区每次重渲染后同步重注册，改名/删除即时生效）；插入评论走 `vault.process` 而非编辑器，未打开的笔记也能写入且并发安全；高亮定位用"最近匹配"策略，找不到时不写盘并提示 `ai.run.highlightMoved`；`formatForFootnote` 暂保持单行折叠（M3 放宽解析器后再开多行）；结果面板支持追问、切换 profile 重跑、重新生成、中止 |
| M3 | 已完成 | 解析器抽到独立模块 `src/utils/footnote-parser.ts`（`extractFootnoteDefinitions` / `removeFootnoteDefinition` / `locateFootnoteDefinition`），`main.ts` 的 `extractFootnotes` 与孤儿清理都改为调用它，三者共用同一套「定义边界」判定，写入、读回、删除不会各说各话；**一处行为收窄**：`[^1]:` 后为空时旧正则会把下一行吸为内容（等于把无关段落算作评论），新实现视为没有定义；计划未列出的一处补漏：`sidebar-view.ts` 点击评论定位到编辑器时仍按单行选中，已改为选中整块定义；`.highlight-comment` 加 `white-space: pre-wrap`，否则多行评论在侧栏被挤成一行（块级渲染留给 M4）
| M4 | 已完成 | **范围调整**：富渲染不再受 `ai.enabled` 约束——用户最初的诉求是「mermaid 显示评论和 AI 生成的内容」，存量评论里的图不该因为没开 AI 就不渲染；设置项因此提到 AI 开关之外；生命周期用 `releaseDetachedRenders()`（列表重建、单卡更新、视图关闭三处调用）按 `isConnected` 回收，而不是让 `MarkdownRenderChild` 挂在视图上直到面板关闭；mermaid 源码在渲染后立刻以 `data-sh-diagram-source` 钉在各图节点上——降级会移除 `mermaid` 类，按位置查找会让后续图配错源码；导出 SVG 改为复制 SVG 到剪贴板，不往 vault 里写文件；`locale-keys` 的 parity 范围同时补齐 M2/M4 命名空间（原先只覆盖 `ai.` 和 `settings.ai.`，`modals.aiResult.*` 等缺失不会被发现）
| M5 | 已完成 | 流式：SSE 解析抽为 `src/ai/providers/sse.ts`（有状态增量解析器，因为事件常跨 chunk 到达，按 `\n\n` 切分会静默丢尾），三个 provider 的 body 构造与非流式共用一个 `buildBody`，避免两条路径漂移；Anthropic 的 `anthropic-dangerous-direct-browser-access` 头只在 `fetch` 路径加；超时语义改为「静默超时」而非总时长——长回答持续产出是健康的，停止产出才不是；回退只针对传输层失败，`aborted`/`auth`/`bad-request` 直接抛出不重试。批量：串行 + 350ms 间隔 + Notice 内嵌进度与停止按钮，`insertAiComment` 加 `quiet` 模式避免每条一个 Notice；入口是命令面板（当前笔记全部高亮），未做 Collection 批量入口。用量：只存本月累计的调用数与 token 数，**不记录任何提示词或回答**——逐次日志等于把用户读过什么明文存进 vault；`addUsage` 为纯函数，跨月归零规则可单测。`fetch` 的 lint 警告保留未豁免：仓库配置禁止 `eslint-comments/no-restricted-disable`，改为就地注释说明理由

已知的既有问题，非本次引入、也未修改：`locale/zh-cn.json` 缺 9 个键，均在 `settings.typography` 下（`fontWeight.*`、`highlightTextWeight.*`、`taskTextWeight.*`），中文用户在这几处看到的是英文。因此 locale parity 测试收窄到只覆盖 AI 子树。

---

## 9. 待定项

以下几点按推荐方案先行，若你有不同取向可在 M2 开工前调整：

1. **AI 结果的落点** —— 推荐"先在面板预览，用户确认后写为评论"，而非直接写盘。理由是 AI 结果需要人过一眼，且这样天然支持"复制走、不落盘"的用法。
2. **内置提示词是否可删** —— 推荐不可删只可禁用/覆盖，避免用户删掉后无从恢复。
3. **是否记录用量** —— 推荐做，但默认关闭，纯本地不上报。
