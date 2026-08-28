---
arc: commit-search-m1-3
started: 05c4d37
status: resolved
commits: [a7c2a7f, 8da27a3, 73bfcca, be0b428, 955f587, 27de306, d57ed79, 4175f52, d4669d0]
---

# M1.3 提交搜索定位补全（message/author + 全历史）

## Intent

Roadmap M1.3 的收尾：现有 Cmd+F（graph-locate-and-select arc）只搜分支名 +
hash 前缀，且仅限已加载范围（分页 2000 窗口）。要求补 message/author 搜索，
验收「大仓库任意提交 2 秒内定位」——"任意"意味着未加载的历史也要能搜到，
这是本 arc 的核心难点（搜索本身便宜，**范围外命中的跳转**才是设计大头）。

## Process

- 上下文勘察：前端 `CommitNode.message` = `commit.summary()`（subject 行），
  `author_name` 随行——已加载范围的 message/author 搜索零后端改动可做。
  后端 `walk_commits(seeds, hide, limit)` / `build_view` 是种子驱动管线，
  `read_git_data_from_branch` 已证明"单种子开窗 + session 接管分页"模式。
  hash 前缀可走 `revparse_single` 快速路径。
- 需求澄清结论（用户逐项拍板）：
  1. 搜索范围 = **全历史**（新增只读后端命令；"任意提交 2 秒内定位"的验收
     只有这条路能达成）。
  2. 范围外命中跳转 = **"从该提交查看"**：以目标 oid 为种子开 2000 窗口
     （复用 read_git_data_from_branch 的单种子模式 + session 接管分页），
     一次调用亚秒级。否决深分页（walk 数万 + 全集 layout，秒级且 90k
     layout 未验证）。
  3. 执行架构 = **混合双源**：输入时前端即时搜已加载范围（含 message/author
     扩展），200ms 防抖后后端补全全史命中，按 id 去重合并。已加载命中拿得到
     lane_owner（死泳道自动展开的既有行为保住），后端返回 in_view 标志
     （查 session loaded oids）分流跳转路径。

实施阶段（5 任务 TDD，详见各任务报告）：

- Task 1（73bfcca，search_commits）：revwalk TIME|TOPO，小写化子串比对
  subject/author，hex 前缀在 walk 循环内顺手比对，in_view 读 session 已加载
  oid 集。**计划断言计数翻车**：fixture 按命中词 "c" 实际命中 5 条（3 条
  subject + 2 条 author，计划写 4——author 也参与匹配时别只数 subject），
  in_view 真/假为 2/3（计划写 3/1）；`find(!in_view).id == c1` 还因命中按
  新→旧排序失义（c1 最老，不再是第一条例外），改 `any(...)`。fixture 与
  实现自洽，只改断言与注释。
- Task 2（be0b428，jump_to_commit）：单种子伪 lane（7 位短 hash 命名）+
  build_view + store_session 接管分页，完全照计划，无意外。
- Task 3（955f587，locate.ts）：matchLoaded/mergeLocate 纯函数 + vitest。
  计划测试代码用了 vitest 的 `toBe(true, 'msg')` 自定义消息形态——tsc
  strict（项目未引 vitest 全局类型）拒绝第二参数，去掉消息，断言语义不变。
- Task 4（27de306，App 接线）：**M1.2 的 TDZ/声明顺序地雷这次未触发**——
  remoteHits/remotePending 是顶部 state，新 effect 的依赖全部声明在前，
  tsc 通过即证；memo/useCallback 插入位置不是每次都要动手术。Task 4 有意
  未动的 locateNoResults（"已加载范围内无匹配"）在 Task 5 修正为
  "无匹配"/"No match"——防抖落定后搜索即全史，范围限定词失真。
- Task 5（E2E + 收尾，mock.html 补两个 invoke case）：**计划的 median-x
  in_view 切分在本 mock 上不可达**——mock DATA 是单一全量视图，本地
  matchLoaded 找得到每个 commit，而 mergeLocate 本地优先去重把远端
  in_view=false 标志全部吞掉（合并后恒 in_view=true），跳转分支只对真实
  后端（深历史真未加载）才触发。落地版保留切分但注释改为如实描述。跳转
  路径改用临时 magic-query patch（'e2e:old' 固定返回一条 in_view=false 的
  老 merge 命中）驱动：loading 闪现 → 视口重置（svg transform
  -39732→-2524，恰为 1280px 视口居中 x=3164 的解析解）→ 目标高亮居中 →
  详情面板打开，验后 git diff 复核还原。get_commit_detail 恒返 null 同样
  堵死详情面板验收，也是临时 patch 拼 CommitDetail——M1.2 教训重演，mock
  的 get_commit_detail 该考虑常驻补齐了。双语空态/搜索中 footer、命中
  ≥limit 的「全历史命中 50+ 条」footer 均已覆盖，全程无 console 错误。
- 终审（0 Critical）自建 10 万提交 fixture 做了 release 基准：全史搜索
  最差 482ms（早停命中 482 / 全走未命中 159-438，方差来自冷缓存与机器
  噪声），2s 预算 4 倍余量；且**早停 limit 不省时**——固定 walk 准备成本
  主导，M1.4 规模治理时可参考。修复波次（d4669d0）：SEARCH_LIMIT=50
  单一来源（原 4 处硬编码漂移风险，i18n 走 {n} 模板）、mock 头注释
  去fixture 化、AGENTS.md 测试清单、后端空 query 早退守卫。真实仓库
  2s 手动计时仍未执行（100k 基准是目前唯一的规模证据）。

## Decisions

- 搜索范围 = 全历史，新增只读后端命令 `search_commits`（"任意提交 2 秒内
  定位"的验收只有这条路能达成）；匹配 = 大小写不敏感子串 subject/author +
  ≥4 位 hex 前缀（walk 循环内顺手比对，覆盖全部歧义匹配——revparse_single
  遇歧义直接报错反而丢结果）。
- 范围外命中跳转 = "从该提交查看"：目标 oid 构造伪种子（7 位短 hash 命名）
  开 2000 窗口 + session 接管分页，一次调用亚秒级；否决深分页（walk 数万 +
  全集 layout，秒级且大规模 layout 未验证）。
- 执行架构 = 混合双源（前端即时搜已加载范围 + 200ms 防抖后端补全全史、按
  id 去重合并）而非全后端：后者每次击键 IPC 往返、且回查 lane_owner 才能保
  住死泳道自动展开；双源的代价只是前端一个合并纯函数。
- mock 的 search_commits 忠实镜像后端匹配语义（message/author/hash），不为
  可测性引入假维度；跳转路径用一次性 harness patch 驱动，验后还原，不污染
  常驻 mock。
- locateNoResults 收敛为"无匹配"/"No match"：范围限定词只在 200ms 防抖
  窗口内为真，常驻文案以落定后的语义为准。

## Lessons

- 双源合并的"本地优先去重"会让 mock 的 in_view 假标志永远不可见：mock
  视图全量加载 ⇒ 远端命中 ⊆ 本地命中。想让 UI 分支在 mock 里可达，需要
  本地匹配器看不见的维度（临时 patch），否则只能真后端验收。
- 计划里的测试断言计数（命中数、in_view 分布）写 fixture 时要重数一遍，
  尤其 author 也参与匹配时；排序相关断言（find 第一条）注意命中是新→旧。
- vitest 的 `toBe(v, 'msg')` 自定义消息形态过不了 tsc strict（未引全局
  类型）——断言消息别用。

## Related

- 核心改动：`src-tauri/src/git_reader.rs`（search_commits 纯函数 +
  read_git_data_from_commit 单种子开窗）、`src-tauri/src/commands.rs`、
  `src-tauri/src/models.rs`（SearchHit）、`src/locate.ts`（matchLoaded/
  mergeLocate）、`src/App.tsx`（防抖 effect、跳转分流、下拉 commit 行）、
  `src/api.ts` / `src/types.ts`、`src/settings.tsx`（locate 文案）、
  `mock.html`（两条 invoke mock）
- 测试：`src-tauri/tests/search.rs`（6 用例，git CLI 造临时仓）、
  `src/locate.test.ts`（8 用例）；设计文档
  `docs/superpowers/specs/2026-08-28-commit-search-design.md`
