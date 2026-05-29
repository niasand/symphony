# Linus Review: Symphony TypeScript

> 项目：symphony-typescript v0.1.0
> 语言：TypeScript / Node.js 18+
> 规模：22 源文件, ~4000 行 + 11 测试文件, ~2200 行
> 日期：2026-05-29

---

## 总评：6/10 — 能跑，但有些设计决定让我怀疑作者是否真的理解自己在编排什么

这是一个根据 OpenAI 的 Symphony 规范文档实现的 TypeScript 版本。整体骨架是对的——Result 类型、TypedError、分层的模块结构。但骨架对了不等于肌肉长对了。

好的部分我不想多废话：Result<T> 统一错误处理、依赖注入在 runner.ts 里用得不错、测试覆盖了主要路径。这些是基本功，做好了不值得表扬。

值得说的是问题。

---

## 致命问题

### 1. Orchestrator 是个 787 行的上帝类

`src/orchestrator/index.ts`

这个文件做了太多事。它是 EventEmitter、是调度器、是重试队列管理器、是 Codex 事件聚合器、是状态快照提供者、还是工作区清理工。787 行里塞了至少 5 个不同的职责。

Linus 不会说"你应该把它拆开"这种废话。我说的是：**这个设计已经在伤害你了**。

看 `terminateRunningIssue()` (line 471-493)。这个方法在终止进程的同时删工作区、更新 running map、更新 claimed set、删除 retry entry。五个副作用串在一个方法里。任何调用者都得同时承担所有五个后果。没有中间状态，没有部分成功。这意味着：如果 `removeWorkspace` 抛异常（SSH 环境下很常见），进程已经杀了但 claimed set 没清理——issue 被永远锁死。

`handleRetry()` (line 594-645) 也一样。同一个方法里先 fetch candidates，然后根据结果决定 dispatch / reschedule / release。三个完全不同的状态转换路径混在一起，靠 if-else 分支控制。

这设计是错的。Orchestrator 应该只做调度决策，副作用（杀进程、删文件、发网络请求）应该委托出去。现在的写法让每一个路径都几乎不可能单独测试或单独恢复。

### 2. `pendingResolve` 的类型撒谎

`src/agent/app-server.ts:26`

```typescript
pendingResolve: Map<number, { timer: NodeJS.Timeout }>;
```

但 `killSession` (line 534-539) 遍历这个 map 只取 `timer`。如果未来有人加回 resolve/reject 字段（之前的版本就有），`killSession` 不会清理它们，造成内存泄漏。

更根本的问题：`waitForResponse` 在 readline 上注册 `'line'` 事件处理器，靠 `removeListener` 在匹配到 id 时移除。但如果超时了，处理器移除了但 readline 接口还活着——下一个 `waitForResponse` 调用会注册新的 handler。多个 handler 并存时，旧 handler 的 id 匹配逻辑会让它忽略不属于自己的消息，白白解析 JSON。不是 bug，但是每条消息都 O(n) 扫一遍 handler 列表，n 是历史遗留的 handler 数量。

用一个按 id 分发的单 handler 替代多个 handler。这是协议客户端的基本模式。

---

## 严重问题

### 3. Hooks 的超时实现是假的

`src/workspace/hooks.ts:14-55`

```typescript
const proc = spawn('bash', ['-lc', script], { cwd: workspacePath, timeout: timeoutMs });
```

`spawn` 的 `timeout` 选项会在超时后发 SIGTERM。但 bash -lc 启动的子进程可能已经 exec 了别的程序（比如 git clone），这时候 SIGTERM 发给的是 bash 而不是实际的子进程组。在 macOS 上，bash 进程退出后子进程变成孤儿继续运行。

Elixir 版本用 `Task.yield` + `Task.shutdown` 来保证进程组级别清理。TypeScript 版本依赖 Node 的 `spawn.timeout`，这在进程组语义上是不等价的。

这是一个真实的运维风险。`after_create` hook 里的 `git clone` 如果卡住（大仓库、网络问题），你会有一个 zombie git 进程占据着工作区，而 Symphony 以为 hook 已经超时失败了。

### 4. `refreshRuntimeConfig` 在 tick 内同步读文件

`src/orchestrator/index.ts:653-665`

```typescript
private refreshRuntimeConfig(): void {
  try {
    const wfResult = loadWorkflow(this.workflowPath);
    // ...
  } catch {
    // Keep last known good config
  }
}
```

每个 tick 周期同步读取 WORKFLOW.md 文件。如果你同时有 `chokidar` watcher 做热重载（`workflow/watcher.ts`），为什么还要在 tick 里再读一遍？Spec 说"defensively re-validate before dispatch"，但 "re-validate" 不等于 "re-read and re-parse"。

现在你有两个独立的路径在更新同一个 config 对象：watcher 通过 `orchestrator.updateConfig()` 更新，tick 通过 `refreshRuntimeConfig()` 更新。它们之间没有同步机制。如果 tick 读到一半文件被 truncate（editor 的 atomic write 模式），你会拿到一个半截的 YAML——`loadWorkflow` 返回 error，然后被 catch 吞掉，用"last known good"。这倒是对的，但你为什么要两个路径做同一件事？

选一个。要么只靠 watcher（加一个 `--check-interval` 兜底），要么只靠 tick 同步读（删掉 watcher）。两个都做是给自己找竞态条件。

### 5. Tracker client 的分页实现有 bug

`src/tracker/client.ts`

分页循环在 `fetchCandidateIssues` 里通过 `hasNextPage` / `endCursor` 遍历所有页面。但如果某个页面的 `nodes` 数组里有一个 `normalizeIssue` 返回 `null` 的元素（必填字段缺失），这个元素会被默默丢弃。

问题在于：如果 Linear API 返回了一个 `id` 存在但 `state` 为 null 的 issue（这在 Linear 里是合法的——issue 刚创建还在初始化），`normalizeIssue` 返回 null。这个 issue 不会被调度（好），但也不会出现在候选列表里（好），问题是：**这个被丢弃的 issue 可能正在被运行**（上一轮调度的）， reconciliation 用 `fetchIssueStatesByIds` 单独查它的状态。这两条路径的数据模型不一致——候选列表里没有它，但 running map 里有它。`reconcileRunningIssues` 的 "missing from candidates" 逻辑会终止它。

这意味着一个正在正常运行的 issue，仅仅因为 Linear API 在分页边界返回了一个不完整的记录，就可能被终止。这不是理论风险，这是分页 + 过滤 + reconciliation 三者交互的结构性问题。

---

## 一般问题

### 6. HTML dashboard 内联在 TypeScript 里

`src/http/server.ts:165-217`

53 行的 HTML 字符串模板硬编码在一个 `.ts` 文件里。每次改 CSS 都要重编译。这是 MVP 可以这么干，但这段代码的生命周期比你想的长。把它移到一个 `.html` 文件里用 `fs.readFileSync` 读，或者用模板引擎。

### 7. `sortIssuesForDispatch` 的变量名

`src/orchestrator/index.ts:162-166`

```typescript
const pa = a.priority != null && ... ? a.priority : 5;
const pb = b.priority != null && ... ? b.priority : 5;
const ta = a.created_at ? a.created_at.getTime() : Number.MAX_SAFE_INTEGER;
const tb = b.created_at ? b.created_at.getTime() : Number.MAX_SAFE_INTEGER;
```

`pa`、`pb`、`ta`、`tb`。你在省什么？字母？这是核心调度逻辑，任何一个读代码的人都要在脑子里把 `pa` 翻译成 `priorityA`。5 个字符能省出什么？

### 8. `RunAttemptPhase` 类型定义了但没人用

`src/types.ts:141-152`

定义了 11 个 phase 枚举值。搜索整个代码库——没有任何地方使用 `RunAttemptPhase`。这是从 spec 里抄过来但没有落地的东西。删了或者用了，别留着当装饰。

### 9. `retryDelay` 的位移运算缺少注释

`src/orchestrator/index.ts:591`

```typescript
return Math.min(FAILURE_RETRY_BASE_MS * (1 << maxPower), this.config.agent.maxRetryBackoffMs);
```

`1 << maxPower`，其中 `maxPower = Math.min(attempt - 1, 10)`。这是 `10000 * 2^(attempt-1)` 的位移实现。没有注释解释为什么 cap 在 10（2^10 = 1024, 所以最大 delay base 是 1024 秒 ≈ 17 分钟）。Elixir 版本有这个 magic number 也没有注释——但那是别人的问题，不是你的借口。

### 10. SSH 模块的 `parseSshHost` 不处理 IPv6 地址里的 scope ID

`src/ssh/worker.ts:44-55`

IPv6 scope ID 格式是 `fe80::1%eth0`。正则 `/^\[(.+)\](?::(\d+))?$/` 会把 `fe80::1%eth0` 当成合法的 host。SSH 客户端处理这个没问题，但你传递 `user@fe80::1%eth0` 给 SSH 时，`%` 可能在某些 shell 配置下被解释。信息不足——这取决于目标 shell 环境。

---

## 测试评估

**145 个测试，覆盖 10 个测试文件。** 数量不错。

**但关键缺失：**

1. **app-server 进程崩溃路径** — 没有测试 Codex 进程在 turn 中间 crash 时 session cleanup 是否正确。这是生产环境最常见的失败模式。
2. **并发 waitForResponse** — 没有测试两个并发请求共享同一个 readline 时的行为。
3. **Orchestrator 和真实 tracker 的集成** — orchestrator 测试只测 sort 和 shouldDispatch，没有测 reconciliation 的状态刷新路径。
4. **Hook 超时后的进程清理** — 测试了超时返回错误，但没验证子进程是否真的被杀了。

测试不是用来证明代码能工作的。测试是用来防止未来的人（包括三个月后的你）在不理解影响范围的情况下改错东西。从这个角度看，测试覆盖了 happy path，但 missed 了你最需要保险的地方——进程生命周期管理。

---

## 总结

| 维度 | 评分 | 说明 |
|------|------|------|
| 架构设计 | 5/10 | 模块边界清晰但 Orchestrator 是上帝类，职责太多 |
| 代码质量 | 6/10 | 类型系统用得好，命名有瑕疵，error handling 一致但不完整 |
| 工程实践 | 7/10 | 145 个测试，TypeScript strict mode，零编译错误 |
| 性能与风险 | 5/10 | Hook 超时不可靠，分页+reconciliation 交互有结构性风险，config 双路径更新 |

**一句话：骨架对了，但关节还不太灵活。能 demo，离 production 还有 3 个真正难的问题要解决——进程组清理、Orchestrator 拆分、和 reconciliation 的数据一致性。**

---

*Reviewed with Linus-style directness. All criticisms backed by code references. No personal attacks — just technical facts.*
