# dsh-request-retry

[English](#english) | [中文](#中文)

<a id="中文"></a>

## 中文

DSH（DeepSeekRuntime）插件：模型请求遇到**临时性上游故障**时自动重试，指数退避，直到上游恢复——而不是直接报「本轮运行失败」打断你的会话。

如果你在用中转站、公益网关或任何不稳定的三方通道，多半见过这些报错：

```
500 No available channel for model xxx under group auto
503 upstream-reset (circuit open, next probe +37s)
400 Unmarshal chat params failed ...
```

这些故障的共同特点是：**过一会儿就好了**。但 DSH 默认只重试有限的次数，之后整轮回合直接失败——已经生成的长回答作废，你得重新发消息、重新等模型把几千 token 再吐一遍。长会话、长任务里这种打断尤其伤。

本插件接管 `agent/request-error` 事件：命中匹配词的失败会按指数退避重发**同一个请求**（复用同一次渲染组装，不重复计费、不重复注入），直到上游恢复或超出总窗口。其他错误（鉴权失败、参数错误、用户取消）照常交还 DSH 默认处理——插件不越权。

### 默认匹配的故障（可自行扩展）

| 匹配词 | 典型场景 |
| --- | --- |
| `No available channel` | 网关无可用通道（500） |
| `circuit open` | 上游熔断快速失败（503） |
| `upstream-reset` | 上游连接被重置 |
| `ECONNRESET` | 网络层断连 |
| `fetch failed` | Node fetch 网络错误 |
| `Unmarshal chat params` | 网关解析请求体失败（400 bad_params，报错自带 RETRY 建议） |

### 重试策略

- 退避：首次 3 秒起，每轮 ×1.5，单次等待封顶 5 分钟
- 报错带 `retryAfterSeconds` 时（熔断器探活节奏），至少等该秒数 + 2s 再重发——不在熔断期做无效请求
- `maxRetries: 0` = 无限重试；`maxRetryMs: 28800000` = 总重试窗口 8 小时，超窗后放行报错
- 用户主动取消（signal abort）立即停止重试，绝不覆盖取消

### 安装

```
github:pachellber-marine/dsh-request-retry
```

或在 DSH 插件管理器 / 插件市场里搜 `dsh-request-retry`。

### 配置

在 cordis.patch.yml 的 insert 条目里加 `config` 字段即可覆盖默认值：

```yaml
- insert:
    - id: request-retry
      name: dsh-request-retry
      config:
        matchPatterns: ['No available channel']   # 只保留你需要的
        maxRetryMs: 0                             # 0 = 永不放弃
```

所有可调参数：`enabled` / `matchPatterns` / `initialDelayMs` / `maxDelayMs` / `backoffMultiplier` / `maxRetries` / `maxRetryMs`。

### 注意

- 重试复用同一次渲染组装，不会重复计费 pre-step / 用户消息。
- 确定性错误（如 400 参数固定损坏）也会重试——重发的是同一个请求。确定性损坏建议把对应词从 `matchPatterns` 里删掉，别让它烧满 8 小时窗口。

<a id="english"></a>

## English

A DSH (DeepSeekRuntime) plugin that auto-retries model requests on **transient upstream failures** with exponential backoff, keeping the session alive until the upstream recovers — instead of failing the turn immediately.

If you route your models through relay stations, community gateways, or any third-party upstream, you have probably seen errors like these:

```
500 No available channel for model xxx under group auto
503 upstream-reset (circuit open, next probe +37s)
400 Unmarshal chat params failed ...
```

They share one property: **they go away on their own.** DSH's default handling retries a limited number of times and then fails the whole turn — losing a long generated answer and forcing you to resend. This plugin takes over the `agent/request-error` event: matching failures are resent after a backoff delay (reusing the same render assembly — no duplicated billing or injection), until the upstream recovers or the total window is exhausted. Everything else (auth errors, bad params, user cancellation) is handed back to DSH's default handling.

### Retry policy

- Backoff: starts at 3s, ×1.5 per attempt, single wait capped at 5 minutes
- If the error carries `retryAfterSeconds` (circuit-breaker probe interval), wait at least that long + 2s before resending
- `maxRetries: 0` = unlimited; `maxRetryMs: 28800000` = 8-hour total retry window
- User cancellation (signal abort) always stops the retry loop

### Install

```
github:pachellber-marine/dsh-request-retry
```

### Configuration

Add a `config` block to the insert entry in `cordis.patch.yml` to override defaults. Tunables: `enabled`, `matchPatterns`, `initialDelayMs`, `maxDelayMs`, `backoffMultiplier`, `maxRetries`, `maxRetryMs`.

## License

MIT
