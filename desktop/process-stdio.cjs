const guarded = new WeakSet();

function installStdioGuards() {
  for (const stream of [process.stdout, process.stderr]) {
    if (guarded.has(stream)) continue;
    guarded.add(stream);
    stream.on('error', error => {
      // 临时启动终端可以先于桌面程序退出；断管不能中断草稿保存或服务收尾。
      if (error.code !== 'EPIPE') throw error;
    });
  }
}

module.exports = { installStdioGuards };
