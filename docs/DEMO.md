# 演示脚本与验证证据

演示环境：`docker compose up --build -d`（`AGENT_CLI=codex`，平台模型 `linext-5.3-luna`），浏览器访问 8080 端口。
截图放在 `docs/screenshots/`，导出的会话记录放在 `docs/evidence/`。

## 演示 1：代码开发任务 + 修改意见

1. 新建会话，发送：
   > 请用 Python 开发一个命令行小工具 outputs/textstats/textstats.py：读取一个文本文件，输出字符数、词数、行数。附带 unittest 单元测试，并实际运行测试，告诉我结果和用法。
2. 观察时间线：助手的计划、每条命令（创建文件、运行测试）及其输出，顶部的运行时长与最近操作。
3. 完成后在右栏 `outputs/textstats/` 预览代码；用“打包下载”取得成果。
4. 继续发送修改意见：
   > 修改意见：增加 --top N 参数，输出出现次数最多的 N 个词；更新测试并重新运行。
5. 确认时间线提示“续接上一轮上下文”，并且“本轮成果”显示的是修改后的文件。

## 演示 2：日常工作任务（上传材料 → 分析整理）

1. 新建另一个会话，上传 `samples/sales.csv` 和 `samples/meeting-notes.md`。
2. 发送：
   > 请分析 uploads/sales.csv（一周销售明细）和 uploads/meeting-notes.md（周例会纪要），整理成一份周报 outputs/weekly-report.md：包含核心数据（销售额、销量、退货率）、按产品的表现、问题与风险、下周行动项（负责人+截止时间）。
3. 在右栏预览渲染后的 `outputs/weekly-report.md`。
4. 继续发送：
   > 请在周报里补充一个按地区汇总的销售额表格，并把结论精简为 5 条要点。

## 演示 3：多会话与恢复

1. 演示 1 执行期间切换到演示 2 的会话，两个任务可以并行执行；左栏的状态点会实时变化。
2. 关闭浏览器标签页再重新打开：自动回到上次的会话，完整过程都在；如果任务仍在执行，会继续实时更新。
3. `docker compose restart app` 后刷新页面：会话、记录、文件都保留，可以继续发送消息。
4. 异常处理：发送一个耗时任务后点击“停止”，状态变为“已停止”；执行中再次发送消息会被拒绝并给出提示。

## 截图清单（docs/screenshots/）

- `01-code-task-running.png` 代码任务执行中（时间线 + 进度）
- `02-code-task-done.png` 代码任务完成，本轮成果与测试输出
- `03-code-followup.png` 修改意见后的续接执行
- `04-daily-upload.png` 上传材料
- `05-daily-report.png` 周报预览
- `06-multi-session.png` 多会话列表 / 并行执行
- `07-after-restart.png` 重启后会话仍在

## 自动化证据

- `node scripts/smoke.js --base http://localhost:8080 --out docs/evidence/real-run`：用真实模型自动跑完上述两个任务和各自的追问，导出 `session-*.md` 会话记录。
- GitHub Actions `ci` workflow：单元测试、Docker 构建、容器内冒烟测试、重启后数据持久化检查；日志可在 Actions 页面查看。
