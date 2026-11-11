// 新 UI 使用独立入口、profile 和单实例锁，旧版可继续运行。
process.env.AI_FUTURE_VARIANT = 'aurora';
require('./main.cjs');
