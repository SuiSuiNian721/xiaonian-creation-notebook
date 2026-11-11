import {textContent} from '../character-life-adapter.mjs';

/** Only a request in the current user message can select automatic shared speech. */
export function voiceRequested(input){
  const value=textContent(input).normalize('NFKC').replace(/```[\s\S]*?```|`[^`\n]*`|^[ \t]*>.*$/gm,' ')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"|'[^'\n]*'/g,' ').trim();
  if(!value)return false;
  if(/(?:不要|不用|不必|不需要|无需|别|停止|取消|关闭|暂不|不发|不再发|不想|不许)[^。！？!?，,;；\n]{0,12}(?:语音|声音|朗读|读出|读给|念出|念给)|(?:只|仅)(?:发|用|要|使用)?文字|(?:文字|打字)(?:回复)?(?:就好|就行)/.test(value))return false;
  if(/(?:如何|怎么|怎样|为什么|是否|什么时候)[^。！？!?，,;；\n]{0,14}(?:语音|声音|朗读)/.test(value))return false;
  if(/^(?:你[^。！？!?，,;；\n]{0,12}|现在)?(?:会|能|可以|支持)[^。！？!?，,;；\n]{0,16}(?:语音|朗读)(?:消息|功能)?(?:了)?(?:吗|么)?[?？]?$/.test(value)&&!/(?:给我|帮我|请|来一|回复我|回答我)/.test(value))return false;
  return /(?:发|发送|生成|回复|回|来|录)[^。！？!?，,;；\n]{0,8}语音|(?:用|以)[^。！？!?，,;；\n]{0,8}(?:语音|声音|音色)[^。！？!?，,;；\n]{0,8}(?:回复|回答|说|读|念|讲)|语音(?:回复|回答)(?:我|一下|吧|[。！？!?]|$)|(?:读|念)(?:出来|出|给我听)|朗读|(?:我想|想要|让我)听(?:听)?(?:你|你的声音)/.test(value);
}

export function sharedVoiceAllowed(settings,args={}){
  const media=settings.media;
  if(settings.enabled===false||!media?.voiceEnabled||!media.voiceId||media.voiceTool)return false;
  const input=args.latestInput??args.context?.latestInput??args.history?.findLast(message=>message.role==='user')?.content;
  return media.voiceMode==='always'||voiceRequested(input);
}

export function sharedVoiceGuidance(settings,args={}){
  const media=settings.media;
  if(settings.enabled===false||!media?.voiceEnabled||!media.voiceId||media.voiceTool)return '';
  return '工作台已配置共享音色，可把你的回复转换为真正的语音消息并发送。语音合成和发送由工作台完成，你只需正常写出要说的话；不要因模型输出是文字就误称无法发送语音，也不要在生成完成前声称已发送成功。\n'+
    (sharedVoiceAllowed(settings,args)?'本轮将使用语音发送回复。':'本轮只发送文字；当前设置仅在本轮用户明确要求语音时使用声音，询问是否具备能力不算发送请求。');
}
