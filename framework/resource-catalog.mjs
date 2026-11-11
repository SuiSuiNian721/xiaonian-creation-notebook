import { qqResourceCatalog } from './qq-runtime.mjs';
import { characterResourceCatalog } from './character-packages.mjs';
// 这里只声明待细化的前置，不能把模块的展示用 requirements 当作安装清单。
// 接入真实安装器时再补齐经过核实的版本、来源、体积及 adapterId。
const prerequisites = {
  drawing: 'ComfyUI 本体',
};

export const resourceCatalog = Object.freeze({ qq:qqResourceCatalog, cards:Object.freeze({revision:'bundled-xiaoxi-0.1.29',resources:Object.freeze([])}), training:Object.freeze({revision:'bundled-next-trainer-3.3.1-dev',resources:Object.freeze([])}), comfyui:Object.freeze({revision:'shared-comfyui-environment-v1',resources:Object.freeze([])}), 'mc-skin':Object.freeze({revision:'bundled-minecraft-pixel-skin-0.2.1',resources:Object.freeze([])}), ...Object.fromEntries(Object.entries(prerequisites).map(([moduleId, name]) => [moduleId, Object.freeze({
  revision: 'pending-v1',
  resources: Object.freeze([Object.freeze({
    id: `${moduleId}-prerequisite`, name, version: null, required: true,
    status: 'pending', sourceLabel: '待接入', downloadBytes: null, installedBytes: null,
    reason: '安装包尚未接入，版本、来源和体积待确定。',
  })]),
})])), voice:Object.freeze({revision:'bundled-voice-studio-0.3.0',resources:Object.freeze([])}),'voice-design':Object.freeze({revision:'bundled-voice-studio-0.3.0',resources:Object.freeze([])}), ...characterResourceCatalog, 'mc-play':Object.freeze({revision:'bundled-airi-minecraft-0.15.1',resources:Object.freeze([])}) });
