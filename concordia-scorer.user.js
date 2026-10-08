// ==UserScript==
// @name         Concordia 实时计分 (BGA)
// @namespace    hanako.concordia-scorer
// @version      1.0.1
// @description  康考迪亚：常驻浮窗实时显示所有玩家「若此刻结束」的终局预估分（BGA）
// @author       浮沉 & hanako
// @homepageURL  https://github.com/Dark-Outlaws/concordia-scorer
// @supportURL   https://github.com/Dark-Outlaws/concordia-scorer/issues
// @updateURL    https://raw.githubusercontent.com/Dark-Outlaws/concordia-scorer/main/concordia-scorer.user.js
// @downloadURL  https://raw.githubusercontent.com/Dark-Outlaws/concordia-scorer/main/concordia-scorer.user.js
// @match        https://boardgamearena.com/*
// @match        https://*.boardgamearena.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 数据来源（都在 BGA 的 gameui.gamedatas 里）：
 *   players[id]                    金币、商品（会滞后，只当兜底）
 *   _playersUIData[id].game        手牌/弃牌、仓库、殖民者、nbCitiesByProductionType
 *   _cityList                      每座城：province、cityToken.productionType（产出）
 *   DOM  counter_coins_<id> 等     页面实时计数（金币/商品以此为准，见下）
 *
 * 三条踩过的坑：
 *   1) players 里的钱货会慢半拍，页面上的 counter_* 才是活账 —— 钱货一律读 DOM。
 *   2) 对手的 nbCitiesByProductionType 常是空的 —— 城市一律从 _cityList 自己数。
 *   3) 房屋归属在 location_arg（不是 player）。
 * 计分模型：每神一项分 = 底数(版图) × 手里该神卡的 vp 之和；卡自带 god/vp 字段。
 */

(function () {
  'use strict';

  // ============ 规则常量 ============

  const S = String;

  // 商品单价（官方规则）
  const PRICE = { brick: 3, food: 4, tool: 5, wine: 6, cloth: 7 };
  const GOODS = ['brick', 'food', 'tool', 'wine', 'cloth'];

  // 六神（按计分顺序）。idx = 该神在 Gods.png 里自上而下的序号。
  // Gods.png 整图 324×516，六条横幅各 324×86。
  const GODS = ['vesta', 'jupiter', 'saturnus', 'mercurius', 'mars', 'minerva'];
  const GOD = {
    vesta:     { en: 'VESTA',     zh: '维斯塔', color: '#8f6fb5', idx: 5, desc: '每 10 金币得 1 分（身家 = 金币 + 货物折价）' },
    jupiter:   { en: 'JUPITER',   zh: '朱庇特', color: '#4a86c0', idx: 1, desc: '每个非砖城市得 1 分' },
    saturnus:  { en: 'SATURNUS',  zh: '萨图恩', color: '#d0a93a', idx: 0, desc: '每个有你房屋的行省得 1 分' },
    mercurius: { en: 'MERCURIUS', zh: '墨丘利', color: '#9a7b56', idx: 2, desc: '每种你能生产的货物类型得 2 分' },
    mars:      { en: 'MARS',      zh: '玛尔斯', color: '#e08a3c', idx: 3, desc: '地图上每个殖民者得 2 分' },
    minerva:   { en: 'MINERVA',   zh: '密涅瓦', color: '#93b84a', idx: 4, desc: '特定生产类型的每个城市，按专家卡标注得分' }
  };
  const CONCORDIA = { en: 'CONCORDIA', zh: '协和卡', color: '#6b6b70', desc: '触发终局者独占的 7 分', flat: true };
  const META = k => GOD[k] || CONCORDIA; // 取神或协和卡的元信息

  // 专家卡 → 产出类型（Minerva 按此算对应城市）
  const MINERVA = { mason: 'brick', farmer: 'food', smith: 'tool', vintner: 'wine', weaver: 'cloth' };

  // Gods.png 切片参数（横幅渲染宽 112px，按原图比例取高与偏移）
  const BANNER = { imgW: 324, imgH: 516, bandH: 86, renderW: 112 };

  // HTML 转义（玩家名进 title/文本前过一道，防同名里的引号捣乱）
  const esc = s => S(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ============ 数据读取 ============

  // 取本局 gamedatas；不是康考迪亚则返回 null（脚本静默）
  function getGD() {
    const g = (window.gameui && window.gameui.gamedatas) || window.g_gamedatas;
    if (!g || !g._cityList || !g._playersUIData || !g.players) return null;
    return g;
  }

  // 页面上某玩家面板的实时计数器：{ coins, houseStock, brick, food, ... , vestaVP, ... }
  // 这是唯一不滞后的钱货来源
  function domCounters(id) {
    const board = document.getElementById('player_board_' + id);
    if (!board) return null;
    const out = {};
    board.querySelectorAll('[id^="counter_"]').forEach(el => {
      const m = el.id.match(/^counter_(.+)_(\d+)$/);
      if (m) out[m[1]] = Number((el.textContent || '').trim()) || 0;
    });
    return out;
  }

  // 玩家头像（缓存；找不到不缓存，等它渲染出来再取）
  const _avatars = {};
  function playerAvatar(id) {
    if (_avatars[id]) return _avatars[id];
    const el = document.getElementById('player_avatar_' + id) || document.getElementById('avatar_' + id);
    if (el) {
      const im = el.tagName === 'IMG' ? el : el.querySelector('img');
      if (im && im.src) return (_avatars[id] = im.src);
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m) return (_avatars[id] = m[1]);
      }
    }
    const wrap = document.querySelector('.player-name-wrapper img, .player_name img, [class*="avatar"] img');
    return wrap && wrap.src ? (_avatars[id] = wrap.src) : null;
  }

  // Gods.png 地址（从页面现读，构建号变了也跟得上；读不到才用内置那条）
  let _sprite = null;
  function spriteURL() {
    if (_sprite) return _sprite;
    const el = document.querySelector('.cardTable_Vesta') || document.querySelector('[class*="cardTable_"]');
    if (el) {
      const m = (getComputedStyle(el).backgroundImage || '').match(/url\(["']?(.*?)["']?\)/);
      if (m && m[1]) _sprite = m[1];
    }
    return (_sprite = _sprite ||
      'https://x.boardgamearena.net/data/themereleases/current/games/concordia/260611-1739/img/Gods.png');
  }

  // 从 Gods.png 切一条神横幅（左列用）
  function bannerHTML(g) {
    const meta = GOD[g];
    if (!meta) return '<span class="cd-ban-fb">' + esc(S(g).toUpperCase()) + '</span>';
    const s = BANNER.renderW / BANNER.imgW;
    const bgH = (BANNER.imgH * s).toFixed(1);
    const h = (BANNER.bandH * s).toFixed(1);
    const y = (meta.idx * BANNER.bandH * s).toFixed(1);
    return '<span class="cd-ban" style="background-image:url(\'' + spriteURL() + '\');' +
      'background-size:' + BANNER.renderW + 'px ' + bgH + 'px;background-position:0 -' + y + 'px;' +
      'width:' + BANNER.renderW + 'px;height:' + h + 'px"></span>';
  }

  // 房屋/殖民者的归属字段：可能是 player，也可能是 location_arg
  function owner(obj) {
    if (obj && typeof obj === 'object') return obj.player !== undefined ? obj.player : obj.location_arg;
    return obj;
  }

  // ============ 计分 ============

  function compute(g) {
    const uid = g._playersUIData || {};
    const cities = Object.values(g._cityList || {});
    const ps = g.players || {};
    const plist = Array.isArray(ps) ? ps : Object.values(ps);
    const gmOf = id => ((uid[S(id)] || {}).game) || {};

    // 某玩家全部手牌+弃牌（去重；卡自带 god / vp 字段）
    const deck = id => {
      const gm = gmOf(id), seen = {}, out = [];
      (gm.playerHand || []).concat(gm.discardPile || []).forEach(c => {
        if (c && !seen[c.id]) { seen[c.id] = 1; out.push(c); }
      });
      return out;
    };
    // 棋盘上的殖民者（storehouse 里的不算）
    const boardCols = id => Object.values(gmOf(id).colonists || {})
      .filter(c => c && typeof c.location === 'string' && !c.location.startsWith('playerBoard')).length;
    // 某玩家的城市：[{ good, province }]（good 取 cityToken.productionType）
    const citiesOf = id => cities.filter(city => {
      const hs = (city.elementsInCity && city.elementsInCity.houses) || [];
      return hs.some(h => S(owner(h)) === S(id));
    }).map(city => ({
      good: city.cityToken && city.cityToken.productionType,
      province: city.province && city.province.id
    }));

    return plist.map(p => {
      const id = p.id, gm = gmOf(id);
      const dc = domCounters(S(id)) || {};
      const coins = ('coins' in dc) ? dc.coins : (Number(p.coins) || 0);
      const gcount = k => (k in dc) ? dc[k] : (Number(p[k]) || 0); // 钱货优先读 DOM

      const myCities = citiesOf(id);
      const totalCities = myCities.length;
      const brickCities = myCities.filter(c => c.good === 'brick').length;
      const goodsTypes = new Set(myCities.map(c => c.good).filter(Boolean)).size;
      const provinces = new Set(myCities.map(c => c.province)).size;

      // 六神各自的底数（版图侧）
      const wealth = coins + GOODS.reduce((s, k) => s + gcount(k) * PRICE[k], 0);
      const base = {
        vesta: Math.floor(wealth / 10),
        jupiter: totalCities - brickCities,   // 非砖城
        saturnus: provinces,                  // 有房的行省
        mercurius: goodsTypes,                // 生产类型数
        mars: boardCols(id),                  // 棋盘殖民者
        minerva: 0                            // 下面按专家卡类型补
      };

      // 六神各自的乘数：手里该神卡的 vp 之和；Minerva 逐卡按对应城市算
      const vp = {}, cnt = {};
      GODS.forEach(k => { vp[k] = 0; cnt[k] = 0; });
      let minervaGood = null, minervaScore = 0;
      deck(id).forEach(c => {
        if (vp[c.god] !== undefined) { vp[c.god] += (c.vp || 0); cnt[c.god]++; }
        const good = c.god === 'minerva' ? MINERVA[c.cardType] : null;
        if (good) {
          if (minervaGood === null) minervaGood = good;
          minervaScore += (c.vp || 0) * myCities.filter(x => x.good === good).length;
        }
      });
      base.minerva = minervaGood ? myCities.filter(c => c.good === minervaGood).length : 0;

      const score = {
        vesta: vp.vesta * base.vesta,
        jupiter: vp.jupiter * base.jupiter,
        saturnus: vp.saturnus * base.saturnus,
        mercurius: vp.mercurius * base.mercurius,
        mars: vp.mars * base.mars,
        minerva: minervaScore,
        concordia: (gm.hasConcordiaCard ? 1 : 0) * 7
      };

      // 明细（卡/底/分）：能读到页面现成计数器就用它（活跃玩家那份），否则用自算
      const detail = {};
      GODS.forEach(gd => {
        detail[gd] = (gd + 'Cards') in dc
          ? { cards: dc[gd + 'Cards'], items: dc[gd + 'Items'], vp: dc[gd + 'VP'] }
          : { cards: cnt[gd], items: base[gd], vp: score[gd] };
      });

      return {
        id: S(id), name: p.name, color: p.color,
        no: Number(p.player_no) || 0,
        avatar: playerAvatar(S(id)),
        self: ('vestaVP' in dc),                 // 带明细计数器的，就是在看的那个
        total: Object.values(score).reduce((a, b) => a + b, 0),
        score, detail
      };
    });
  }

  // ============ 界面 ============

  let panel, bodyEl, legendEl, dragState = null, collapsed = false, lastHTML = '';

  const CSS = `
#cd-scorer-panel{position:fixed;top:70px;right:16px;z-index:99999;width:264px;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#1d1d1f;
  background:rgba(255,255,255,.72);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);
  border:1px solid rgba(0,0,0,.08);border-radius:16px;box-shadow:0 10px 34px rgba(0,0,0,.18);overflow:hidden;user-select:none}
#cd-scorer-panel .cd-head{display:flex;align-items:center;justify-content:space-between;padding:9px 13px;background:rgba(0,0,0,.03);cursor:move}
#cd-scorer-panel .cd-title{font-weight:600;font-size:12px;letter-spacing:.05em;color:#3a3a3c}
#cd-scorer-panel .cd-ctl{display:flex;align-items:center;gap:6px}
#cd-scorer-panel .cd-toggle{cursor:pointer;color:#8e8e93;font-weight:700;padding:0 3px;line-height:1}
#cd-scorer-panel .cd-info{cursor:pointer;color:#8e8e93;font-weight:700;padding:0 4px;line-height:1}
#cd-scorer-panel .cd-body{padding:3px 13px 11px;max-height:72vh;overflow:auto}
#cd-scorer-panel .cd-row{padding:9px 0;border-top:1px solid rgba(0,0,0,.055)}
#cd-scorer-panel .cd-row:first-child{border-top:0}
#cd-scorer-panel .cd-main{display:flex;align-items:center;gap:8px}
#cd-scorer-panel .cd-av{width:22px;height:22px;border-radius:50%;flex:none;background-size:cover;background-position:center;background-color:#c7c7cc}
#cd-scorer-panel .cd-av-fb{display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:700}
#cd-scorer-panel .cd-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
#cd-scorer-panel .cd-total{font-variant-numeric:tabular-nums;font-weight:700;font-size:20px;letter-spacing:-.02em}
#cd-scorer-panel .cd-lead .cd-total{color:#0a7d33}
#cd-scorer-panel .cd-det{margin-top:7px}
#cd-scorer-panel .cd-det-h,#cd-scorer-panel .cd-det-r{display:grid;grid-template-columns:112px 1fr 1fr 1fr;align-items:center;gap:2px}
#cd-scorer-panel .cd-det-h{font-size:10px;color:#a1a1a6;padding-bottom:1px}
#cd-scorer-panel .cd-det-r{font-size:11px;padding:1px 0;color:#5a5a5e}
#cd-scorer-panel .cd-num{text-align:center;font-variant-numeric:tabular-nums}
#cd-scorer-panel .cd-det-r .cd-vp{color:#1d1d1f;font-weight:600}
#cd-scorer-panel .cd-ban{display:inline-block;background-repeat:no-repeat;border-radius:4px}
#cd-scorer-panel .cd-ban-fb{display:inline-block;font-size:10px;font-weight:700;padding:2px 6px;border-radius:6px;background:rgba(0,0,0,.06);color:#5a5a5e}
#cd-scorer-panel .cd-legend{display:none;padding:8px 13px 11px;border-top:1px solid rgba(0,0,0,.055);max-height:60vh;overflow:auto}
#cd-scorer-panel .cd-legend.on{display:block}
#cd-scorer-panel .cd-leg{display:flex;gap:8px;font-size:11px;line-height:1.5;color:#5a5a5e;padding:2px 0}
#cd-scorer-panel .cd-leg i{font-style:normal;font-weight:700;flex:none;width:78px;font-size:10.5px;letter-spacing:.02em}
#cd-scorer-panel .cd-leg em{font-style:normal;color:#8e8e93}
`;

  // 建面板（一次）
  function ensurePanel() {
    if (panel) return;

    const style = document.createElement('style');
    style.id = 'cd-scorer-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    panel = document.createElement('div');
    panel.id = 'cd-scorer-panel';

    const head = document.createElement('div');
    head.className = 'cd-head';
    const title = document.createElement('span');
    title.className = 'cd-title';
    title.textContent = '康考迪亚 · 若此刻结束';

    const ctl = document.createElement('span');
    ctl.className = 'cd-ctl';
    const info = document.createElement('span');
    info.className = 'cd-info';
    info.textContent = 'ⓘ';
    const toggle = document.createElement('span');
    toggle.className = 'cd-toggle';
    toggle.textContent = '–';
    ctl.appendChild(info);
    ctl.appendChild(toggle);
    head.appendChild(title);
    head.appendChild(ctl);

    bodyEl = document.createElement('div');
    bodyEl.className = 'cd-body';

    // 图例：点 ⓘ 展开，列出每神的算法
    legendEl = document.createElement('div');
    legendEl.className = 'cd-legend';
    legendEl.innerHTML = GODS.concat(['concordia']).map(k => {
      const m = META(k);
      return '<div class="cd-leg"><i style="color:' + (m.color || '#1d1d1f') + '">' + m.en + '</i>' +
        '<span>' + m.desc + (m.flat ? '' : ' <em>× 该神的卡数</em>') + '</span></div>';
    }).join('');

    panel.appendChild(head);
    panel.appendChild(bodyEl);
    panel.appendChild(legendEl);
    document.body.appendChild(panel);

    info.onclick = () => {
      legendEl.classList.toggle('on');
      info.style.color = legendEl.classList.contains('on') ? '#1d1d1f' : '#8e8e93';
    };
    toggle.onclick = () => {
      collapsed = !collapsed;
      bodyEl.style.display = collapsed ? 'none' : '';
      legendEl.style.display = collapsed ? 'none' : '';
      toggle.textContent = collapsed ? '+' : '–';
    };

    // 拖动（标题栏空白处按下）
    head.addEventListener('mousedown', e => {
      if (e.target === toggle || e.target === info) return;
      dragState = { x: e.clientX, y: e.clientY, r: panel.getBoundingClientRect() };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragState) return;
      panel.style.left = (dragState.r.left + (e.clientX - dragState.x)) + 'px';
      panel.style.top = (dragState.r.top + (e.clientY - dragState.y)) + 'px';
      panel.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => { dragState = null; });
  }

  // 头像：有就用，外圈套玩家色；没有就用色底+首字母兜底
  function avatarHTML(r) {
    const ring = '0 0 0 2px #' + (r.color || 'c7c7cc');
    if (r.avatar) {
      return '<span class="cd-av" style="background-image:url(\'' + r.avatar + '\');box-shadow:' + ring + '"></span>';
    }
    return '<span class="cd-av cd-av-fb" style="background:#' + (r.color || 'c7c7cc') + ';box-shadow:' + ring + '">' +
      esc(r.name ? r.name[0].toUpperCase() : '') + '</span>';
  }

  // 一个玩家一块：头像+名字+总分，下面六神明细（横幅 · 卡 · 底 · 分）
  function rowHTML(r, lead) {
    const head = '<div class="cd-main">' + avatarHTML(r) +
      '<span class="cd-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span>' +
      '<span class="cd-total">' + r.total + '</span></div>';

    const rows = GODS.map(gd => {
      const d = r.detail[gd], m = GOD[gd];
      return '<div class="cd-det-r" title="' + m.zh + ' · ' + m.desc + '">' +
        bannerHTML(gd) +
        '<span class="cd-num">' + d.cards + '</span>' +
        '<span class="cd-num">' + d.items + '</span>' +
        '<span class="cd-num cd-vp">' + d.vp + '</span></div>';
    }).join('');

    const con = r.score.concordia
      ? '<div class="cd-det-r"><span class="cd-ban-fb">CONCORDIA</span>' +
        '<span class="cd-num"></span><span class="cd-num"></span>' +
        '<span class="cd-num cd-vp">' + r.score.concordia + '</span></div>'
      : '';

    const sub = '<div class="cd-det"><div class="cd-det-h">' +
      '<span></span><span class="cd-num">卡</span><span class="cd-num">底</span><span class="cd-num">分</span></div>' +
      rows + con + '</div>';

    return '<div class="cd-row' + (lead ? ' cd-lead' : '') + '">' + head + sub + '</div>';
  }

  function render() {
    const g = getGD();
    if (!g) return;
    ensurePanel();

    // 固定顺序：在看的那个置顶，其余按座位号；分数只影响领先高亮，不换位
    const rows = compute(g).sort((a, b) => (b.self ? 1 : 0) - (a.self ? 1 : 0) || (a.no - b.no));
    const max = Math.max.apply(null, rows.map(r => r.total).concat([-1]));
    const html = rows.map(r => rowHTML(r, r.total === max)).join('');

    if (html === lastHTML) return;   // 没变化就不重画
    lastHTML = html;
    bodyEl.innerHTML = html;
  }

  setInterval(render, 600);
})();
