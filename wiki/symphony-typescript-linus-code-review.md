# symphony-typescript — Linus 风格代码评审

> 评审时间：2026-05-30
> 项目规模：28 源文件 / ~4750 行代码，14 测试文件 / ~2833 行
> 技术栈：TypeScript (ESM), Node.js >=18, Vitest, 3 个运行时依赖 (chokidar, liquidjs, yaml)

## 总评

**评分：6/10**
**同类项目水平：中**

代码组织意识不错——有人花时间做了 `RetryManager`、`DispatchScheduler`、`WorkspaceLifecycle` 的提取，`RunnerDependencies` 的依赖注入也说明作者知道可测试性的价值。但好思路只执行了一半：Orchestrator 依然是个 656 行的半上帝类，新增的 adapter 模式用 `as unknown as` 来绕过类型系统，Claude adapter 有真实的资源泄漏。这不是"能跑就行"的水平，但也离"我敢上生产"有距离。

---

## 优点

1. **依赖注入做得对** — `runner.ts:10-16` 的 `RunnerDependencies` 接口让 `runAgent` 完全可测试，不需要 mock 任何全局状态。这是整个项目里最干净的设计。

2. **Result 类型 + TypedError** — 全局统一的错误处理模式，`types.ts` 里的 `ErrorKind` 联合类型让每个错误都可追溯。比到处 throw string 强一个量级。

3. **Codex adapter 零修改** — `codex-adapter.ts` 只做了薄包装，`app-server.ts` 一行没改。新增 Claude 支持没有破坏已有代码，179 个测试零回归证明这一点。

4. **配置解析的 snake_case 兼容** — `config/index.ts:18-29` 的 `lookup` 函数同时支持 `snake_case` 和 `camelCase`，这对 YAML front matter 用户很实用。

---

## 致命问题

1. **`as unknown as` 类型擦除 — codex-adapter.ts:49**

   ```typescript
   private fromGeneric(s: AgentSession): Session {
     return s as unknown as Session;
   }
   ```

   你在编译器脸上说"相信我"。`AgentSession` 只有 `process` 和 `workspace` 两个字段，`Session` 有 `readline`、`threadId`、`nextId`、`autoApprove`、`approvalPolicy`、`toolHandlers`、`pendingResolve` 等一堆字段。注释说"The runner only ever passes sessions back that we created"——这是**运行时不变量靠注释保证**。任何一个新开发者改了 runner 的流程，这里就静默崩溃。

   **为什么致命**：类型系统存在的意义就是让这种错误在编译期被捕获。你用 `as unknown as` 把类型系统废了，比没有类型还糟——因为读代码的人以为类型是对的。

   **修复**：让 `AgentSession` 携带 opaque brand，或者把 `Session` 的真正接口（`startSession`/`runTurn`/`stopSession` 需要的字段）抽到 adapter 内部，不要让 runner 看到不完整的类型。

2. **`checkBinary` 的 5 秒 timer 泄漏 — claude-adapter.ts:156**

   ```typescript
   setTimeout(() => {
     proc.kill('SIGKILL');
     resolve({ ok: true, value: undefined });
   }, 5000);
   ```

   如果 `claude --version` 正常退出（0.1 秒），这个 timer 还会在事件循环里挂 4.9 秒。每次 `startSession` 都会泄漏一个 timer。在 `maxConcurrentAgents: 10` 的配置下，每个 issue 都调一次 `startSession`，timer 累积会阻止 Node.js 进程优雅退出。

   **修复**：在 `exit` 和 `error` 回调里 `clearTimeout`。

3. **Claude adapter 无界 buffer — claude-adapter.ts:210**

   ```typescript
   buffer += chunk.toString('utf-8');
   ```

   如果 Claude 进程输出一行 2GB 的数据（buggy 输出、管道破裂、恶意 prompt），这个 buffer 会把进程内存吃光。Codex 的 `app-server.ts` 有同样的问题，但 Codex 是内部协议，受控；Claude 是外部 CLI，输出不可预测。

   **修复**：加 buffer 大小上限（比如 10MB），超了就当 turn_failed。

---

## 一般问题

1. **Orchestrator 半上帝类** — `orchestrator/index.ts` 656 行。已经提取了 `RetryManager`、`DispatchScheduler`、`WorkspaceLifecycle`，但还剩下：tick 调度、worker 生命周期、Codex update 处理、snapshot 构建。注释第一行说"Thin coordinator"——**656 行不 thin**。每次改 dispatch 逻辑都要在这个文件里翻找，改 snapshot 逻辑也一样。

2. **Claude adapter 隐式状态变异** — `claude-adapter.ts:258`：

   ```typescript
   session.conversationId = event.session_id;
   ```

   `runTurn` 静默修改传入的 session 对象。调用方（runner）不知道 session 被改了。`conversationId` 用于 `--resume` 参数构建——如果 `runTurn` 内部出错没有设上这个字段，下一轮就不会用 `--resume`，上下文断裂但没有任何日志提示。

3. **runner 每次 runAgent 都新建 adapter** — `runner.ts:51`：

   ```typescript
   const adapter = createAdapter(config.agent.kind);
   ```

   `createAdapter` 每次调用 `new ClaudeAdapter()` / `new CodexAdapter()`。当前实现无状态所以不出错，但如果将来 adapter 需要维护状态（连接池、缓存），这里会静默丢失。

4. **`extractUsage` 永远返回 undefined** — `claude-adapter.ts:314-318`：

   ```typescript
   function extractUsage(...): ... | undefined {
     return undefined;
   }
   ```

   函数名说"extract"，实际什么都不 extract。Claude CLI 的 result 事件有 `cost_usd` 和 `duration_ms`，至少应该把 `cost_usd` 传到 observability 层。现在的代码让 orchestrator 的 token 统计对 Claude 完全失明。

5. **`startSession` 的 `_config` 和 `_dynamicTools` 被无视** — `claude-adapter.ts:42-43`：

   Codex adapter 把 `dynamicTools` 传给 `startSession` 注册 `linear_graphql` tool handler。Claude adapter 完全忽略了这个参数——Claude CLI 内部自己处理工具调用，但没有任何文档说明这个限制，也没有日志警告。

6. **魔法数字散落** — `retry-manager.ts:7-8` 的 `1000ms` / `10000ms` 重试延迟，`app-server.ts:550` 的 `3000ms` SIGKILL 等待，`claude-adapter.ts:159` 的 `5000ms` 二进制检查超时。没有常量名解释为什么是这个值。

---

## 信息不足

1. **Claude CLI `--output-format stream-json` 的稳定性** — 这个输出格式是 Claude Code CLI 的内部接口，没有公开文档承诺稳定性。如果 Anthropic 改了 JSON 结构，adapter 会静默失败（所有事件都变成 `notification` 或 `malformed`）。

2. **Codex app-server 协议版本兼容性** — `SPEC.md` 说"protocol source of truth is Codex"，但没有版本协商机制。Codex 升级后 method name 变了，这里不会报错——只是 `default` 分支默默处理。

3. **SSH worker 场景下的 Claude adapter** — `ssh/` 模块让 agent 可以在远程主机上运行。但 Claude adapter 的 `spawn` 是本地的，没有考虑 SSH worker 场景。这是设计盲区还是有意不支持？信息不足。

---

## 值得学习吗？

**判断：部分**

**值得学的**：`RunnerDependencies` 的依赖注入模式、`Result<T, E>` 错误处理、config 的 snake/camel 兼容解析。这些是可以直接复制到自己项目的实用模式。

**别学的**：用 `as unknown as` 绕过类型系统、在 adapter 接口里用基类类型传子类实例然后靠 cast 恢复。这种模式在小型项目里能跑，在团队项目里是定时炸弹。

---

## 适合生产吗？

**判断：在严格条件下可以**

**适用场景**：内部工具、低频调度的 agent 编排、受控环境下的 CI/CD 自动化。项目本身就是"engineering preview"，这个定位是诚实的。

**不适用场景**：多租户 SaaS、高并发 agent 调度、需要精确 cost tracking 的场景。无界 buffer 和 timer 泄漏在高负载下会变成实际问题。

**上生产前必须修的**：
1. 清除所有 `as unknown as`（用 opaque type 或泛型解决）
2. 修 timer 泄漏
3. 加 buffer 上限
4. 给 Claude adapter 补 abort signal 和 timeout 测试
