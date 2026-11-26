/* 题单 / 冲刺包
   - 列表：公开题单 + 我建的题单，显示完成进度
   - 详情：逐题列出并可跳转，创建者可增删题目
   - 新建：填标题/说明，可从当前题目或错题本一键填充 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  function progressBar(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return '<span style="display:inline-flex;align-items:center;gap:8px">'
      + '<span style="width:90px;height:6px;border-radius:4px;background:var(--surface-2,#f2f4f7);overflow:hidden">'
      + '<span style="display:block;height:100%;width:' + pct + '%;background:var(--blue,#2f6fed)"></span></span>'
      + '<span class="small muted">' + done + '/' + total + '</span></span>';
  }

  function createDialog(onDone) {
    const body = document.createElement('div');
    body.innerHTML = '<div class="field"><label>题单名称</label><input class="control" id="colTitle" maxlength="60" placeholder="例如：期中急救 · 定积分" /></div>'
      + '<div class="field"><label>说明（可选）</label><input class="control" id="colDesc" maxlength="300" placeholder="这个题单覆盖哪些考点" /></div>'
      + '<div class="small muted">普通账号创建的题单只有自己可见；官方公开题单由管理员创建。</div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">'
      + '<button class="btn" id="colCancel">取消</button>'
      + '<button class="btn btn-primary" id="colOk">创建</button></div>';

    const m = window.UI.modal({ title: '新建题单', sub: '建好后可以在题目页一键加入', body: body });
    body.querySelector('#colCancel').addEventListener('click', function () { m.close(); });
    body.querySelector('#colOk').addEventListener('click', function () {
      const title = body.querySelector('#colTitle').value.trim();
      if (!title) { window.UI.toast('先给题单起个名字', 'err'); return; }
      window.API.post('/api/collections', {
        title: title,
        description: body.querySelector('#colDesc').value.trim()
      }).then(function (r) {
        window.UI.toast('已创建', 'ok');
        m.close();
        if (onDone) onDone(r);
      }).catch(function (e) {
        window.UI.toast(window.API.describe ? window.API.describe(e) : '创建失败', 'err');
      });
    });
  }

  Views.collections = function (el) {
    const me = St.me;
    el.innerHTML = '<div class="page-head"><div><h1>题单 / 冲刺包</h1>'
      + '<p class="sub">把 6260 道题组织成「期中急救」「考研数一」「竞赛初赛」这样的专题包，进度自动统计。</p></div>'
      + '<div class="head-actions">' + (me ? '<button class="btn btn-primary" id="colNew">新建题单</button>' : '') + '</div></div>'
      + '<div id="colList" class="loading-row"><span class="spinner"></span>加载题单…</div>';

    if (me) {
      const btn = el.querySelector('#colNew');
      if (btn) btn.addEventListener('click', function () { createDialog(function () { Views.collections(el); }); });
    }

    window.API.get('/api/collections').then(function (d) {
      const box = el.querySelector('#colList');
      const list = d.collections || [];
      if (!list.length) {
        box.innerHTML = window.UI.empty('还没有题单', me ? '点右上角「新建题单」，把常错的题收进来。' : '登录后可以创建自己的题单。');
        return;
      }
      box.innerHTML = '<div class="grid-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">'
        + list.map(function (c) {
          return '<a class="card" href="#/collections/' + c.id + '" style="padding:14px 16px;display:block">'
            + '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">'
            + '<b style="font-size:15px">' + window.Md.esc(c.title) + '</b>'
            + '<span class="tag">' + (c.isPublic ? '公开' : (c.mine ? '我的' : '私有')) + '</span></div>'
            + '<div class="small muted" style="margin:6px 0 10px;min-height:18px">' + window.Md.esc(c.description || '—') + '</div>'
            + '<div style="display:flex;justify-content:space-between;align-items:center">'
            + '<span class="small muted">' + c.count + ' 题' + (c.ownerName ? ' · ' + window.Md.esc(c.ownerName) : '') + '</span>'
            + '<span class="small muted">查看 →</span></div></a>';
        }).join('') + '</div>';
    }).catch(function (e) {
      const notReady = e && e.status === 404;
      el.querySelector('#colList').innerHTML = window.UI.empty(
        notReady ? '后端还没升级到 v2.0' : '题单加载失败',
        notReady ? '题单功能需要 v2.0 后端（/api/collections）。部署新版本后刷新即可。'
          : (window.API.describe ? window.API.describe(e) : '稍后再试。')
      );
    });
  };

  Views.collection = function (el, params) {
    const id = params.id;
    if (!id) { location.hash = '#/collections'; return; }
    el.innerHTML = '<div class="loading-row"><span class="spinner"></span>加载题单…</div>';

    function load() {
      window.API.get('/api/collections/' + encodeURIComponent(id)).then(function (d) {
        el.innerHTML = '<div class="page-head"><div><h1>' + window.Md.esc(d.title) + '</h1>'
          + '<p class="sub">' + window.Md.esc(d.description || '') + '</p></div>'
          + '<div class="head-actions">' + progressBar(d.solvedCount, d.totalCount)
          + '<a class="btn" href="#/collections">全部题单</a></div></div>'
          + (d.items.length
            ? '<div class="card" style="padding:8px 12px">' + d.items.map(function (it) {
              return '<div class="related-item" data-code="' + it.code + '" style="display:flex;align-items:center;gap:10px;padding:8px 4px">'
                + '<span style="width:18px;text-align:center">' + (it.solved ? '✓' : '') + '</span>'
                + '<a class="code" href="#/problem/' + it.code + '">' + it.code + '</a>'
                + '<a class="t" style="flex:1" href="#/problem/' + it.code + '">' + window.Md.inlineTex(it.title) + '</a>'
                + '<span class="tag">' + window.Md.esc(it.mainTag || '') + '</span>'
                + '<span class="tag">难度 ' + it.difficulty + '</span>'
                + (d.mine ? '<button class="chip" data-remove="' + it.code + '">移出</button>' : '')
                + '</div>';
            }).join('') + '</div>'
            : window.UI.empty('题单还是空的', d.mine ? '在题目页点「加入题单」就能收题。' : '创建者还没收题。'));

        if (d.mine) {
          el.querySelectorAll('[data-remove]').forEach(function (btn) {
            btn.addEventListener('click', function (ev) {
              ev.preventDefault();
              const code = btn.getAttribute('data-remove');
              window.API.request('/api/collections/' + encodeURIComponent(id) + '/items', {
                method: 'PATCH', body: { remove: [code] }
              }).then(function () { load(); })
                .catch(function (e) { window.UI.toast(window.API.describe ? window.API.describe(e) : '操作失败', 'err'); });
            });
          });
        }
      }).catch(function (e) {
        el.innerHTML = '<div class="page-head"><div><h1>题单</h1></div></div>'
          + window.UI.empty('打不开这个题单', window.API.describe ? window.API.describe(e) : '可能已被删除，或没有权限。');
      });
    }
    load();
  };
})();
