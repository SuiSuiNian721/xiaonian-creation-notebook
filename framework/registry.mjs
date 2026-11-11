const pathSetting = (key, label, pathKind, placeholder, help) => ({ key, label, type: 'path', pathKind, placeholder, help });
const urlSetting = (placeholder, help) => ({ key: 'serviceUrl', label: '服务地址', type: 'url', placeholder, help });
const planned = (id, label) => ({ id, label, status: 'planned' });
const comfyDiscovery = { name:'ComfyUI 本体' };
const comfySettings = [
  pathSetting('comfyPath', 'ComfyUI 目录', 'directory', 'E:\\ComfyUI', '填写 ComfyUI 本体目录，包含 main.py、server.py、nodes.py 和 comfy 文件夹。检测也支持便携包根目录。'),
  pathSetting('workflowPath', '工作流目录', 'directory', 'E:\\ComfyUI工作流', '扫描 JSON 工作流并导入副本，原文件保持不变。'),
  pathSetting('outputPath', 'ComfyUI 输出目录', 'directory', 'E:\\AI出图', '用于本机 ComfyUI 的启动参数。角色绘图的成品保存位置在绘图页单独设置。'),
  urlSetting('http://127.0.0.1:8188', '两个工作区共用此 ComfyUI 地址。保存后主动连接，保存本身不启动或连接服务。'),
];

// requirements / optionalIntegrations 表示计划接入的依赖，不代表已安装、已检测或已连接。
// 此处只声明接入契约；启用模块不会启动工具、模型或外部连接。
export const moduleDefinitions = [
  {
    id: 'cards', name: '角色卡', subtitle: '角色卡编辑与导出', usesCharacterContext: false,
    description: '新建与编辑人设、世界书和开场白，检查并导出角色卡。作品与聊天保存在工作台自己的目录。',
    category: 'create', icon: 'cards', accent: '#9e79d9', version: '0.2.0',
    requirements: ['内置角色卡编辑器'], optionalIntegrations: ['SillyTavern'],
    capabilities: [{id:'editor',label:'角色卡编辑器',status:'available'}, {id:'worldbook',label:'世界书管理',status:'available'},{id:'immersion',label:'沉浸创作',status:'available'}],
    settings: [],
  },
  {
    id: 'training', name: 'LoRA 训练', subtitle: '数据集处理与模型训练', usesCharacterContext: false,
    description: '连接 AI 一键规划、打标并训练，或全量调整训练参数并管理预设；默认保留整图与长宽比分桶。',
    category: 'create', icon: 'training', accent: '#d3a45f', version: '0.5.0',
    requirements: ['内置训练组件', '已有 Kohya Python/CUDA 环境'], optionalIntegrations: ['已有训练环境'], discovery:{name:'本机训练环境'},
    capabilities: [{id:'pipeline',label:'AI 一键处理与训练',status:'available'},{id:'strategies',label:'角色、画风与姿势专项策略',status:'available'},{id:'cropping',label:'可选局部裁切增强',status:'available'},{id:'tagging',label:'标签与自然语言自动标注',status:'available'},{id:'configuration',label:'原生全量参数与预设',status:'available'},{id:'training',label:'LoRA 任务与进度',status:'available'},{id:'automation',label:'MCP 自动训练接口',status:'available'}],
    settings: [
      pathSetting('trainerPath', '训练工具目录', 'directory', 'E:\\训练环境', '复用此安装的 Python/CUDA 环境；训练源码使用工作台按需安装的组件版本。'),
      pathSetting('outputPath', '训练产物目录', 'directory', 'E:\\训练产物', '训练输出的默认位置；一键流程可以另选目录，并为每次流程建立独立文件夹。'),
      pathSetting('pythonPath', '服务 Python（可选）', 'file', '自动查找已有 Python', '留空时从训练工具目录附近查找轻量服务 Python。训练依赖由独立 Kohya 环境提供。'),
    ],
  },
  {
    id: 'drawing', name: '角色绘图', subtitle: '工作流与图像生成',
    description: '制作和导入工作流，通过 MCP 接入外部 AI，编辑生成参数并保存角色作品。',
    category: 'create', icon: 'drawing', accent: '#d781a1', version: '0.2.0',
    requirements: ['ComfyUI'], optionalIntegrations: ['ComfyUI'], discovery:comfyDiscovery,
    capabilities: [{id:'workflows',label:'工作流管理',status:'available'}, {id:'generation',label:'图像生成',status:'available'}],
    settings: comfySettings,
  },
  {
    id: 'comfyui', name: 'ComfyUI 启动器', subtitle: '管理本机绘图环境', usesCharacterContext: false,
    description: '配置已有 ComfyUI 的设备、显存和性能参数，启动进程、查看日志，管理模型、插件和环境快照。',
    category: 'create', icon: 'comfyui', accent: '#80a8d9', version: '0.3.1',
    requirements: ['已有 ComfyUI', 'Python'], optionalIntegrations: [], discovery:comfyDiscovery,
    capabilities: [{id:'launcher',label:'启动与参数设置',status:'available'},{id:'maintenance',label:'环境维护',status:'available'}],
    settings: comfySettings,
  },
  {
    id: 'voice', name: '声音', familyId:'voice', subtitle: '音色生成、克隆与台词合成',
    description: '批量设计音色，选择生成结果或参考录音克隆新台词，与角色、陪伴和 QQ 共用音色库。',
    category: 'create', icon: 'voice', accent: '#80a8d9', version: '0.3.0',
    requirements: ['MOSS 克隆模型与声音运行环境'], optionalIntegrations: ['本地语音服务'],
    capabilities: [{id:'design',label:'音色生成',status:'available'},{id:'voices',label:'共享音色库',status:'available'},{id:'speech',label:'完整语音生成',status:'available'},{id:'voice-cloning',label:'参考录音克隆',status:'available'}],
    settings: [
      pathSetting('modelPath', '语音模型位置', 'either', 'E:\\Voice\\models', '可填写模型文件或模型目录；检查不会加载模型。'),
      pathSetting('outputPath', '音频目录', 'directory', 'E:\\Voice\\output', '后续音频产物的目录。'),
      pathSetting('pythonPath', 'MOSS Python', 'file', '选择已安装 MOSS 的 python.exe', '复用已有 Python 与模型环境。'),
      pathSetting('referencePath', '参考录音', 'file', '选择 WAV、FLAC、MP3 或 OGG', '参考录音复制到工作台后使用，原文件保持不变。'),
      pathSetting('clonePath', '克隆模型', 'directory', 'MOSS-TTS-Local-Transformer', '可直接在声音组件中下载。'),
      pathSetting('codecPath', '音频编解码器', 'directory', 'MOSS-Audio-Tokenizer', '生成与克隆共用一份。'),
      pathSetting('profilePath', '固定音色配置', 'file', '固定参考配置.json', '包含参考音频、哈希、克隆模型和参数。'),
      urlSetting('http://127.0.0.1:17866', '本机 MOSS 服务根地址。'),
    ],
  },
  {
    id:'voice-design',name:'声音',familyId:'voice',subtitle:'音色生成、克隆与台词合成',usesCharacterContext:true,
    description:'通过声音描述和试读台词从零创建音色，无需参考录音；试听保存后可用于角色、陪伴与 QQ。',
    category:'create',icon:'voice',accent:'#9e79d9',version:'0.3.0',
    requirements:['MOSS 声音生成模型与声音运行环境'],optionalIntegrations:[],
    capabilities:[{id:'design',label:'无参考音色生成',status:'available'},{id:'voices',label:'共享音色库',status:'available'},{id:'speech',label:'完整语音生成',status:'available'}],
    settings:[
      pathSetting('pythonPath','MOSS Python','file','检测已有环境或直接下载安装','两个声音模块共用运行环境。'),
      pathSetting('generatorPath','生成模型','directory','MOSS-VoiceGenerator','可直接在声音组件中下载。'),
      pathSetting('clonePath','克隆模型','directory','MOSS-TTS-Local-Transformer','用于固定保存后的音色。'),
      pathSetting('codecPath','音频编解码器','directory','MOSS-Audio-Tokenizer','生成与克隆共用一份。'),
    ],
  },
  {
    id: 'companion', name: '虚拟陪伴', familyId:'companion', variant:'full', subtitle: '角色模型、声音与聊天',
    description: '精简模式用于文字陪伴；完整模式支持角色模型、声音和桌面陪伴，可在模块内切换。',
    category: 'companion', icon: 'companion', accent: '#b98dcc', version: '0.3.0',
    requirements: ['陪伴运行组件'], optionalIntegrations: ['Live2D', 'VRM', '对话模型服务'], discovery:{name:'陪伴运行组件'},
    capabilities: [{id:'stage',label:'角色舞台',status:'available'},{id:'conversation',label:'陪伴对话',status:'available'},{id:'settings',label:'陪伴设置',status:'available'},{id:'immersion',label:'沉浸陪伴',status:'available'}],
    settings: [
      pathSetting('airiPath', '运行组件安装目录', 'directory', 'E:\\陪伴运行组件', '兼容现有 0.12.0-beta.5 运行组件；更改位置后重新打开工作台。'),
      pathSetting('modelPath', '角色模型文件', 'file', 'E:\\角色素材\\character.vrm', '只记录现有模型文件；当前不会加载或渲染模型。'),
      urlSetting('http://127.0.0.1:8000/v1', 'HTTP / HTTPS 模型服务地址；当前不会开始对话。'),
    ],
  },
  {
    id:'character-lite',name:'角色资料',familyId:'character-full',variant:'lite',librarySection:'characters',subtitle:'基本人设与共同记忆',
    description:'安装基本人设和记忆策略，与 QQ 和虚拟陪伴共用角色资料。',
    category:'companion',icon:'cards',accent:'#9e79d9',version:'1.0.0',
    requirements:['共享基本人设与记忆'],optionalIntegrations:['QQ 对话','虚拟陪伴'],
    capabilities:[{id:'persona',label:'基本人设',status:'available'},{id:'memory',label:'共同记忆',status:'available'}],settings:[],
  },
  {
    id:'character-full',name:'角色资料',familyId:'character-full',variant:'full',librarySection:'characters',subtitle:'连续状态与完整互动',
    description:'精简模式管理基本人设与记忆；完整模式加入状态、场景规则、脚本和工具，可在模块内切换。',
    category:'companion',icon:'cards',accent:'#b98dcc',version:'1.0.0',
    requirements:['共享基本人设与记忆','共享角色完整能力'],optionalIntegrations:['QQ 对话','虚拟陪伴'],
    capabilities:[{id:'life',label:'角色互动系统',status:'available'},{id:'runtime',label:'高级运行能力',status:'available'}],settings:[],
  },
  {
    id:'companion-lite',name:'虚拟陪伴',familyId:'companion',variant:'lite',subtitle:'文字聊天与会话记录',
    description:'安装本机文字陪伴资源，使用共用 AI、人设与记忆聊天，保留独立会话记录。',
    category:'companion',icon:'companion',accent:'#82b7c4',version:'1.0.0',
    requirements:['共享基本人设与记忆','精简陪伴文字策略'],optionalIntegrations:['对话模型服务'],
    capabilities:[{id:'conversation',label:'文字陪伴',status:'available'},{id:'history',label:'会话记录',status:'available'}],settings:[],
  },
  {
    id: 'qq', name: 'QQ 对话', subtitle: 'QQ 连接、角色与会话',
    description: '管理独立 QQ 的扫码登录、角色绑定、文字响应、会话记录与记忆。聊天在 QQ 中进行，语音与表情包后续接入。',
    category: 'companion', icon: 'qq', accent: '#82b7c4', version: '0.2.0', usesCharacterContext:false,
    requirements: ['OneBot 消息网关'], optionalIntegrations: ['OneBot'], discovery:{name:'NapCat QQ 独立运行端'},
    capabilities: [planned('connection', '消息桥接'), planned('rules', '会话与响应规则'), planned('voice', '语音消息'), planned('stickers', '表情包')],
    settings: [
      urlSetting('ws://127.0.0.1:3001', '支持 WS / WSS 或 HTTP / HTTPS；当前不会连接 QQ 或发送消息。'),
      { key: 'accountId', label: '账号标识', type: 'text', placeholder: '用于区分配置的账号标识', help: '仅保存标识；无需填写密码或访问令牌。' },
    ],
  },
  {
    id: 'mc-skin', name: 'MC 皮肤', subtitle: '皮肤制作、预览与导出',
    description: '根据角色参考或已有皮肤制作原生 64×64 皮肤，检查图层并预览和导出。',
    category: 'create', icon: 'mc-skin', accent: '#88aa70', version: '0.2.0',
    requirements: ['内置皮肤制作规则', 'Python / Pillow'], optionalIntegrations: ['Minecraft'], discovery:{name:'Python 解释器'},
    capabilities: [{id:'skin-editor',label:'AI 皮肤制作',status:'available'},{id:'skin-preview',label:'分层与立体预览',status:'available'},{id:'skin-export',label:'原生 PNG 导出',status:'available'}],
    settings: [
      pathSetting('workspacePath', '皮肤作品目录', 'directory', 'E:\\MC\\skins', '可选，保存新作品副本；未填写时保存在工作台数据目录。'),
      pathSetting('skinPath', '当前皮肤文件', 'file', 'E:\\MC\\skins\\character.png', '保存后可导入此原生 PNG；导入会检查尺寸、模型、Alpha 和 UV。'),
      pathSetting('pythonPath', 'Python 可执行文件', 'file', '自动查找本机 Python', '需要 Python 3.10+ 与 Pillow；留空自动检测，修改后点击检查环境。'),
    ],
  },
  {
    id: 'mc-play', name: 'MC 陪玩', subtitle: '世界连接与角色陪玩',
    description: '按需安装陪玩运行端后加入 Java 版世界，查看状态、跟随玩家并使用共用 AI 执行自然语言指令。',
    category: 'companion', icon: 'mc-play', accent: '#69aa91', version: '0.2.0',
    requirements: ['Minecraft Java 版世界', '按需安装陪玩运行端'], optionalIntegrations: ['共用 AI 连接'], discovery:{name:'Minecraft Java 版局域网世界'},
    capabilities: [{id:'connection',label:'世界连接',status:'available'},{id:'companion',label:'角色陪玩',status:'available'}],
    settings: [
      {key:'serverHost',label:'服务器地址',type:'text',placeholder:'127.0.0.1'},
      {key:'serverPort',label:'游戏端口',type:'text',placeholder:'25565'},
      {key:'gameVersion',label:'游戏版本',type:'text',placeholder:'自动识别'},
      {key:'authMode',label:'登录方式',type:'text',placeholder:'offline'},
      {key:'playerName',label:'机器人玩家名',type:'text',placeholder:'AiriCompanion'},
      {key:'ownerName',label:'你的游戏名',type:'text',placeholder:'Minecraft 玩家名'},
    ],
  },
];

function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
freeze(moduleDefinitions);

export function moduleDefinition(id) { return moduleDefinitions.find(module => module.id === id); }
export function defaultConfig(definition) { return Object.fromEntries(definition.settings.map(setting => [setting.key, ''])); }
