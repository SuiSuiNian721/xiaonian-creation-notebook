const revision = 'e87f176479d0855a907a41277aca2f8ee7a09523';
const modelRoot = `https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/${revision}`;
const files = [
  {id:'model',filename:'Qwen3.5-4B-Q4_K_M.gguf',url:`${modelRoot}/Qwen3.5-4B-Q4_K_M.gguf`,bytes:2740937888,sha256:'00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4'},
  {id:'projector',filename:'mmproj-F16.gguf',url:`${modelRoot}/mmproj-F16.gguf`,bytes:672423616,sha256:'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864'},
  {id:'runtime',filename:'llama-b12110-bin-win-vulkan-x64.zip',url:'https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-win-vulkan-x64.zip',bytes:37661146,sha256:'9732a5e48887ca54d0bfe4af4324dc85fd56cd8cda19b52df3542fa6ebe6874f'},
];
const unpackedBytes = 105954589;
const downloadBytes = files.reduce((sum, file) => sum + file.bytes, 0);

export const VISION_PACKAGE = Object.freeze({
  id:'qwen35-4b-q4km-b12110',name:'Qwen 3.5 4B 本地视觉扩展',model:'Qwen3.5-4B',quantization:'Q4_K_M',
  alias:'workbench-qwen-vision',files,downloadBytes,
  // 保留通过校验的运行器压缩包；修复时会同时存在旧运行库和新解压目录。
  installedBytes:downloadBytes + unpackedBytes,peakDiskBytes:downloadBytes + unpackedBytes * 2,
  requirements:['Windows x64','建议至少 16 GB 内存','4 位量化、8K 上下文预计需要约 6 GB 显存，实际占用取决于设备和其他应用','支持 CPU 运行，速度较慢'],
  links:[
    {label:'Qwen 原始模型 · Apache-2.0',url:'https://huggingface.co/Qwen/Qwen3.5-4B'},
    {label:'Unsloth GGUF 量化 · Apache-2.0',url:'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF'},
    {label:'llama.cpp b12110 · MIT',url:'https://github.com/ggml-org/llama.cpp/releases/tag/b12110'},
  ],
  runtime:{directory:'runtime',executable:'llama-server.exe',unpackedBytes,
    requiredFiles:['llama-server.exe','llama-server-impl.dll','llama.dll','llama-common.dll','ggml.dll','ggml-base.dll','ggml-cpu-x64.dll','ggml-vulkan.dll','mtmd.dll','libomp.dll']},
});

export function publicVisionPackage(spec = VISION_PACKAGE) {
  const {id,name,model,quantization,downloadBytes,installedBytes,peakDiskBytes,requirements,links} = spec;
  return structuredClone({id,name,model,quantization,downloadBytes,installedBytes,peakDiskBytes,requirements,links});
}
