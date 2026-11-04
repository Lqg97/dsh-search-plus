# dsh-search-plus

把 DSH（DeepSeek Harness）内置的 `grep` 换成真正够用的版本：带上下文行、反向匹配、只列文件、忽略大小写、语言类型过滤、额外排除、一次搜多个路径。

## 解决什么问题

内置工具只暴露 `pattern` / `path` / `include`。任何需要「看看命中前后几行」「搜两个目录」「列一下哪些文件命中」「排除掉 minified」的搜索，都只能掉回 bash 走 `rg … | head`——这正是 bash 承担了大部分搜索工作的原因。

本插件**在同一个 agent 作用域内注册同名工具 `grep`**。作用域工具会遮蔽全局工具，所以模型照旧调用 `grep`，只是多了参数。

## 特性

- **保持内置的返回形状**：`{ matches: [{ path, lineNumber, line }] }` 仍是对外契约；上下文行不另立新形状，只多带一个可选的 `context: true` 字段，任何读 `matches` 的既有逻辑都继续可用。
- **内置工具自己让路**：`dsh-tool-fs-search` 用身份校验（`ctx.tools.get(name) !== tool`）守卫自己的 post-execute，名字被遮蔽后它自然变成 no-op，两边不需要任何协调。
- **参数**：`pattern`（必填）、`path`、`paths[]`（多路径，优先于 `path`）、`include`、`exclude`、`type`、`contextBefore` / `contextAfter` / `context`、`invertMatch`、`filesOnly`、`caseInsensitive`。
- **注入安全**：每个模型可控的值都是独立的 argv 元素，目标路径全部落在 `--` 之后，因此以短横线开头的模式值不会被当成 flag。
- **有界输出**：命中行数默认上限 400 行（`maxLines`），单行预览默认 400 字节（`maxLineBytes`），超出时提示「narrow the pattern or path」，而不是把上下文窗口灌满。截断按 UTF-8 边界切，不会切出半个字符。
- **路径相对化**：结果里的路径在搜索根目录内时转成相对路径，和内置工具的输出习惯一致。

## 安装

插件是「本地目录 bundle」，克隆到任意位置后安装：

```bash
git clone https://github.com/Lqg97/dsh-search-plus.git
```

在 DSH 里打开 **插件管理 → 安装本地目录**，选择克隆后的目录；或让 agent 调用插件管理器的 `install_bundle`，target 填该目录的绝对路径。

安装后重启 DSH。插件本身没有设置页。

## 依赖 ripgrep

插件优先使用 DSH 桌面版自带的 ripgrep，找不到时回落到 `PATH` 上的 `rg`：

```bash
# macOS
brew install ripgrep
```

两个都没有时每次搜索都会报 `grep: … rg` 相关错误——装一个 `rg` 即可。

## 配置

配置项写在 [`cordis.patch.yml`](cordis.patch.yml) 的 `config` 里：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用同名工具遮蔽 |
| `maxLines` | `400` | 返回行数的硬上限 |
| `maxLineBytes` | `400` | 单行预览的字节预算 |

## 实现

- **Host 半边** [`index.js`](index.js)：`inject: ['tools', 'subprocess', 'workingDirectory']`。
- 工具定义是**纯对象，不 import 任何 harness 包**：profile 里解析不到 `@deepseek-ai/dsh-tools`，硬 import 只会引出第二份被求值的副本。只用到 `ctx.subprocess` 与 `ctx.workingDirectory`。
- 监听 `agent/created`（必须 `global: true`，该事件在 agent 自己的 carrier context 上发出，非全局监听器会被过滤掉）时给 `agent.ctx.tools.register(tool)`，并在 `agent/disposed` 时释放。遮蔽失败不影响内置工具。
- `rg --json` 的 NDJSON 只取 `match` / `context` 两类记录，其余（`begin` / `end` / `summary`）丢弃；坏行容忍跳过。
- 超时 30 秒，与内置工具的合作式预算一致；子进程 stdout 上限 8 MB。

## 已知边界

- **只遮蔽 `grep` 一个工具**：`glob`、`read` 等保持原样。
- **`include` 只支持单个 glob**：需要「包含 + 排除」时用 `include` 配 `exclude` 两个参数。
- **不支持 `grep -r` 式的 shell 语义**：它是工具不是 shell，没有管道、没有参数展开。
- **依赖 `rg --json` 的输出格式**：上游改格式时解析会静默少返回记录；纯函数 `parseJsonMatches` 已导出，便于定位。
- **遮蔽依赖上游的身份校验**：内置工具若去掉那个守卫，就会出现两个 `grep` 定义。

## 项目结构

```text
dsh-search-plus/
├── index.js                       # 工具定义 + argv 构建 + NDJSON 解析
├── cordis.patch.yml               # bundle 插入的插件行与上限配置
├── package.json                   # dsh.bundle 清单
└── test/
    ├── smoke.mjs
    └── fixtures/src/parser/       # 测试自带的 go 样例文件
```

## 测试

```bash
node test/smoke.mjs
```

两层：

1. **纯函数**（无 I/O）：argv 构建、NDJSON 解析、参数校验、render 输出；
2. **真 ripgrep 端到端**：经工具自己的 `execute` 走完 argv → 子进程 → 解析 → 形状，搜索的是仓库内自带的 `test/fixtures`，因此**不需要任何兄弟仓库**，全新克隆即可跑通。没有 `rg` 时这一层自动 skip，纯函数层照常执行。

不需要网络。

## License

[MIT](LICENSE)
