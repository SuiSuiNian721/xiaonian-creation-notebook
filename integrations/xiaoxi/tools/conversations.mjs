import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertWorkspacePath } from './card.mjs';

const MAIN = { id: 'main', title: '原有对话', module: '', createdAt: '' };

export function createConversationStore(root) {
  const file = path.join(root, 'work', 'conversations.json');

  function read() {
    assertWorkspacePath(root, file);
    if (!fs.existsSync(file)) return { version: 1, cards: Object.create(null) };
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file))); }
    catch { throw new Error('对话索引不是有效的 UTF-8 JSON，原文件已保留'); }
    if (!data || data.version !== 1 || !data.cards || typeof data.cards !== 'object' || Array.isArray(data.cards)) throw new Error('对话索引格式不正确');
    data.cards = Object.assign(Object.create(null), data.cards);
    return data;
  }

  function write(data) {
    assertWorkspacePath(root, file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  function cardState(data, cardName) {
    const saved = data.cards[cardName];
    if (saved !== undefined && (!saved || typeof saved !== 'object' || Array.isArray(saved) || !Array.isArray(saved.conversations))) {
      throw new Error('对话索引中的卡片记录无效，原文件已保留');
    }
    const items = Array.isArray(saved?.conversations) ? saved.conversations : [];
    if (items.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim())) {
      throw new Error('对话索引中的对话身份无效，原文件已保留');
    }
    const main = items.find((item) => item?.id === 'main');
    const conversations = [{ ...MAIN, ...main, id: 'main', module: '' }, ...items.filter((item) => item?.id && item.id !== 'main')];
    if (new Set(items.map((item) => item?.id)).size !== items.length
      || conversations.some((item) => typeof item.id !== 'string' || typeof item.title !== 'string'
        || typeof item.module !== 'string' || (item.archivedAt !== undefined && typeof item.archivedAt !== 'string'))) {
      throw new Error('对话索引中的对话身份或名称无效，原文件已保留');
    }
    const available = conversations.filter((item) => !item.archivedAt);
    if (!available.length) throw new Error('对话索引中没有可用对话，原文件已保留');
    const activeId = available.some((item) => item.id === saved?.activeId) ? saved.activeId : available[0].id;
    return { activeId, conversations };
  }

  function publicState(state, { includeArchived = false } = {}) {
    return { activeId: state.activeId, conversations: state.conversations.filter((item) => includeArchived || !item.archivedAt),
      archivedCount: state.conversations.filter((item) => item.archivedAt).length };
  }

  function saveCardState(data, cardName, state) {
    // 原有对话也以普通条目保存，旧索引没有 main 时继续补上默认条目。
    data.cards[cardName] = { ...data.cards[cardName], activeId: state.activeId, conversations: state.conversations };
  }

  function newConversation({ title = '', module = '', origin } = {}) {
    const now = new Date();
    const fallbackTitle = (module ? module.split('/').at(-1).replace(/-打包$/, '-生成成品') : '新对话') + ' · ' + now.toLocaleString('zh-CN');
    const item = { id: randomUUID(), title: String(title).trim().slice(0, 80) || fallbackTitle, module: String(module), createdAt: now.toISOString() };
    if (origin) item.origin = { ...origin, createdAt: item.createdAt };
    return item;
  }

  function targetConversation(state, id) {
    const item = state.conversations.find((conversation) => conversation.id === id);
    if (!item) throw Object.assign(new Error('对话不存在'), { statusCode: 409 });
    return item;
  }

  function prepareCreate(cardName, { title = '', module = '', activate = true, origin } = {}) {
    const data = read();
    const current = cardState(data, cardName);
    const item = newConversation({ title, module, origin });
    saveCardState(data, cardName, { activeId: activate ? item.id : current.activeId, conversations: [...current.conversations, item] });
    return { file, data, item, state: publicState(cardState(data, cardName)) };
  }

  return {
    list(cardName, options = {}) { return publicState(cardState(read(), cardName), options); },
    get(cardName, id) {
      return targetConversation(cardState(read(), cardName), id);
    },
    prepareCreate,
    create(cardName, options = {}) {
      const prepared = prepareCreate(cardName, options);
      write(prepared.data);
      return prepared.state;
    },
    select(cardName, id) {
      const data = read();
      const current = cardState(data, cardName);
      if (targetConversation(current, id).archivedAt) throw Object.assign(new Error('这段对话已归档，请先恢复再打开'), { statusCode: 409 });
      saveCardState(data, cardName, { ...current, activeId: id });
      write(data);
      return publicState(cardState(data, cardName));
    },
    rename(cardName, id, title, expectedTitle) {
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 80) throw new Error('对话名称需要 1 到 80 个字符');
      const data = read();
      const current = cardState(data, cardName);
      const item = targetConversation(current, id);
      if (expectedTitle !== undefined && item.title !== expectedTitle) throw Object.assign(new Error('对话名称已变化，请刷新后重试'), { statusCode: 409 });
      const nextTitle = title.trim();
      if (item.title === nextTitle) return publicState(current);
      item.title = nextTitle;
      saveCardState(data, cardName, current);
      write(data);
      return publicState(cardState(data, cardName));
    },
    setArchived(cardName, id, archived, expectedArchivedAt) {
      const data = read();
      const current = cardState(data, cardName);
      const item = targetConversation(current, id);
      if (expectedArchivedAt !== undefined && (item.archivedAt || '') !== expectedArchivedAt) {
        throw Object.assign(new Error('对话归档状态已变化，请刷新后重试'), { statusCode: 409 });
      }
      if (!!item.archivedAt === archived) return publicState(current);
      item.archivedAt = archived ? new Date().toISOString() : '';
      if (archived && current.activeId === id) {
        let replacement = current.conversations.find((conversation) => !conversation.archivedAt);
        if (!replacement) {
          replacement = newConversation();
          current.conversations.push(replacement);
        }
        current.activeId = replacement.id;
      }
      saveCardState(data, cardName, current);
      write(data);
      return publicState(cardState(data, cardName));
    },
  };
}
