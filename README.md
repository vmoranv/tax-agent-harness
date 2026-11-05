# 财税 Agent Harness

> 云帐房 AI 技术创新大赛 · 赛题二初赛作品
> 一个把 **模型理解**、**任务记忆**、**规则知识** 和 **业务工具** 连起来的运行程序。

---

## 这是什么

用户问「甲企业 9 月发票和银行收支多少」，或者「乙企业 9 月哪些发票还没填用途」，或者「把 F002 的用途补上」——系统需要连续地查数据、查规则、判断缺项、追问、保存、复核，并在下一次对话里接着做。

这个项目实现的就是这条链路。

**它不是一个聊天机器人**：模型负责理解你要做什么，程序负责算钱、查权限、存数据、留证据。

---

## 三个场景，一条链路

| 场景 | 用户说什么 | 系统做什么 |
|---|---|---|
| **查询资料** | 「甲企业 9 月金额」 | 分别统计发票合计 / 银行收入 / 银行支出，同时给出适用规则名称与版本 |
| **补充保存** | 「F002 用途填办公用品采购」 | 校验企业→发票→权限→字段→内容，保存，**回读复核**，回报旧值新值 |
| **多轮检查** | 「乙企业 9 月哪些缺用途」 | 按适用规则判定，把「必须填」与「允许为空」分开列出，进度写进任务卡跨会话可续 |

三者共用同一个 `Pipeline`，没有按关键词分流——赛题明令禁止。

---

## 快速开始

```bash
# 需要 Node.js ≥ 22.5（内置 node:sqlite）
node -v

pnpm install
pnpm build

cp .env.example .env            # 填入 OpenAI 兼容端点
pnpm harness doctor             # 环境自检

pnpm harness db init --import ./fixtures/excel/02_示例数据.xlsx
# → verification.matched: true

pnpm harness chat --user U001 --enterprise C001
```

Web 演示台：

```bash
pnpm harness web --port 9601
```

一键跑完三场景：

```bash
pnpm harness demo --scenario all
```

详细步骤见本地 `docs/runbook.md`（文档目录已加入 `.gitignore`，仅本地留存、不入库）。

---

## 设计要点

### 模型与程序的边界不靠 prompt，靠类型

| 机制 | 落地 |
|---|---|
| 工具入参无计算结果字段 | schema 里根本没有 `total` / `allowed`，模型想填也无处可填 |
| 插件拿不到仓储 | 插件包不依赖 `application` 包，`dependency-cruiser` 在 CI 强制 |
| 权限只在领域层判定 | `AccessPolicy` 是唯一实现，工具层只调用不复刻 |
| 保存后必须复核 | 用例最后一步重读存储比对，不一致即抛错 |
| 金额用整数分 | `Money` 值对象内部 `bigint` 分，跨层零浮点 |
| 回复数字可溯源 | 逐个在工具结果账本里查找，找不到就重试或移除 |

### 三个必须做对的地方

1. **同编号跨企业**：`F001` 在 C001 和 C002 都存在，主键是 `(企业编号, 发票编号)`
2. **乙企业只有 3 张不合规**：`F002(1000.00)` `F005(1000.01)` `F006(1280.50)`；`F001(600.00)` `F004(999.99)` `F009(486.75)` 允许为空
3. **甲企业 9 月必须用 R002 2.0 版**：1.0 已停用，2.0 每张必填无金额门槛

---

## 技术栈

| 层 | 选型 | 备注 |
|---|---|---|
| 语言 | TypeScript 5.9 / Node 22 | `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| 包管理 | pnpm workspace | 6 个包，依赖方向物理隔离 |
| LLM | `ai@7` + `@ai-sdk/openai-compatible@3` | `stopWhen: isStepCount(n)` 提供多步工具循环 |
| 校验 | zod 4 | 同一份 schema 复用为工具参数与用例入参 |
| 存储 | `node:sqlite` | 零原生依赖，`pnpm install` 不下载二进制 |
| Excel | exceljs 4 | 导入后自动核对金额 |
| CLI | commander 15 | 主入口 |
| 后端 HTTP | fastify 5 | REST + SSE |
| 前端 | Vue 3.5 + Vuetify 3.7 + Pinia | 与 WebUI 工作台 同栈 |
| 测试 | vitest 5 | 22 个测试文件 / 约 315 个 it() 块（本地与 CI 快速回归） |
| Lint | Biome 2 | 一个工具顶 ESLint + Prettier |
| 架构 | dependency-cruiser 18 | 依赖规则作为 CI 断言 |

---

## 目录

```
packages/
  domain/            纯领域：聚合、值对象、领域服务、领域事件（零外部依赖）
  contracts/         端口接口、DTO、插件契约、错误码
  application/       用例编排（唯一的事务与校验边界）
  runtime/           Harness 本体：pipeline / agent / context / tools / plugin / trace
  adapters/          sqlite 仓储、LLM provider、excel 导入
  plugins-builtin/  9 个内置插件
apps/
  cli/               命令行
  server/            后端 HTTP（fastify + SSE）
  web/               本地演示台（Vue 3 + Vuetify）
docs/              （本地留存，已加入 .gitignore，不入库：spec/、runbook、设计说明、演示脚本）
fixtures/
  excel/             赛题原始数据副本（只读）
  eval/              评测数据集（40 票 + 48 流水 + 5 规则 + 权限矩阵）
tools/
  eval/              评测中台执行器（244 例：L1–L7，240 PASS、4 MANUAL）
```

依赖方向：`apps → adapters/plugins → runtime → application → contracts → domain`

---

## 文档

完整规格文档、运行手册、设计说明与演示脚本均**本地留存于 `docs/`，已加入 `.gitignore` 不入库**（因此本仓库不含 `docs/` 目录）。需要在本地查阅；评测集与验证命令见下文「验证」与各 `pnpm` 脚本。


---

## 验证

```bash
pnpm verify              # typecheck + lint + 依赖规则 + 单测 + 覆盖率门禁 + 评测集
pnpm test                # 仅单元测试
pnpm dep:check           # 仅架构依赖检查
pnpm eval                # 评测中台：244 例 L1–L7 + 黄金集 50 条 + 集合/向量 IR 指标（统一报告，门禁内）
pnpm eval:cov            # 仅覆盖率门禁（REQ 18/18，INV 22/22）
pnpm eval:report         # 生成 Markdown 报告（含黄金集 / 向量检索诊断对照）
pnpm eval:golden         # 单独跑黄金集（50 条，retrieval/answer 分开计分）
pnpm eval:semantic:gen      # 生成真模型语义变体集（26 条，独立 gold）
pnpm eval:semantic:live     # 真模型语义评测（LLM 参与评分，需 apikey + 服务；不进 verify / CI）
pnpm eval:semantic:live:json    # JSON 结果（含按切片统计）
pnpm eval:semantic:live:report  # 该评测的 Markdown 报告
pnpm eval:heldout:gen   # 生成 held-out 泛化探针集（14 条，与训练集零重叠）
pnpm eval:heldout       # held-out 泛化评测（需 apikey + 服务；不进 verify / CI）
```

### 测试与评测体系说明

本项目有**三套相互独立、主题有重叠**的验证体系，三者**不重复计数**，
不能把两边的数字相加当成「总测试数」。此外 `pnpm eval` 中台还**内嵌**两类
检索指标与真模型语义层，均在同一份统一报告里产出：

| 体系 | 规模（大致） | 定位 | 运行方式 |
|---|---|---|---|
| vitest 单测 | 22 个测试文件、约 315 个 `it()` 块（`pnpm test` 报 25 files / 364 tests，含嵌套用例与 dist-test 副本） | 本地 / CI 快速回归，覆盖各包的函数级行为 | `pnpm test` |
| eval 评测中台 | 244 例（L1–L7），当前 240 PASS、4 MANUAL | 面向评委的可核对证据，基于确定性真值（整数分、数据库状态、工具轨迹）做全链路断言 | `pnpm eval` |
| golden 黄金评测集 | 50 条、7 切片、版本冻结（`fixtures/eval/golden-cases.json`） | 对标业界 50-200 条标准黄金集：`question + gold_answer + gold_sources + slice_tag`，retrieval/answer 分开计分；gold 由独立重算生成，非被测代码 | **已接入 `pnpm eval`（统一报告 + 门禁）**；也可单独 `pnpm eval:golden` / `eval:golden:gen` |

| 中台内嵌能力 | 说明 | 运行方式 |
|---|---|---|
| 集合 IR 指标 | 确定性 `selectApplicableRules` 的 Precision/Recall/F1（P/R/F1 = 100%），非向量 | `pnpm eval` 报告「三」 |
| 向量检索诊断对照 | 本地确定性哈希嵌入 + 余弦 top-K 的 **P/R/F1 ≈ 58.3%（⚠️ 非评分）**：label leak、版本不可分、不稳健，无质量含义，仅作「若换向量检索会怎样」的结构诊断 | `pnpm eval` 报告「四」 |
| 真模型语义评测（L6） | **LLM 参与决策与评分**：`agnes-2.5-flash` 跑 26 条生成变体（6 切片）；gold 由 `lib.mjs` 独立重算、判据写死。会话污染修复后训练集稳定 ~96–100%。**结构化引导经 held-out 验证为过拟合（分布外诱发过度澄清），已回退**。结果非确定性、需 apikey/服务，**不进 verify/CI** | `pnpm eval:semantic:live` / `eval:heldout` |
| Reliance 监控（理念借鉴）| 借鉴 Mechanistic Shaping 的 **expression ≠ reliance**：白盒激活不可得，黑盒等价证据用 `trace.toolCalls[].result`。评测层把「答案对」(Expression) 与「依据可追溯到本轮工具结果」(Reliance) 分开度量 + `E∧R`；用已有 trace、零额外 LLM、`ok` 历史口径不变。9 个单测；隔离修复后实跑 E/R/E∧R 全 26/26（20/20）| `pnpm eval:semantic:live --json`（`reliance` / `reliantPass` 字段）|
| held-out 泛化探针 | **14 条独立冻结集**，与 26 条文本零重叠、gold 独立算：新月份(2026-07 空月)/新任务(规则解释)/全新措辞/复合问题，判据机器可判。实测泛化**有但非满分**：回退引导后稳定 **13/14 = 92.9%**（引导态 92.9%/57.1% 大幅波动）；暴露过度澄清、复合任务漏工具、空月误追问等分布外弱点。5 个完整性单测 | `pnpm eval:heldout` / `eval:heldout:gen` |
| Trace 可观测性 | 真实 token 消耗 / 三类 step / 工具耗时 / 单步-累计时序全部落进 `trace_run`（2026-11-05 补齐 4 项缺口；细节见本地 spec，不入库）| `/api/trace/:runId`、Web「运行记录」面板 |

> 诚实边界：`pnpm eval` / `pnpm eval:golden` 都是**确定性管线**，不调用真 LLM；
> 向量诊断值 ≈58.3% **不是可信评分**（本地哈希玩具实验，三处方法学缺陷，见报告「四」）；
> 真正「LLM 参与评分」的是 `pnpm eval:semantic:live`（训练集 ~96–100%，但 **held-out 泛化探针仅 92.9%**：满分不能外推到分布外措辞/新任务；会话污染已修、结构化引导因过拟合已回退）。
> 线上规则检索仍是确定性三重过滤（5 条规则规模，无向量库）。

两套体系在 `Money.parse`、规则选择（RuleSelector）等行为上**各写了一遍断言**
（如 `packages/domain/test/money.test.ts` / `rule-selector.test.ts` 对应 eval 的
`L1-MONEY` / `L1-RULE` 条目）——同一事实两套断言，属于主题重叠，不是两份独立覆盖。
因此覆盖率与用例数都**按各自体系分别陈述，不去重合并、更不相加**；
把 vitest 用例数与 eval 用例数相加得出一个「总测试数」大数字，是错误的重复计数，
不作为交付证据。

评测中台的 L1–L7 分层与 7 维雷达是**内部工程自测指标，不是赛题评分口径**；
赛题评分是 **5 维固定权重**：基础任务完成度 40% / AI 技术应用合理性 25% /
问题理解 15% / 后续完善空间 10% / 创新性 10%，
由评委结合演示、保存结果与运行记录核定。

### 评测集是什么

`pnpm eval` 跑的不是「文档里的清单」，而是评测中台的 **244 条评测用例**（编号 L1–L7）。
**但严格说不是「7 层都自动评测」**：L1–L5 + L7 共 **6 层自动执行（240 例 PASS）**；
**L6 是 1 层手工占位层**（4 例 `kind:'manual'` 被中台短路为 MANUAL，从不自动执行，
`run:null`、无机器断言）。真正的 L6 真模型语义评分在 `pnpm eval:semantic:live`。

| 层 | 用例 | 状态 | 说明 |
|---|---|---|---|
| L1 领域 | 74 | ✅ 74 PASS | 直接调用 `@harness/domain` |
| L2 应用 | 62 | ✅ 62 PASS | 用例编排、权限、幂等、记忆隔离、规则管理 |
| L3 适配器 | 35 | ✅ 35 PASS | SQLite、Excel 导入、银行只读触发器 |
| L4 运行时 | 26 | ✅ 26 PASS | Pipeline 洋葱、工具 schema、回复防护 |
| L5 端到端 | 35 | ✅ 35 PASS | 假模型剧本 + 数据库状态断言 |
| L6 真模型 | 4 | 👤 4 MANUAL | **占位层，中台不自动执行**（`run:null`、无机器断言）；真模型语义评分见 `pnpm eval:semantic:live` |
| L7 架构 | 8 | ✅ 8 PASS | 真跑 depcruise + 源码扫描（注入违规会 FAIL）；7 个独立规则 + 1 条重复 |

`MANUAL`（只有文字描述、无自动断言）不进 CI 阻塞流水线，也不计入自动通过数；
`UNVERIFIED`（无断言）会阻断构建——不允许「没验证」伪装成「验证过了」。

**所有期望值都由 `fixtures/eval/dataset.source.json` 算出，不是手写的**。
执行前会先做基准自检：重算 4 组月度金额与 9 月缺项，与 Excel 逐项比对。
这一步在建立时就抓到了原 spec 里一个真实的基准值错误。

```bash
node tools/eval/run-eval.mjs           # 人读格式
node tools/eval/run-eval.mjs --json    # CI 用
node tools/eval/run-eval.mjs --layer=l1
```

评委可复现的核对步骤见本地 `docs/runbook.md` §7（文档仅本地留存、不入库）。

---

## 已知限制

| 限制 | 原因 | 后续 |
|---|---|---|
| 插件静态注册，不支持运行期热加载 | Node ESM 缓存不可清除，热加载风险大于收益 | 子进程隔离 |
| 规则策略从结构化元数据读取，非纯文本抽取 | 自然语言规则解析超出初赛范围 | 接 LLM 做结构化 + 人工确认 |
| 规则检索为关键词 + 2-gram，无向量 | 5 条规则规模无必要 | 规则数 > 50 时引入 |
| 单进程单连接 SQLite | 演示场景 | 换服务端数据库 |

---

## 归档与工程基建状态（2026-11-05 审计）

| 项 | 状态 | 说明 |
|---|---|---|
| CI | ✅ 已建 | `.github/workflows/ci.yml`：push/PR 到 master + 手动触发，`contents: read` 只读、无 secrets；`pnpm install --frozen-lockfile` → `pnpm verify` 全链（含显式 `pnpm build`，干净环境不缺 dist）|
| issue / PR 模板 | ✅ 已建 | `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml` + `PULL_REQUEST_TEMPLATE.md`（含 `pnpm verify`、真模型实跑、提交卫生勾选项）|
| 本地门禁 | ✅ 规范 | `verify` = build + typecheck + lint + dep:check + test + build:test + eval:cov + eval；与 CI 同一条链 |
| 提交卫生 | ✅ 干净 | 27 commit、单作者、conventional 前缀、无 fixup/wip；历史从未含 `.env`/`*.db`/`node_modules`/临时产物，当前 tree 无敏感文件（最大 216KB = pnpm-lock）|
| `.gitignore` | ✅ 完整 | 含 `docs/`（历史已重写抹除、本地留存 25 文件）、`.env`/`*.key`、运行期 `data/*.db\|json\|mjs`、`artifacts/`、`.cache/`、赛题材料包 |
| 工程配置 | ✅ 齐全 | biome / vitest / depcruise / jscpd / fallow / tsconfig / `engines.node>=22.5` / `packageManager=pnpm@10.33.0` / `.env.example` 占位 / docker-compose |
| LICENSE / CONTRIBUTING / SECURITY / CODEOWNERS / CHANGELOG / .editorconfig | ⚪ 刻意不建 | 单人竞赛交付仓库（`private:true`、单作者、无协作者、赛题材料有版权）；「许可」节已声明仅供评审，不擅自选许可证或加协作流程 |
| 已知瑕疵（不重写历史）| ⚠️ 2 处 | 历史重写副作用：`f9279c3` message 为 Dream-RSI 但内容仅剩 README+1；`3d934bf` message 有一处反引号被 shell 吞掉的空格。均为已 push 历史的文字瑕疵、代码内容正确，不为它 force-push 重写公开历史 |

> 归档原则：补齐「CI + 模板 + 门禁一致性 + 忽略规则」这些有真实收益的项；
> 协作/法务文档对单人交付属过度设计，按 C-14「别过度设计」不凑清单。
---

## 许可

比赛作品，仅供评审使用。所有企业、用户、金额与规则均为赛题提供的模拟数据。
