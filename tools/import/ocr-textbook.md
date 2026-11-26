# 教材扫描件 OCR 录入流程

面向「没有文字层、没有答案页」的教材扫描件，把习题录进题库时的标准流程。
仓库本身仍是零依赖：OCR 工具只在本地出题时使用，不进入线上运行时。

## 1. 环境（本机一次性）

```bash
# 注意：本机 pip 走代理时装不上 compiled wheel，安装前必须 unset 代理
env -u https_proxy -u HTTPS_PROXY python -m pip install \
    -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host mirrors.aliyun.com \
    pymupdf rapidocr-onnxruntime
```

- `pymupdf`：渲染页面为 PNG（`page.get_pixmap(dpi=200)`），并读取书签目录。
- `rapidocr-onnxruntime`：中文 OCR（ONNX，无需 PaddlePaddle）。

## 2. 定位与识别

```bash
python _ocr/ingest.py toc                  # 打印书签目录（找「习题」所在页）
python _ocr/ingest.py pages 68 72          # 逐页 OCR 并打印
python _ocr/ingest.py chapter 2            # 整章「习题」段落写入 _ocr/ch2.txt
```

识别质量：中文正文约 95% 可用；**公式、上下标、分式必然失真**（如 `v₀`→`u。`、
`½at²`→`at?`），必须按物理语义人工重写，不能直接照抄 OCR 结果。

## 3. 入库前的三条硬规矩

1. **答案必须自己算**。多数教材扫描件不含答案页（本书目录指向的「习题答案」实为封底），
   所以每道题的答案由录入者推导，并用脚本独立复算（数值题）或量纲校验（符号题）。
2. **图表题必须配图**。题干条件在图里的题，脱离图无法作答，不要硬编成文字题；
   用 `_ocr/figures.py` 把图裁成 WebP，再走 `physicsMeta.diagrams` 白名单。
3. **逐题过量纲与公式门禁**：

```bash
node tools/verify/check-physics-gate.mjs      # 标签体系 / 配图 / 单位解析 / 答案自检
python tools/verify/verify_physics.py --file data/batch-<批次>.json
node tools/verify/check-katex.mjs --max-fail=0 --file data/batch-<批次>.json
```


## 4. 题图裁切（`_ocr/figures.py`）

扫描件每页是一整张位图，没有可用的图元信息，因此按「版面」而不是「对象」来分离图与文字：

```bash
python _ocr/figures.py scan 154 156     # 只打印候选图区与匹配到的题号，不落盘
python _ocr/figures.py cut 154 156      # 裁图并写入 public/assets/diagrams/physics/
```

算法：

1. 300 dpi 灰度渲染，`gray < 180` 取墨迹；
2. `9×9` 膨胀后做连通域——单行文字各自成块，图里的线条与标注会合成一个大块；
3. 丢弃「与 OCR 文本框 IoU > 0.55」「宽高过小」「贴顶扁平（页眉）」「墨水密度 > 0.35」的块；
4. 用 OCR 文本里 `题x.y.z图` 的标签中心，按「竖直距离加权 1.6 倍」找最近的图块配对；
5. 裁图外扩 14 px，宽度超过 760 px 的缩放，转 WebP（质量 88，method 6）。

产出命名 `tb-<题号>-p<页>-<序>.webp`，例如 `tb-4-3-1-p155-0.webp`。

注意事项：

- 无标签的图块（多为图内碎块或页眉残留）会命名为 `tb-x-...`，**不要入库**，裁完就删。
- 配对只看「标签到图块的距离」，同页图多时仍可能错配，必须抽检：把若干张拼成 contact sheet
  用视觉确认（装置、坐标轴、尺寸线是否完整），别只看文件名就配题。
- 只保留被 `physicsMeta.diagrams` 引用的图，其余删掉，避免仓库里堆无用位图。
- 配图渲染走 `<img>` 白名单（`assets/diagrams/physics/*.svg|webp|png|jpg`），不内联 SVG；
  单图上限 300 KB，`check-physics-gate` 会校验断链与体积。

## 5. 记录来源

- `source`：`漆安慎《力学》第4版 习题2.1.1`（书 + 习题号，便于对照原书）
- `physicsMeta.textbookRef`：同上，供题页显示与后续核对
- 不要写页码：扫描件页序与印刷页码相差常数偏移，写页码容易误导。
