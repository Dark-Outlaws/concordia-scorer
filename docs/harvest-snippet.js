// 康考迪亚数据探针 (harvest-snippet)
// 用法：BGA 康考迪亚对局/观战/回放页 → F12 控制台 → 粘贴全文 → 回车
// 作用：打印 gamedatas 顶层键、每个玩家的字段、疑似计分字段；下载完整 gamedatas 为 concordia-gamedatas.json
//      完整数据同时存于 window.__cd_dump
// 参考阿纳克 docs/harvest-snippet.js 的思路：不猜结构，让页面自己招供。

(function () {
  const g = (window.gameui && window.gameui.gamedatas) || window.g_gamedatas;
  if (!g) { console.warn('[CD探针] 没找到 gamedatas，确认你正开在康考迪亚的对局/观战/回放页'); return; }
  const keys = (o) => (o && typeof o === 'object') ? Object.keys(o) : String(o);

  console.log('%c[CD探针] gamedatas 顶层键:', 'color:#0a0;font-weight:bold', keys(g));

  const ps = g.players || {};
  const plist = Array.isArray(ps) ? ps : Object.values(ps);
  plist.forEach((p, i) => {
    console.log(`[CD探针] 玩家${i} (id=${p.id ?? p.player_id ?? '?'}) 字段:`, keys(p));
  });

  const probes = ['cards','card','personality','personalities','hand','deck','discard',
    'city','cities','town','board','map','province','provinces','region','regions',
    'good','goods','resource','resources','house','houses','colonist','colonists',
    'market','display'];
  const found = {};
  probes.forEach(k => {
    if (k in g) found[k] = Array.isArray(g[k]) ? `array[${g[k].length}]` : typeof g[k];
    plist.forEach((p, i) => {
      if (k in p) found[`player${i}.${k}`] = Array.isArray(p[k]) ? `array[${p[k].length}]` : typeof p[k];
    });
  });
  console.log('%c[CD探针] 疑似计分字段:', 'color:#0a0;font-weight:bold', found);

  try {
    const json = JSON.stringify(g, (k, v) => typeof v === 'function' ? '[fn]' : v);
    window.__cd_dump = json;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = 'concordia-gamedatas.json';
    a.click();
    console.log('%c[CD探针] 完整数据已下载 concordia-gamedatas.json，长度 ' + json.length + '，也存于 window.__cd_dump', 'color:#0a0;font-weight:bold');
  } catch (e) {
    console.warn('[CD探针] 全量导出失败（可能有循环引用）:', e);
  }
})();
