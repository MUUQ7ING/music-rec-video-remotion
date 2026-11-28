# 音乐推荐视频生成器 (`music-rec-video`)

基于 **FastAPI + React + TypeScript + Remotion (React)** 的端到端音乐推荐视频制作工作台。完全脱离 Adobe Premiere Pro / After Effects，在浏览器中完成歌单导入、素材获取、多段定剪、双语逐词歌词同步、文案编排与实时预览，并直接在本地渲染输出 1080p 60fps MP4 成片。

---

## 在线工作台

[打开 MRV-02 工作台](https://muuq7ing.github.io/mrv-02/)。默认加载《美好的未来》，可试用选曲、剪辑、文案编辑、FX 和全片预览。编辑保存在当前浏览器。静态演示使用封面画面，原曲音视频、下载和 MP4 导出需要本地服务与素材。

[下载示例歌单 JSON](examples/a-beautiful-future.json)

本地版使用从 [Andeus Design 源码](https://github.com/ardey26/andeus-design/tree/94c08bb776db5412799ed3f75ac039bc6c5e8121) 构建的组件包。全片编辑可从左侧选曲，在磁带轴下方修改所选片段的推荐文案。

## 📂 项目结构

```text
music-rec-video/
├── server.py                       ← 🌐 FastAPI Web 控制台、媒体流服务与后台任务调度
├── backend/                        ← ⚙️ Python 核心业务模块
│   ├── schema.py                   ←    Pydantic 统一歌单模型（原子写入 & 运行时字段剔除）
│   ├── netease.py                  ←    网易云歌单解析、1:1 官方封面与 YRC/LRC 双语歌词抓取
│   ├── netease_audio.py            ←    网易云音源解析、音频下载（FLAC 自动转码 M4A 兼容 Remotion）
│   ├── bilibili.py                 ←    B站开放接口搜索（免登录 Wbi 签名 & 二维码登录）
│   ├── download.py                 ←    1080p MV 下载引擎（yt-dlp + Node.js JS 运行时 + FFmpeg）
│   ├── preprocess.py               ←    1:1 封面裁剪 & EBU R128 (-14 LUFS) 响度归一化
│   ├── lyrics.py                   ←    网易云 YRC 毫秒级逐词 & LRC 双语歌词解析与 SRT 导出
│   └── analyze_visuals.py          ←    画面分区亮度分析（文字阴影自适应对比度）
├── web/                            ← 🖥️ React + TypeScript 工业风工作台（Teenage Engineering 风格）
│   ├── src/                        ←    工作台组件、状态管理、样式与快捷键
│   ├── vendor/                     ←    从 Andeus 上游源码构建的组件包
│   └── dist/                       ←    FastAPI 提供的前端构建文件
├── remotion/                       ← 🎬 Remotion 视频工程（React + TypeScript）
│   ├── remotion.config.ts          ←    ANGLE WebGL2 渲染配置
│   └── src/
│       ├── Root.tsx                ←    Composition 入口与总帧数动态计算
│       ├── types.ts                ←    PlaylistConfig / SongItem / LyricWord 类型定义
│       ├── utils/
│       │   ├── time.ts             ←    时间解析、开场白字数时长估算 & 分段文案切分
│       │   ├── segments.ts         ←    单曲多段展开 & 等功率 (sin/cos) 音频交叉淡入淡出
│       │   └── customTransitions.tsx ← 纯 CSS GPU 合成转场（甩镜/帷幕/模糊/变焦/闪白/黑场）
│       └── components/
│           ├── PlaylistVideo.tsx   ← TransitionSeries 主时间线与 Overlay 漏光编排
│           ├── LightLeakOverlay.tsx ← @remotion/effects 透明滤色 (screen) 漏光叠加层
│           ├── IntroCard.tsx       ← 开场白（首曲虚化/黑底/自定义图 + 空行分页按字数加权）
│           ├── SongSegment.tsx     ← 悬浮毛玻璃底栏 + 封面 + 跑马灯 + 多段文案 + 双语歌词
│           ├── AudioCoverStage.tsx ← 纯封面/音频舞台（背景氛围、粒子与鼓点呼吸）
│           ├── AudioSpectrum.tsx   ← 实时对数分频音频频谱可视化
│           ├── FlowLyricsStage.tsx ← 流光（Flow）逐词动力学歌词舞台（支持 YRC 精确时间戳）
│           └── VisualEffects.tsx   ← 赛博 HUD / 侧立封面滚动歌词 / 流光歌词 / 声波光环 / 3D / 黑胶 / CRT / 故障
├── tests/                          ← 🧪 后端接口、Schema、Remotion 类型与 Playwright E2E 测试
├── playlist.json                   ← 🎯 当前歌单配置文件
├── requirements.txt                ← 📦 Python 依赖清单
└── output/                         ← 🎞️ Remotion 导出的成片目录
```

---

## 🚀 环境准备

确保已安装 **Python 3.10+、Node.js 18+、FFmpeg**：

```bash
# 1. 安装 Python 依赖
pip install -r requirements.txt

# 2. 安装 Remotion 依赖
npm --prefix remotion ci

# 3. 安装并构建 Web 工作台
npm --prefix web ci
npm --prefix web run build
```

---

## 🛠️ 核心功能与使用流程

1. **启动 Web 控制台**：
   ```bash
   .venv/bin/python server.py
   ```
   浏览器打开 **[http://127.0.0.1:8022](http://127.0.0.1:8022)**，右上角支持一键切换 **亮色 / 暗色** Teenage Engineering 工业风主题。

2. **三区工作台（Rack + Deck + Console）**：
   - **左侧 `TRACK RACK`**：顶部为 `00 INTRO`（开场白与全局转场），下方为曲目机架列表，支持状态筛选、拖拽排序与状态指示灯。
   - **`01 MONITOR & TRIM`**：内置监视器播放器、`Space` / `I` / `O` / `←` / `→` 快捷定剪、单曲多段高潮（`+ ADD CLIP`）、右侧可拖拽分栏的 **双语歌词实时同步** 与 **分段推荐语**（支持 `AUTO` 按字数 / `MANUAL` 手动打点）。
   - **`02 SOURCE MATRIX`**：统一管理 **视频源（B站/YouTube 候选检索、本地上传）** 与 **网易云高音质音频 + 官方封面（`netease_cover`）**；网易云下载的 `.flac` 自动转码为 `320k AAC (.m4a)` 以兼容 Remotion 音频可视化。
   - **`03 STAGE & FX`**：集中配置曲目信息、视觉动效、单曲转场与画面亮度检测。

3. **丰富视觉动效与精确逐词歌词**：
   - **网易云 `yrc` 逐词时间戳**：自动抓取并解析毫秒级逐词时间戳，无 `yrc` 曲目自动回退均匀切分。
   - **内置视觉动效**：
     - `cyber_hud`（赛博音频 HUD + 粒子 + 底部示波器）
     - `lyric_stage`（3D 侧立封面 + 整词渐亮弹簧滚动双语歌词）
     - `flow_lyrics`（流光逐词动力学舞台 + 中央专辑封面）
     - `waveform_aura`（声波光环）、`float_3d`（3D 悬浮卡片）、`vinyl_spin`（黑胶旋转）、`retro_crt`（复古 CRT）、`beat_pulse`（鼓点脉冲）、`glitch`（卡点故障）、`ken_burns`（缓慢推拉）。

4. **实时预览与一键导出**：
   - 点击顶栏 **「STUDIO」** 在工作台内打开 Remotion Studio（`http://127.0.0.1:3022`）；
   - 点击 **「EXPORT MP4」** 在本机渲染输出 1080p 60fps MP4 至 `output/` 目录，底部控制台实时输出进度日志并支持随时中断。

---

## 🧪 测试与开发命令

```bash
# 运行快速测试（后端 API / Schema / Remotion TS 检查 / Playwright E2E）
.venv/bin/pytest -v -m "not slow"

# 生成前端 E2E UI 截图到指定目录
MRV_SCREENSHOT_DIR=/tmp/mrv_shots .venv/bin/pytest -v tests/test_frontend_e2e.py

# 运行完整测试套件
.venv/bin/pytest -v
```
