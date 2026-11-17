# 云端 Agent 助手工作台（Agent Workbench）

把 Agent CLI 的能力带到浏览器里：打开工作台、新建会话、把开发或日常工作交给助手；执行过程实时可见，成果可预览和下载；随时提出修改意见继续推进；关闭页面或重启服务后回来，会话、过程和文件都还在。

- Agent：**OpenAI Codex CLI**（默认，直连平台的 OpenAI Responses 接口）；也支持 **Claude Code**（经 LiteLLM 协议转换）和内置 **mock**（无 key 演示/测试）
- 后端：Node.js + Express，文件持久化；前端：原生 HTML/JS，无构建步骤
- 交付：`docker compose up --build` 一条命令启动，浏览器访问 `http://localhost:8080`

---

## 1. 快速开始

```bash
cp .env.example .env          # 填入 MODEL_API_KEY（平台临时 key），其余默认即可
docker compose up --build -d  # 构建并启动
# 浏览器打开 http://localhost:8080
docker compose logs -f app    # 查看服务日志
```

在 **GitHub Codespaces** 中运行（本机没有 Docker 时）：仓库页面 → Code → Codespaces → Create codespace，在终端执行上面三条命令，然后在 “端口 / Ports” 面板打开 8080 端口。

无 key 体验界面：在 `.env` 里设 `AGENT_CLI=mock`。

本地开发（不用 Docker）：`npm install && AGENT_CLI=mock npm start`。

### 配置项（`.env`）

| 变量 | 说明 | 默认 |
|---|---|---|
| `AGENT_CLI` | `codex` / `claude` / `mock` | `codex` |
| `MODEL_BASE_URL` | 平台调用地址（OpenAI 兼容，以 `/v1` 结尾） | — |
| `MODEL_API_KEY` | 平台临时 key，只通过环境变量注入 | — |
| `AGENT_MODEL` | 模型名 | `linext-5.3-luna` |
| `RUN_TIMEOUT_SEC` | 单轮任务超时 | `1200` |
| `MAX_CONCURRENT_RUNS` | 全局同时执行的任务数 | `3` |
| `MAX_TURNS` | Claude Code 单轮最大步数 | `80` |
| `MAX_UPLOAD_MB` | 单文件上传上限 | `50` |
| `LITELLM_MASTER_KEY` / `LITELLM_UPSTREAM_MODEL` | 仅 `AGENT_CLI=claude` 时使用 | — |
| `CODEX_EXTRA_CONFIG` | 追加到 Codex `config.toml` 的点号键（如 `model_reasoning_effort = "low"`） | — |

使用 Claude Code：`.env` 设 `AGENT_CLI=claude`，然后 `docker compose --profile proxy up --build -d`（会多启动一个 LiteLLM 容器）。

---

## 2. 使用方式

1. 左栏 **+ 新建会话**，在输入框描述任务（Ctrl+Enter 发送）。例如“用 Python 写一个命令行小工具，附测试并运行”。
2. 中间时间线实时显示：助手回复、每一步工具调用（命令、编辑的文件，点开可看输入和输出）、本轮新增/修改的文件、完成状态与耗时。顶部显示“已运行时长 · 最近操作”。
3. 右栏是会话工作区文件：`outputs/`（成果）、`uploads/`（你上传的材料）。点击可预览 Markdown/代码/图片/HTML（HTML 小工具可直接在沙箱 iframe 中运行），也可单独下载或 **打包下载** 整个工作区。
4. 在同一会话继续发送修改意见，助手会接着上一轮的上下文和文件继续工作。
5. 上传材料：点击“上传文件”或拖拽到时间线，文件进入 `uploads/`，下一条消息会自动引用。
6. 多会话：左栏切换，每个会话有独立的工作区和上下文，可同时执行；关闭页面后任务继续在服务器运行，回来可看到完整过程。
7. **停止** 中断正在执行的任务；**导出记录** 下载 Markdown 格式的完整会话记录。

---

## 3. 架构

```
Browser (public/)            Node server (src/)                         Agent CLI (child process)
┌──────────────┐  REST   ┌───────────────────────────────┐ spawn   ┌──────────────────────────────┐
│ 会话列表      │ ──────▶ │ server.js  路由/上传/下载/导出   │ ──────▶ │ codex exec --json [resume id] │
│ 时间线 (SSE)  │ ◀────── │ runner.js  每轮启动 CLI，解析 JSONL│ ◀────── │ cwd = 会话工作区              │
│ 文件面板      │  SSE    │ store.js   events.jsonl 持久化  │  JSONL  │ → 平台 OpenAI Responses API   │
└──────────────┘         └───────────────────────────────┘         └──────────────────────────────┘
                          /data/sessions/<id>/{session.json, events.jsonl, workspace/}
                          /data/agent-home/  (CLI 自己的会话历史，用于 resume)
```

**每条消息 = 一次 CLI 调用**：首轮 `codex exec --json -`，之后 `codex exec resume <thread_id> --json -`（Claude Code 为 `claude -p --output-format stream-json --resume <session_id>`）。提示词走 stdin，避免命令行转义和长度问题。CLI 输出的 JSONL 被转换为统一事件：`user_message / run_started / agent_init / assistant_text / tool_call / tool_result / files_changed / notice / run_finished`，追加写入 `events.jsonl` 并通过 SSE 推给浏览器。

### 关键取舍

- **事件日志即真相**：所有过程写入 append-only 的 `events.jsonl`，SSE 的 `id` 就是事件序号。页面刷新、断网重连（浏览器自动带 `Last-Event-ID`）、换设备打开，都从日志补齐，不会丢步骤，也不依赖页面一直开着。
- **任务在服务端跑，与页面解耦**：浏览器只是观察者；关闭页面不影响执行。
- **会话 = 独立工作区 + CLI 会话 ID**：后续消息用 CLI 原生的 resume 续接上下文，而不是自己拼接历史，保留了 Agent 完整的工具调用记忆；工作区文件跨轮保留，修改意见直接作用在已有成果上。
- **“成果”可见**：每轮前后对工作区做快照比对，生成“本轮成果”卡片（新增/修改/删除）；系统提示约定成果放进 `outputs/`，文件面板分组展示。
- **选择 Codex 直连**：平台接口探测结果为支持 `/chat/completions`、`/responses`，不支持 Anthropic `/messages`。Codex 的自定义 provider 使用 Responses 协议，可直接连，少一层代理、少一个故障点；Claude Code 通过 LiteLLM 转换作为备选，用同一个 `AGENT_CLI` 开关切换。
- **兼容第三方 Responses 实现**：Codex 默认会请求一些 OpenAI 专有的工具类型（托管 web_search、子 Agent namespace）。生成配置时关闭它们，只发送普通 function 工具（`exec_command` 等），降低第三方接口拒绝请求的风险。这一点用本地伪造的 Responses 服务验证过：工具调用、文件写入、resume 均正常。
- **简单持久化**：单用户场景用 JSON/JSONL 文件，没有数据库依赖，数据都在一个 Docker volume 里，便于备份和排查。
- **容器即沙箱**：CLI 以 `--dangerously-bypass-approvals-and-sandbox`（Codex）/`--dangerously-skip-permissions`（Claude Code）运行，免去交互式审批；隔离边界是容器，进程以非 root 的 `node` 用户运行（Claude Code 在 root 下会拒绝跳过权限确认）。

---

## 4. 异常处理

| 场景 | 处理 |
|---|---|
| 模型 API 报错 / 鉴权失败 / 限流 | CLI 自带重试（已配置 `request_max_retries` / `stream_max_retries`）；最终失败时本轮标记“失败”，展示错误信息与 CLI stderr 末尾 |
| 任务卡住或过长 | 单轮超时（`RUN_TIMEOUT_SEC`）后终止整个进程组，标记失败 |
| 用户主动停止 | “停止”发送 SIGTERM 到进程组，5 秒后 SIGKILL；标记“已停止”，已产出的文件保留 |
| 同一会话重复提交 | 返回 409，界面在执行中禁用发送；不同会话可并发，全局上限 `MAX_CONCURRENT_RUNS`（超出返回 429） |
| 服务重启 / 容器重建 | 正常停止时把进行中的任务标记“已中断”；异常崩溃则启动时扫描并补标。会话、事件、工作区和 CLI 历史都在 volume 中，发送新消息即可续接 |
| CLI 会话历史丢失，resume 失败 | 自动新开 CLI 会话，并把本会话最近的对话摘要作为上下文继续，时间线给出提示 |
| CLI 不存在 / 无法启动 | 本轮失败，提示找不到可执行文件 |
| 上传异常 | 单文件大小限制、文件名清洗、重名自动加后缀、中文文件名正确解码 |
| 访问越界 | 文件接口对路径做规范化校验，拒绝 `../` 越出工作区；Agent 生成的 HTML 用 CSP sandbox 打开，不能调用工作台 API |
| 断线 | SSE 自动重连并从最后事件序号补齐；会话列表每 4 秒刷新状态 |
| 凭据缺失 | 页面顶部提示配置 `.env` |

---

## 5. 测试与验证

```bash
npm test                                   # 6 个 API 测试（mock agent，无需网络/key）
node scripts/smoke.js --base http://localhost:8080 --out docs/evidence/run1   # 端到端：代码任务+日常任务+追问+多会话，并导出会话记录
python scripts/probe_api.py <BASE_URL> <KEY> <MODEL>                         # 探测平台支持的协议格式
```

- **CI**（`.github/workflows/ci.yml`）：每次推送都会跑单元测试；构建 Docker 镜像，检查容器内的 CLI 版本和非 root 用户；用 mock agent 启动容器跑冒烟测试，然后重启容器，验证数据保留。日志和导出的会话记录作为 artifact 上传。
- **真实模型端到端**：在仓库 Settings → Secrets 配置 `MODEL_API_KEY`、`MODEL_BASE_URL` 后，手动触发 workflow（勾选 `real_agent`），会在容器内用 Codex + 平台 API 跑完整演示流程，并上传会话记录。
- 演示截图、导出的会话记录等证据见 `docs/`（`docs/DEMO.md` 为演示脚本）。

---

## 6. 安全与凭据

- 凭据只从环境变量（`.env`，已列入 `.gitignore` 和 `.dockerignore`）或 CI secrets 注入；Codex 的 `config.toml` 在启动时由环境变量生成，只写 `env_key` 名称，不写 key 本身。
- Claude Code 路线下，真实 key 只存在于 LiteLLM 容器，Agent 进程拿到的是本地代理 key。
- 端口默认只绑定 `127.0.0.1`（单用户本机使用，不暴露到公网）。

---

## 7. 已知限制

- **单用户、无登录**：设计为本机或个人 Codespace 使用；如需对外提供，应加鉴权并放到反向代理之后。
- **会话间隔离粒度是“目录”，不是“容器”**：所有会话的 Agent 共用一个容器和用户，理论上可以读取其他会话的工作区，也能读到自身进程环境里的模型 key（Codex 直连路线）。生产化应按会话启动独立容器或 microVM，并通过网关注入凭据。
- **同一会话一次只执行一轮**：执行中不能追加消息（需等待或先停止），没有做消息排队。
- **进度粒度取决于 CLI 输出**：Codex 以“步骤完成”为单位输出事件，没有逐 token 的流式输出；长命令执行期间只显示“运行中”。
- **平台模型无元数据**：Codex 对 `linext-5.3-luna` 使用默认的上下文窗口等参数，超长会话可能需要新开会话。
- **LiteLLM 路线（Claude Code）为备选**：本次演示使用 Codex 直连；LiteLLM 镜像使用 `main-stable` 标签，生产应固定版本。
- **文件预览**：文本、Markdown、图片、HTML、PDF 可预览；Office 文档需下载查看（Agent 可以把它们转换成 Markdown）。
- 没有任务成本统计和配额控制（只展示 token 用量）。

---

## 8. 目录结构

```
src/server.js        HTTP API、SSE、上传/下载/打包/导出
src/runner.js        启动 Agent CLI、解析 Codex/Claude JSONL、停止/超时/恢复/resume 回退
src/store.js         会话元数据与事件日志（文件持久化）
src/files.js         工作区遍历、快照比对、安全路径
src/mock-agent.js    模拟 CLI（测试与无 key 演示）
public/              前端（index.html / app.js / style.css）
proxy/litellm.yaml   Claude Code 路线的协议转换配置
scripts/smoke.js     端到端冒烟测试 + 证据导出
scripts/probe_api.py 平台接口协议探测
samples/             演示用材料（销售明细 CSV、会议纪要）
test/                API 测试
docs/                演示脚本、截图与验证证据
```
