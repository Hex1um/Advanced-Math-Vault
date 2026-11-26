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
2. **图表题先跳过**，除非把图裁成独立 SVG/WebP 并走 `physicsMeta.diagrams` 白名单。
3. **逐题过量纲与公式门禁**：

```bash
node tools/verify/check-physics-gate.mjs      # 标签体系 / 配图 / 单位解析 / 答案自检
python tools/verify/verify_physics.py --file data/batch-<批次>.json
node tools/verify/check-katex.mjs --max-fail=0 --file data/batch-<批次>.json
```

## 4. 记录来源

- `source`：`漆安慎《力学》第4版 习题2.1.1`（书 + 习题号，便于对照原书）
- `physicsMeta.textbookRef`：同上，供题页显示与后续核对
- 不要写页码：扫描件页序与印刷页码相差常数偏移，写页码容易误导。
