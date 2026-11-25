# 音乐推荐视频生成器 (`music-rec-video-remotion`)

基于 **FastAPI + Vue 3 + Remotion (React)** 的端到端音乐推荐视频制作工作台。完全脱离 Adobe Premiere Pro / After Effects，直接在浏览器完成选歌、定剪、排版预览并本地渲染输出 1080p 60fps 成片。

---

## 📂 项目结构

```text
music-rec-video-remotion/
├── server.py                  ← 🌐 FastAPI Web 控制台与媒体服务入口
├── backend/                   ← ⚙️ Python 核心业务模块
│   ├── schema.py              ←    Pydantic 统一歌单数据模型 (支持多段 clips / 转场 / 动效)
│   ├── netease.py             ←    网易云歌单解析 & 1:1 专辑封面抓取
│   ├── netease_audio.py       ←    网易云音源解析与音频/合成 MV 下载 (.js / .json 一键导入)
│   ├── bilibili.py            ←    B站开放接口搜索 (免登录 Wbi 签名)
│   ├── download.py            ←    1080p MV 下载引擎 (yt-dlp + Node.js JS 运行时 + FFmpeg)
│   ├── preprocess.py          ←    1:1 封面裁剪 & -14 LUFS 响度归一化
│   ├── lyrics.py              ←    网易云双语歌词拉取与时间戳 JSON 导出
│   └── analyze_visuals.py     ←    画面亮度区域分析 (用于文字阴影自适应对比度)
├── web/
│   └── index.html             ← 🖥️ Vue 3 + Tailwind 可视化工作台
├── remotion/                  ← 🎬 Remotion 视频工程 (React + TypeScript)
│   └── src/
│       ├── Root.tsx           ←    Composition 入口与总时长动态计算
│       ├── types.ts           ←    PlaylistConfig / SongItem 类型定义
│       ├── utils/
│       │   ├── time.ts        ←    时间解析与静态资源路径映射
│       │   ├── segments.ts    ←    单曲多段展开 & 等功率音频淡入淡出计算
│       │   └── customTransitions.tsx ← 10 种纯 CSS GPU 合成转场
│       └── components/
│           ├── PlaylistVideo.tsx ← TransitionSeries 主时间线编排
│           ├── IntroCard.tsx     ← 开场白 (首曲虚化/黑底/自定义图 + 空行分页依次淡入淡出)
│           ├── SongSegment.tsx   ← 悬浮毛玻璃底栏 + 封面 + 跑马灯 + 推荐语 + 双语歌词
│           ├── AudioSpectrum.tsx ← 实时对数分频音频频谱可视化
│           └── VisualEffects.tsx ← 鼓点脉冲 / 赛博故障 / 缓慢推拉 / 黑胶旋转
├── playlist.json              ← 🎯 当前歌单配置文件
├── requirements.txt           ← 📦 Python 依赖清单
└── output/                    ← 🎞️ Remotion 导出的成片目录
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

## 🛠️ 使用流程

1. **启动 Web 控制台**：
   ```bash
   python server.py
   ```
   浏览器打开 **[http://localhost:8000](http://localhost:8000)**。

2. **选歌与准备素材**：
   - 顶部 **导入网易云歌单**，自动获取曲目与 1:1 专辑封面；
   - 在每首歌卡片挑选 B站 / YouTube 候选下载（已下载的歌曲右侧候选面板会自动折叠），也可点击 **「📁 选用本地视频」** 直接导入本地录像，或通过 **「网易云音源」**（支持 `.js` / `.json` 一键导入解析）下载纯音频 / 封面合成 MV；
   - 点击 **「一键下载全部 1080p」** 完成 `-14 LUFS` 响度统一，点击 **「✨ 视觉分析与歌词」** 拉取双语歌词并分析画面亮度。

3. **精准定剪、多段高潮与文案**：
   - 点击单曲 **「✂️ 精准定剪试听」**，支持 `Space` 播放、`I` 设入点、`O` 设出点、`←/→` 步进 0.5s；
   - 可在弹窗内点击 **「➕ 添加分段」** 把一首歌拆成多段高潮（共享同一 `#序号`，段间自动 `0.35s` 短叠化），并为每段填写独立推荐语与校准双语歌词偏移。

4. **转场、动效与开场白**：
   - 支持启用 **开场白（Intro）**（首曲虚化背景 + 空行分页依次过渡，音乐从第 0 秒连续播放直至卡点切入推歌画面）；
   - 全局及单曲支持多种纯 CSS 转场（交叉叠化、动态模糊滑入、缩放模糊、交叉变焦、黑场、闪白、推拉、擦除、3D 翻转、硬切）与等功率音频淡入淡出；
   - 每首歌可选 **鼓点脉冲缩放**、**赛博故障特效**、**电影缓慢推拉** 或 **黑胶唱片旋转**。

5. **实时预览与导出成片**：
   - 点击右上角 **「🎬 Remotion 实时预览」** 打开 `http://localhost:3000` 实时拖拽预览；
   - 确认无误后点击 **「🚀 Remotion 导出成片」**，直接在本机渲染输出 1080p 60fps MP4 到 `output/` 目录。
