# 内置 LoRA 训练内核

本目录提供 Next Trainer `3.3.1-dev` 的修改版源码快照和工作台适配层。底模与引擎的支持矩阵来自同一快照的 `frontend/src/training/modules.ts`，接入 Kohya、anima-fast、Musubi、AI Toolkit、DiffSynth、MOSS 六种引擎的状态、预检、维护和训练分派。控制代码已内置不等于各引擎环境已安装；缺少的训练源码、Python 依赖和模型需要按计划显式准备。

## 来源与许可

- 上游：<https://github.com/wochenlong/lora-scripts-next>
- 基准提交：`12963ec369f0c6dd0a0cff94aed6da39ec3929e2`。
- 快照来自本机修改后的工作目录，当前包含 740 个受清单校验的文件；未用单独的 `git archive HEAD` 代替未提交修改。
- `source-manifest.json` 记录来源、原始路径、基准提交、本地修改文件和每个文件的 SHA-256。
- `source/` 中的工作台改动由清单的 `modifiedFiles` 和逐文件哈希记录。Git 必须保留本目录的换行字节，不进行自动转换；原安装目录不修改。
- Next Trainer 主仓库许可为 AGPL-3.0，见 [LICENSE](source/LICENSE) 和 [NOTICE.md](source/NOTICE.md)；sd-scripts 许可见 [LICENSE.md](source/vendor/sd-scripts/LICENSE.md)。各子目录原有许可一并保留。

快照包含 MOSS 配置识别、MOSS 文本缓存接口修正、训练时间估算、硬件监控的本地修改。原安装的 `assets/config.json`、`user_data`、日志、输出、自动保存参数、模型、虚拟环境和 Git 目录均不进入快照。

## 运行边界

`framework/training-runtime.mjs` 先校验清单，再把控制源码复制到 APP 资料目录的 `training/kernel/<revision>`。引擎可以复用原安装的对应扩展，或使用工作台自有隔离目录；原控制程序不作为工作台入口执行。默认探测原便携包同级的 `python_embeded/python.exe`，也可显式选择 Python。没有原 Next Trainer 时使用工作台自有目录；“准备服务环境”会在明确执行后安装基础 API 依赖，便携 Python 缺少 venv 时可使用其 uv 创建环境。启动、状态读取和首次资源检索均不会自行安装依赖。

`runner.py` 是 API 专用入口，不运行原 `gui.py`、原应用 lifespan、插件恢复或更新检查。启动阶段不导入 Torch。服务使用随机回环端口、随机凭据和进程身份握手，开放版本、引擎状态、校验、预检、训练、任务、日志、预览与硬件接口，以及受白名单限制的引擎安装／修复计划和执行接口；不开放任意脚本或原网页路由。维护前阻止活动任务，展示原环境与隔离环境选择，完成后仍需单独预检并提交训练。

Anima、Musubi、AI Toolkit 的原生扩展目录分别为 `anima_lora`、`musubi_tuner`、`ai_toolkit`。工作台统一这些目录与持久环境根的映射。`source/mikazuki/engines/workbench_paths.py` 和三份环境计划构造器校验工作台写入的精确根绑定，允许所选持久目录参与计划；没有绑定时继续采用原有路径限制。内核升级后环境仍在 `training/engine-environments` 或用户选定的原安装内。

保存参数和实际任务档案由 `read_configs.py` 只读导入。原 Kohya 接口即使指定 `dataset_config` 仍要求 `train_data_dir`；工作台保留这一要求。没有重复次数子目录且未指定数据集配置的散图目录会被拒绝，避免原内核自动移动图片和标注。训练前会将需要规范化的采样提示文件复制到本次独立自动保存目录；复制失败会拒绝提交，不会回退到修改原文件。

## 提交与生命周期

- 提交编号在异步预检前写入 SQLite，经过 `checking → submitting → submitted`；预检明确失败为 `failed`，响应丢失或服务内部异常为 `uncertain`。
- 相同编号只能对应同一份配置；不确定的同配置不能换编号重投。任务的实例归属和请求编号在创建前写入后台队列，允许响应丢失后对账。
- `checking` 只有在原工作台进程已不存在时才能恢复为明确失败；进程身份不能证明时继续保留待核对状态。
- 多模块实例共享后台队列，分别拥有提交记录和任务控制权限。停止某组任务会先移除排队阶段，再停止正在运行的阶段。
- 移除实例前设置提交门闩，仅检查该实例的未决记录和活动任务；其他实例的工作不受影响。无法核实离线后台时先保留实例，避免失去任务控制入口。
- 活动任务阻止关闭后台。退出工作台时保留活动后台进程，下次启动按认证身份重连；空闲后台关闭后须确认 PID 已消失才清除运行记录。
- 身份接口暂时失联但 PID 仍存在时，状态为 `unresponsive`，不会另起第二个队列。异常退出留下的启动锁会给出具体文件路径；只能在确认相关训练进程均已退出后处理该锁。
- 每个任务有独立持久日志；恢复终态任务时从限定目录读取日志尾部和进度。活动任务的 ETA 使用实时样本，历史任务保留已结束时长。

## 验证

常规协议与生命周期测试不使用 GPU：

```powershell
node --test tests/training-kernel.test.mjs tests/training-service.test.mjs
```

使用现有环境进行真实 Python 只读烟雾验证：

```powershell
$env:NEXT_TRAINER_SMOKE_ROOT = '已有 Next Trainer 目录的绝对路径'
node --test --test-name-pattern='actual installed Python' tests/training-kernel.test.mjs
```

该检查只启动隔离 API、查询环境与硬件、读取原参数、校验 MOSS 参数，并以隔离的终态任务样本验证日志恢复。不会调用真实后台的 `/api/run`，不会安装依赖，不会停止原训练服务。通过这些检查不代表已验证真实训练吞吐、显存占用或成品画质。

`snapshot.py --source <原始目录>` 用于显式重新生成快照。它以 Git 文件清单和指定的新增源码为白名单，逐文件复制并更新哈希；更新后需重新检查许可、快照差异和上述测试。

## 一键图集流程

工作台的 `TrainingPipeline` 将方案、图集副本、检测裁切、本地标注、标注校验、训练与产物收集串成持久化阶段。默认不调用外部 AI；启用 AI 时通过训练模块的现有接入，仅接受有限的用途、触发词和数字参数建议，不允许 AI 返回路径、标注格式或命令。原图与原标注只读，处理结果和生成的数据集 TOML 位于实例自己的 `training/workflows`。

`runner.py` 新增受管工作副本限定的 `/api/tagger/check` 和 `/api/tagger/run`。打标由 compute 队列中的独立 Python 子进程执行，复用原有打标实现，不在服务启动阶段加载 ONNX 或 Torch。检查会分别报告缺少的 Python 包和本地模型；模型下载必须由流程输入的 `allowDownload` 显式启用。导入库继续使用已校验的快照，批量操作以工作副本为当前目录，避免路径通配符和同名 `images` 祖先引起错误输出。触发词在识别标签归一化后原样补入，不改变下划线和括号。

阶段请求在 SQLite 中绑定流程与阶段。响应丢失先对账，明确继续时可释放重启后恢复的 held 队列任务。上游将异常退出中的任务标记为 interrupted，但这不证明旧子进程已结束；这种任务保留待处理，不能自动重交或声明取消完成。第三方快照保持原字节，本次修改只发生在工作台适配层。

`tests/training-tagger.test.mjs` 使用真实 Python adapter 和原生批量文件写入逻辑，替换识别模型为测试替身，验证特殊路径、触发词及图片字节。它不代表真实识别精度或 GPU 训练已验收。

## 专项策略与本地视觉模型

- 角色保留原图，另存主体和脸部特写，特写组降低重复权重；WD14 标注排除已知角色名字。
- 画风保留整图与色彩，移除常见媒介标签；自然语言模式移除开头的画法套语，保留画面内容。规则不保证完整分离内容与风格，需抽查自动描述。
- 姿势用主体框和可靠的全身关键点并集裁切；手腕、脚踝不足或越界时保留全图并记录原因，关闭水平翻转。

`workbench_vision.py` 独立实现 YOLOX / SimCC 坐标解码，不执行现有 ComfyUI 插件的代码。`/api/preprocess/check` 和 `/run` 将裁切纳入原 compute 队列。新增图像不继承父图 TXT，必须通过自己的图像识别重新标注。清单原子提交，保存图片、标注哈希和任务绑定；校验失败阻止后续训练。透明图给模型合成白底，派生 PNG 保留透明度。

`captionFormat: auto` 时，SD / SDXL 使用 WD14 标签；MOSS、Flux、Lumina、Anima 使用本地 Florence-2 自然语言。前后端共用 `public-workbench/training-types.js`；仅处理图集也传当前 `model_train_type`，无需训练底模。自然语言不打乱、不丢词；标签只在文本编码缓存关闭时打乱。数据集与提交参数同步禁用 caption dropout 和 token warmup，避免缓存冲突。

| 处理 | Python | 默认模型目录（相对共享 training 目录） | 必需文件 |
| --- | --- | --- | --- |
| 裁切 | 服务 Python：Pillow、NumPy、OpenCV、ONNX Runtime | `preprocess-models/dwpose` | `yolox_l.onnx`、`dw-ll_ucoco_384.onnx` |
| 标签 | 服务 Python：另需 pandas、huggingface-hub | `tagger-models/wd14/<model>` | `model.onnx`、`selected_tags.csv` |
| 自然语言 | 所选安装的 `extensions/kohya/.venv`：Torch、原生 Florence2 Transformers、Pillow、safetensors | `preprocess-models/florence2-base` | 原生模型、处理器和 tokenizer 配置及 `model.safetensors` |

默认 CPU 处理，权重齐全时只读本地文件；已有兼容标注可不加载模型。首次下载需 `allowDownload: true`，只接受数据与 safetensors，不执行远程自定义 Python。裁切也支持 `detectorPath`，自然语言支持 `captionModelPath`，可复用已有权重目录。自然语言原生格式使用 [florence-community/Florence-2-base](https://huggingface.co/florence-community/Florence-2-base)，不能用旧 Microsoft 远程代码格式代替；实现依据 [Transformers Florence2 文档](https://huggingface.co/docs/transformers/model_doc/florence2)。

固定下载来源：DWPose `yzd-v/DWPose@1a7144101628d69ee7a3768d1ee3a094070dc388`；Florence `florence-community/Florence-2-base@00921df66db728a9ceb750f5eca43e5c203a2051`。WD14 沿用上游打标器的受控模型列表与版本。模型不进入源码或 Git；升级副本摘要覆盖三个自有 Python 处理器，第三方快照仍逐字节校验。
