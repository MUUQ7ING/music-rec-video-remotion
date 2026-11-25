# 音乐推荐视频生成器 (`music-rec-video-remotion`)

基于 **FastAPI + Vue 3 + Remotion (React)** 的端到端音乐推荐视频制作工作台。完全脱离 Adobe Premiere Pro / After Effects，在浏览器完成歌单导入、素材获取、多段定剪、文案编排、实时预览，并直接在本地渲染输出 1080p 60fps MP4 成片。

---

## 📂 项目结构

```text
music-rec-video-remotion/
├── server.py                       ← 🌐 FastAPI Web 控制台、媒体流服务与后台下载队列
├── backend/                        ← ⚙️ Python 核心业务模块
│   ├── schema.py                   ←    Pydantic 统一歌单模型 (media_source / clips / reason_mode / 转场 / 动效)
│   ├── netease.py                  ←    网易云歌单解析 & 1:1 官方专辑封面抓取
│   ├── netease_audio.py            ←    网易云音源解析与音频/封面合成 MV (.js / .json 一键导入)
│   ├── bilibili.py                 ←    B站开放接口搜索 (免登录 Wbi 签名)
│   ├── download.py                 ←    1080p MV 下载引擎 (yt-dlp + Node.js JS 运行时 + FFmpeg)
│   ├── preprocess.py               ←    1:1 封面裁剪 & EBU R128 (-14 LUFS) 响度归一化
│   ├── lyrics.py                   ←    网易云双语歌词拉取与时间戳 JSON 导出
│   └── analyze_visuals.py          ←    画面分区亮度分析 (文字阴影自适应对比度)
├── web/
│   └── index.html                  ← 🖥️ Vue 3 + Tailwind 可视化工作台
├── remotion/                       ← 🎬 Remotion 视频工程 (React + TypeScript)
│   ├── remotion.config.ts          ←    ANGLE WebGL2 渲染配置
│   └── src/
│       ├── Root.tsx                ←    Composition 入口与总帧数动态计算
│       ├── types.ts                ←    PlaylistConfig / SongItem / SongClip 类型定义
│       ├── utils/
│       │   ├── time.ts             ←    时间解析、开场白字数时长估算 & 单段多文案时间轴切分
│       │   ├── segments.ts         ←    单曲多段展开 & 等功率 (sin/cos) 音频交叉淡入淡出
│       │   └── customTransitions.tsx ← 纯 CSS GPU 合成转场 (甩镜/帷幕/模糊/变焦/闪白/黑场)
│       └── components/
│           ├── PlaylistVideo.tsx   ← TransitionSeries 主时间线与 Overlay 漏光编排
│           ├── LightLeakOverlay.tsx ← @remotion/effects 透明滤色 (screen) 漏光叠加层
│           ├── IntroCard.tsx       ← 开场白 (首曲虚化/黑底/自定义图 + 空行分页按字数加权)
│           ├── SongSegment.tsx     ← 悬浮毛玻璃底栏 + 封面 + 跑马灯 + 多段文案 + 双语歌词
│           ├── AudioSpectrum.tsx   ← 实时对数分频音频频谱可视化
│           └── VisualEffects.tsx   ← 鼓点脉冲 / 赛博故障 / 缓慢推拉 / 黑胶旋转
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
cd remotion && npm install
```

---

## 🛠️ 核心功能与使用流程

1. **启动 Web 控制台**：
   ```bash
   python server.py
   ```
   浏览器打开 **[http://localhost:8000](http://localhost:8000)**。

2. **歌单导入与素材获取（三合一来源 + 后台队列）**：
   - 顶部 **「⚙️ 导入与工具 ▾」** → **导入网易云歌单**，自动获取曲目信息与 1:1 官方封面；
   - 通过 **网易云音源设置** 支持直接导入 `.js`（如洛雪音源脚本）或 `.json` 文件一键解析保存；
   - 每首歌卡片支持在 **「🌐 视频链接 / 💿 网易云合成 / 📁 本地视频」** 三种素材来源间切换（已下载歌曲默认折叠右侧 12 格候选面板）；
   - 单曲下载支持**后台队列模式**，可连续点击多首歌排队下载；顶栏 **「⬇ 一键下载」** 会按每首歌设定的 `media_source` 自动分流下载或合成并完成 `-14 LUFS` 响度统一。

3. **精准定剪、多段高潮与同段多文案**：
   - 点击 **「✂️ 精准定剪试听」**（`Space` 播放、`I` 设入点、`O` 设出点、`←/→` 步进 `0.5s`）；
   - 支持在弹窗内 **「➕ 添加分段」** 将一首歌拆成多段高潮（共享同一 `#序号`，段间自动 `0.35s` 短叠化）；
   - 单个片段内的推荐语也支持用**空行（回车两次）**拆分为多段依次切换，提供 **「自动按字数」** 与 **「手动定时（可边听边点 ⏱ 当前打点）」** 两种方式，并支持双语歌词实时校准。

4. **开场白、电影级转场与纯封面动效**：
   - **开场白（Intro）**：支持首曲虚化背景 + 空行分页依次过渡 + **根据文本量自动估算时长**，且音乐从第 0 秒连续播放直至开场白结束卡入首曲高潮；
   - **丰富转场 + 等功率音频淡入淡出**：支持透明滤色漏光（暖金 / 赛博霓虹 `Light Leak`）、高速甩镜（`Whip Pan`）、电影帷幕（`Curtain`）、动态模糊滑入、缩放模糊、交叉变焦、黑场、闪白、3D 翻转等；
   - **纯封面 / 画面特效**：支持 **鼓点脉冲缩放**、**赛博故障特效**、**电影缓慢推拉** 与 **黑胶唱片旋转**。

5. **实时预览与一键导出**：
   - 点击顶栏 **「🎬 实时预览」** 打开 Remotion Studio（`http://localhost:3000`）拖拽时间轴实时预览；
   - 点击 **「🚀 导出 MP4」** 在本机渲染输出 1080p 60fps MP4 至 `output/` 目录，渲染过程中可随时点击 **「⏹ 停止渲染」** 中断。
