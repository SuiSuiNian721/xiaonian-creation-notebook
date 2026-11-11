# 固定参考测试音色服务

工作台的声音克隆、虚拟陪伴与 QQ 可以继续复用这份固定参考。该声音仅用于测试，显示为「测试音色 · 温暖清亮」，不代表小璃；历史路径与内部标识保留用于兼容。每次完整生成单声道 24 kHz PCM16 WAV 后才返回，不提供音频流。

新的声音生成与录音克隆使用同目录的 `studio.py` 工作进程，由宿主传入受控 JSON 任务。`design` 无需参考，`clone` 标准化复制后的录音再合成，`normalize` 只做 CPU 音频处理。生成模型与克隆模型参数分别处理，完整性检查通过后才发布音频。

## 启动

使用已安装的 MOSS Python 环境，不安装第二套模型。私有 JSON 由宿主管理，放在资料目录内，不能提交到仓库；令牌为 32–256 个非空白 ASCII 字符，建议使用宿主生成的随机令牌。

```json
{
  "version": 1,
  "service": "moss-character-voice",
  "token": "由宿主写入的随机私有令牌",
  "profilePath": "E:\\voice\\data\\outputs\\MOSS_小璃固定参考克隆_20261108\\固定参考配置.json",
  "voiceId": "xiaoli-warm-bright",
  "voiceName": "测试音色 · 温暖清亮"
}
```

PowerShell 7：

```powershell
& 'E:\voice\envs\moss-py312\Scripts\python.exe' 'integrations\moss-voice\server.py' --config '<私有 JSON 的绝对路径>' --port 3218
```

服务固定绑定 `127.0.0.1`，要求匹配监听端口的 `Host`。请求可以不带 `Origin`；存在 `Origin` 时仅接受 `http://127.0.0.1[:端口]` 或 `http://localhost[:端口]`。服务不开放跨域授权。私有接口要求 `Authorization: Bearer <token>`；令牌、台词、私有路径与模型异常不会写入服务日志。

启动时验证配置身份、配方及参考 SHA-256、本地模型目录和参考 WAV。`/v1/voices` 与合成前后再次核对配方、参考；文件变化返回 `409 voice_profile_changed`，需要重启服务。模型与 codec 必须来自配方指定的绝对路径，使用离线加载。

## HTTP 合约

| 接口 | 行为 |
| --- | --- |
| `GET /health` | 无需令牌；返回 `service`、`version: 1`、`busy`、`loaded` |
| `GET /v1/voices` | 返回 `voices: [{id, name, profileSha256, referenceSha256}]` |
| `GET /v1/models` | OpenAI 模型列表，唯一模型 `moss-tts-local` |
| `POST /v1/audio/speech` | 完整 WAV；请求体见下方 |
| `POST /shutdown` | 仅停止此服务；已经开始的合成会完成清理 |

```json
{
  "input": "念念，早上好呀。",
  "voice": "xiaoli-warm-bright",
  "model": "moss-tts-local",
  "response_format": "wav"
}
```

台词限 1–500 个 Unicode 字符，不能全为空白；只接受 `application/json`，请求体最多 16 KiB。音色、模型与格式均须准确匹配。成功响应包括 `Content-Length`、`X-Voice-Id`、`X-Voice-Profile-SHA256`、`X-Reference-SHA256`，宿主应核对完整 WAV 与这些身份字段。

错误统一为 `{"error":{"code":"...","message":"..."}}`。缺少令牌为 `401`，非法来源为 `403`，忙时为 `429 voice_busy`，生成达到上限却未出现本次输出的结束标记为 `422 generation_incomplete`，其他推理错误为 `500 synthesis_failed`。不会交付截断音频。未知接口为 `404`。

## 显存与生命周期

第一次合成才加载 processor/codec，并在 CPU 编码固定参考一次。完成编码后移除不再使用的 encoder。每次请求依次执行：加载 LM 到 GPU 并生成 → 删除 LM 和生成期 GPU 张量、释放缓存 → codec 解码器进入 GPU → 完整解码后回到 CPU、释放缓存。请求之间只保留 CPU processor/decoder 与参考编码；`loaded` 表示这些 CPU 资源已就绪，不代表显卡常驻模型。

GPU 合成由单个锁串行执行，第二个请求立即返回 429。固定随机种子 `90321`。沿用配方中的音色采样参数，`max_new_tokens` 作为最低预算，按台词长度扩展为 `min(4096, max(配方预算, 128 + 字符数 × 10))`，以支持长于原试听的台词；仍未正常结束时明确失败，请缩短台词。

宿主取消请求后应丢弃旧结果。客户端断开不会中断已经进入 Torch 的 GPU 推理：服务会完成当前阶段并清理资源，期间保持忙状态，不能启动第二次合成。服务停止会等已经接受的合成清理完成；不会终止工作台、QQ、AIRI 或其他进程。

## 验证

```powershell
$env:PYTHONIOENCODING = 'utf-8'
& 'E:\voice\envs\moss-py312\Scripts\python.exe' -m unittest discover -s integrations/moss-voice/tests -v
```

单元测试使用实际本机 HTTP 与 FakeEngine，不导入 Torch、不运行显卡。它覆盖身份、Bearer、配方/参考变更、完整音频、忙状态、错误、请求边界及停止行为，并验证生成结束检测和异常资源释放。本机安装存在时，还会通过 AST 提取真实处理器工厂，验证加载参数不会透传给不支持它们的构造器；未安装时跳过这一项。真实模型推理、延迟与音色听感需要另外用现有固定配方验收；单元测试不能证明这些结果。
