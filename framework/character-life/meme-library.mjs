import { readFileSync } from 'node:fs';

const metadata = JSON.parse(readFileSync(new URL('../../resources/media/nekowhale.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../resources/media/nekowhale-manifest.json', import.meta.url), 'utf8'));
const terms = value => [...new Set(String(value ?? '').toLocaleLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]{1,2}/gu) ?? [])];

/** 仅使用随码固定目录；模型给出的标识永远不能成为任意 URL。 */
export class MemeLibrary {
  constructor({ clock = Date.now, cooldownMs = 120000 } = {}) {
    this.clock = clock; this.cooldownMs = cooldownMs; this.sent = new Map();
    const byId = new Map(manifest.items.map(item => [item.id, item]));
    this.items = metadata.stickers.flatMap(item => {
      const asset = byId.get(item.id); if (!asset) return [];
      return [{ ...item, name: asset.name || asset.stem, url: `https://kiriyuki.com${manifest.gif_base}/${encodeURIComponent(asset.pack)}/${encodeURIComponent(asset.file)}?h=${asset.hash}` }];
    });
    this.byId = new Map(this.items.map(item => [item.id, item]));
  }
  catalog() { return { count: this.items.length, packs: metadata.packs.map(pack=>({...pack,count:this.items.filter(item=>item.id.startsWith(pack.key+'/')).length})), attribution: metadata.attribution,
    license: 'CC BY-NC 4.0（知识目录）；GIF 保留原作者非商用条款', licensePath: 'resources/media/LICENSE-ASSETS', source: { repository: 'Loping151/dsh-nekowhale-stickers', revision: 'b7b58c0ff347d639fabe87d90d6716c4b3cad185', site: 'https://kiriyuki.com' } }; }
  resolve(ref) { const item = this.byId.get(ref); return item ? { type: 'image', memeId: item.id, name: item.name, url: item.url } : null; }
  coolingDown(scope, id) { return this.clock() - (this.sent.get(scope + '\0' + id) ?? -Infinity) < this.cooldownMs; }
  candidates(query, { limit = 6, scope = '' } = {}) {
    const keywords = terms(query), now = this.clock();
    return this.items.filter(item => now - (this.sent.get(scope + '\0' + item.id) ?? -Infinity) >= this.cooldownMs).map(item => {
      const searchable = [item.name, item.emotion, ...(item.tags ?? []), item.use, item.desc].join(' ').toLocaleLowerCase();
      const score = keywords.reduce((total, term) => total + (searchable.includes(term) ? 1 : 0), 0);
      return { item, score };
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).slice(0, Math.max(0, Math.min(limit, 8)))
      .map(({ item }) => ({ id: item.id, name: item.name, emotion: item.emotion, tags: (item.tags ?? []).slice(0, 5) }));
  }
  confirm(scope, actions) {
    for (const [key, at] of this.sent) if (this.clock() - at >= this.cooldownMs) this.sent.delete(key);
    for (const action of actions) if (this.byId.has(action.memeId) || action.memeId?.startsWith('custom:')) this.sent.set(scope + '\0' + action.memeId, this.clock());
    while (this.sent.size > 2000) this.sent.delete(this.sent.keys().next().value);
  }
}
