/* 答疑区：列表 + 帖子详情 */
(function () {
  'use strict';

  const Views = window.Views = window.Views || {};
  const St = window.API.State;

  /* ---------------------------------------------------------- 发帖 */

  /* 客户端压缩图片：长边压到 1400px、jpeg 0.82，避免手机原图把请求体撑爆 */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const img = new Image();
        img.onload = function () {
          const max = 1400;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(img.width * scale);
          cv.height = Math.round(img.height * scale);
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          resolve(cv.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = function () { reject(new Error('图片读取失败')); };
        img.src = reader.result;
      };
      reader.onerror = function () { reject(new Error('图片读取失败')); };
      reader.readAsDataURL(file);
    });
  }

  function newPostModal() {
    if (!window.UI.requireLogin(null, '登录后才能发帖')) return;

    const el = document.createElement('div');
    el.innerHTML =
      '<form id="postForm">'
      + '<div class="field"><label>标题</label>'
      + '<div style="display:flex;gap:8px">'
      + '<input name="title" maxlength="100" placeholder="一句话说清楚卡在哪，例如：这一步为什么能用等价无穷小？" style="flex:1" />'
      + '<button type="button" class="btn btn-sm" id="aiTitle" title="让 AI 读正文后自动起标题">AI 起标题</button>'
      + '</div>'
      + '<div class="tip">正文写好后点「AI 起标题」，会根据内容自动补一版，可再改。</div></div>'
      + '<div class="field"><label>正文</label><textarea name="body" rows="7" placeholder="写出你的思路和卡点。公式用 $...$ 包住，独立公式用 $$...$$。"></textarea>'
      + '<div class="tip">正文越具体，AI 助教和同学越能直接帮到你。</div></div>'
      + '<div class="field"><label>图片（最多 3 张，可选）</label>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<label class="btn btn-sm" style="cursor:pointer">选择图片<input type="file" id="postImgs" accept="image/*" multiple style="display:none" /></label>'
      + '<span class="small muted">手写过程拍照上传更快，会自动压缩</span></div>'
      + '<div id="imgPreview" class="post-img-preview"></div></div>'
      + '<div class="field-row">'
      + '<div class="field"><label>关联题目编号（可选）</label><input name="problemCode" placeholder="例如 HS1001" /></div>'
      + '<div class="field"><label>标签（逗号分隔）</label><input name="tags" placeholder="极限, 泰勒展开" /></div>'
      + '</div>'
      + '<div class="form-error" id="postErr"></div>'
      + '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px">'
      + '<button type="button" class="btn" id="cancelPost">取消</button>'
      + '<button type="submit" class="btn btn-primary" id="submitPost">发布</button>'
      + '</div></form>';

    const m = window.UI.modal({ title: '发一个新帖', sub: '发帖后 AI 助教会先给一版思路；帖子里 @AI助教 可以再追问', body: el, wide: true });
    if (window.MathKey) window.MathKey.attachAll(el);
    const form = el.querySelector('#postForm');
    const picked = [];   // 已选图片的 dataURL

    function renderPicked() {
      const box = el.querySelector('#imgPreview');
      if (!box) return;
      box.innerHTML = picked.map(function (src, i) {
        return '<span class="post-img-thumb"><img src="' + src + '" alt="待上传" />'
          + '<button type="button" class="rm" data-i="' + i + '" title="移除">×</button></span>';
      }).join('');
      box.querySelectorAll('.rm').forEach(function (b) {
        b.addEventListener('click', function () {
          picked.splice(Number(b.getAttribute('data-i')), 1);
          renderPicked();
        });
      });
    }

    el.querySelector('#postImgs').addEventListener('change', async function (e) {
      const files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      for (const f of files) {
        if (picked.length >= 3) { window.UI.toast('最多 3 张图', 'err'); break; }
        try { picked.push(await compressImage(f)); } catch (err) { window.UI.toast(err.message, 'err'); }
      }
      renderPicked();
    });

    const aiTitleBtn = el.querySelector('#aiTitle');
    if (aiTitleBtn) {
      aiTitleBtn.addEventListener('click', async function () {
        const bodyText = (form.body.value || '').trim();
        if (bodyText.length < 10) { window.UI.toast('先写几句正文，AI 才有内容可读', 'err'); return; }
        aiTitleBtn.disabled = true;
        aiTitleBtn.textContent = '生成中…';
        try {
          const r = await window.API.post('/api/forum/suggest-title', { body: bodyText, llm: window.UI.llmConfig() });
          if (r.title) { form.title.value = r.title; window.UI.toast('已填入标题，可再修改', 'ok'); }
        } catch (e) {
          window.UI.toast(e.message, 'err');
        } finally {
          aiTitleBtn.disabled = false;
          aiTitleBtn.textContent = 'AI 起标题';
        }
      });
    }
    const err = el.querySelector('#postErr');
    el.querySelector('#cancelPost').addEventListener('click', m.close);

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const btn = el.querySelector('#submitPost');
      const title = form.title.value.trim();
      const body = form.body.value.trim();
      if (title.length < 4) { err.textContent = '标题至少 4 个字'; return; }
      if (body.length < 10 && !picked.length) { err.textContent = '正文至少 10 个字（或者传张图）'; return; }
      btn.disabled = true;
      btn.textContent = '发布中…';
      try {
        const res = await window.API.post('/api/forum', {
          title: title, body: body,
          problemCode: form.problemCode.value.trim(),
          tags: form.tags.value,
          images: picked
        });
        m.close();
        window.UI.toast('已发布，AI 助教正在看你的问题', 'ok');
        location.hash = '#/forum/' + res.id;
      } catch (err2) {
        err.textContent = err2.message;
        btn.disabled = false;
        btn.textContent = '发布';
      }
    });

    setTimeout(function () { form.title.focus(); }, 60);
  }

  /* ---------------------------------------------------------- 列表 */

  Views.forum = function (el, params) {
    const page = Math.max(1, Number(params.page || 1));
    const q = params.q || '';
    el.innerHTML = '<div class="loading-row"><span class="spinner"></span>正在加载答疑区…</div>';

    const query = '/api/forum?page=' + page + (q ? '&q=' + encodeURIComponent(q) : '');

    window.API.get(query).then(function (data) {
      el.innerHTML =
        '<div class="page-head"><div><h1>答疑区</h1>'
        + '<p class="sub">卡住的地方贴出来。发帖后 AI 助教会先回一版思路，同学也可以接着讨论。所有人看到的是同一份内容。</p></div>'
        + '<div class="head-actions">'
        + '<div class="search-box" style="max-width:220px">' + window.UI.icon('search')
        + '<input id="forumSearch" placeholder="搜索帖子" value="' + window.Md.esc(q) + '" /></div>'
        + '<button class="btn btn-primary" id="newPostBtn">' + window.UI.icon('plus') + ' 发帖提问</button>'
        + '</div></div>'

        + '<div class="forum-layout">'
        + '<div><div class="post-list" id="postList">'
        + (data.items.length
          ? data.items.map(function (p) {
            return '<div class="post-row">'
              + '<div class="post-avatar">' + window.UI.avatar(p.authorName) + '</div>'
              + '<div class="post-body-main">'
              + '<a class="post-title" href="#/forum/' + p.id + '">' + window.Md.inlineTex(p.title)
              + (p.solved ? '<span class="badge-solved">已解决</span>' : '') + '</a>'
              + '<div class="tags" style="margin-top:6px">'
              + (p.problemCode ? '<span class="tag teal">' + p.problemCode + '</span>' : '')
              + (p.tags || []).map(function (t) { return '<span class="tag gray">' + window.Md.esc(t) + '</span>'; }).join('')
              + '</div>'
              + '<div class="post-sub"><span>' + window.Md.esc(p.authorName) + '</span>'
              + '<span>' + window.UI.timeAgo(p.createdAt) + '</span>'
              + '<span>' + p.replyCount + ' 条回复</span></div>'
              + '</div>'
              + '<div class="post-replies"><b>' + p.replyCount + '</b><span>回复</span></div>'
              + '</div>';
          }).join('')
          : '<div class="empty" style="border:0"><b>还没有人提问</b>第一个问题往往也是大家的问题。</div>')
        + '</div><div id="forumPager"></div></div>'

        + '<aside class="forum-side">'
        + '<div class="card"><h3>版块说明</h3>'
        + '<ol class="rule-list">'
        + '<li>发帖需要登录，提问请写清卡在哪一步</li>'
        + '<li>公式用 <code>$...$</code> 或 <code>$$...$$</code></li>'
        + '<li>发帖后 AI 助教会自动回一版思路</li>'
        + '<li>帖子可关联题库编号，回答会带上题目上下文</li>'
        + '</ol></div>'
        + '<div class="card"><h3>热门考点</h3><div class="tags">'
        + (data.hot || []).map(function (t) {
          return '<a class="tag" href="#/problems?tag=' + encodeURIComponent(t.name) + '">' + window.Md.esc(t.name) + ' ' + t.count + '</a>';
        }).join('')
        + '</div></div>'
        + '</aside></div>';

      const pagerWrap = document.getElementById('forumPager');
      if (pagerWrap) {
        pagerWrap.appendChild(window.UI.pagination(data.page, data.pages, function (p2) {
          location.hash = '#/forum?page=' + p2;
        }));
      }

      document.getElementById('newPostBtn').addEventListener('click', newPostModal);

      const search = document.getElementById('forumSearch');
      let t = null;
      search.addEventListener('input', function () {
        clearTimeout(t);
        t = setTimeout(function () {
          location.hash = '#/forum' + (search.value.trim() ? '?q=' + encodeURIComponent(search.value.trim()) : '');
        }, 380);
      });
    }).catch(function (e) {
      el.innerHTML = window.UI.empty('加载失败', e.message);
    });
  };

  /* ---------------------------------------------------------- 帖子详情 */

  Views.post = function (el, params) {
    const id = Number(params.id);
    let pollTimer = null;
    let pollCount = 0;

    function load(silent) {
      window.API.get('/api/forum/' + id).then(function (data) {
        const post = data.post;
        const hasAI = post.replies.some(function (r) { return r.isAI; });
        const canMark = St.me && (St.me.id === post.authorId || St.me.role === 'admin');

        if (!silent) {
          el.innerHTML =
            '<div class="crumbs"><a href="#/forum">答疑区</a><span class="sep">/</span><span>#' + post.id + '</span></div>'
            + '<div class="card post-detail">'
            + '<h1 id="postTitle"></h1>'
            + '<div class="post-author-line">' + window.UI.avatar(post.authorName)
            + '<div><div class="who">' + window.Md.esc(post.authorName) + (post.solved ? ' <span class="badge-solved">已解决</span>' : '') + '</div>'
            + '<div class="when">' + window.UI.fmtDate(post.createdAt) + ' · ' + post.views + ' 次浏览</div></div>'
            + (canMark && !post.solved ? '<button class="btn btn-sm right" id="markSolved">标记已解决</button>' : '')
            + '<button class="btn btn-sm right" id="delPost" style="margin-left:8px;color:var(--red);border-color:var(--red)" title="' + (St.me && St.me.role === 'admin' && St.me.id !== post.authorId ? '管理员删除他人帖子' : '删除我的帖子') + '">删除</button>'
            + '</div>'
            + '<div class="post-content md" id="postBody"></div>'
            + ((post.images && post.images.length)
              ? '<div class="post-images">' + post.images.map(function (src) {
                return '<a class="post-image" href="' + src + '" target="_blank" rel="noopener"><img src="' + src + '" alt="题目图片" loading="lazy" /></a>';
              }).join('') + '</div>'
              : '')
            + '<div class="tags" style="margin-top:10px">'
            + (post.tags || []).map(function (t) { return '<span class="tag gray">' + window.Md.esc(t) + '</span>'; }).join('')
            + '</div>'
            + (post.problem
              ? '<div class="linked-problem"><span class="code">' + post.problem.code + '</span>'
              + '<a href="#/problem/' + post.problem.code + '">' + window.Md.esc(post.problem.title) + '</a>'
              + '<span class="small muted right">去看看题目 →</span></div>'
              : '')
            + '<div class="replies">'
            + '<div class="replies-head">全部回复 <span class="n" id="replyCount">' + post.replies.length + '</span>'
            + '<span class="small muted right" id="aiPending"></span></div>'
            + '<div id="replyList"></div>'
            + '</div>'
            + '<div class="reply-editor">'
            + '<textarea id="replyInput" placeholder="写下你的想法或补充。公式用 $...$。想单独追问 AI 就在句子里带上 @AI助教。' + (St.me ? '' : '登录后才能回复。') + '" ' + (St.me ? '' : 'disabled') + '></textarea>'
            + '<div class="row"><span class="small muted">'
            + (St.me ? '以 ' + window.Md.esc(St.me.name) + ' 的身份回复' : '登录后可参与讨论')
            + '　<button type="button" class="btn btn-sm" id="mentionAI"' + (St.me ? '' : ' disabled') + '>@AI助教</button>'
            + '</span>'
            + '<button class="btn btn-primary btn-sm" id="replyBtn"' + (St.me ? '' : ' disabled') + '>发表回复</button></div>'
            + '</div></div>';

          document.getElementById('postTitle').innerHTML = window.Md.inlineTex(post.title);
          window.Md.render(document.getElementById('postBody'), post.body);

          const mark = document.getElementById('markSolved');
          if (mark) {
            mark.addEventListener('click', async function () {
              try { await window.API.post('/api/forum/' + id + '/solve'); window.UI.toast('已标记为解决', 'ok'); load(); }
              catch (e2) { window.UI.toast(e2.message, 'err'); }
            });
          }

          const delBtn = document.getElementById('delPost');
          if (delBtn) {
            delBtn.addEventListener('click', function () {
              const isOther = St.me && St.me.id !== post.authorId;
              if (!window.confirm((isOther ? '以管理员身份删除 ' + post.authorName + ' 的帖子？' : '删除这条帖子？') + '删除后不可恢复。')) return;
              window.API.post('/api/forum/' + id + '/delete').then(function () {
                window.UI.toast('已删除', 'ok');
                location.hash = '#/forum';
              }).catch(function (e2) { window.UI.toast(e2.message, 'err'); });
            });
          }

          const replyBtn = document.getElementById('replyBtn');
          if (replyBtn) {
            replyBtn.addEventListener('click', sendReply);
            document.getElementById('replyInput').addEventListener('keydown', function (e) {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendReply();
            });
          }
          const rk = window.MathKey && window.MathKey.attach(document.getElementById('replyInput'));
          const mentionBtn = document.getElementById('mentionAI');
          if (mentionBtn) {
            mentionBtn.addEventListener('click', function () {
              const box = document.getElementById('replyInput');
              const at = box.selectionStart || box.value.length;
              const txt = box.value;
              const ins = (at > 0 && !/\s$/.test(txt.slice(0, at)) ? ' ' : '') + '@AI助教 ';
              box.value = txt.slice(0, at) + ins + txt.slice(at);
              box.focus();
              box.selectionStart = box.selectionEnd = at + ins.length;
            });
          }
        }

        renderReplies(post.replies, hasAI);

        if (!hasAI && pollCount < 6) {
          pollCount++;
          const pending = document.getElementById('aiPending');
          if (pending) pending.innerHTML = '<span class="typing"><i></i><i></i><i></i></span> AI 助教正在整理思路';
          clearTimeout(pollTimer);
          pollTimer = setTimeout(function () { load(true); }, 1600);
        }
      }).catch(function (e) {
        if (!silent) el.innerHTML = window.UI.empty('帖子不存在', e.message);
      });
    }

    function renderReplies(replies, hasAI) {
      const list = document.getElementById('replyList');
      if (!list) return;
      if (!replies.length) {
        list.innerHTML = '<div class="small muted" style="padding:14px 0">还没有回复，来说两句。</div>';
        return;
      }
      list.innerHTML = replies.map(function (r) {
        return '<div class="reply' + (r.isAI ? ' reply-ai' : '') + '">'
          + (r.isAI ? '<span class="avatar ai">AI</span>' : window.UI.avatar(r.authorName))
          + '<div class="reply-main"><div class="reply-head">'
          + '<span class="name">' + window.Md.esc(r.authorName) + '</span>'
          + (r.isAI ? '<span class="ai-badge">AI 助教</span>' : '')
          + (r.replyTo ? '<span class="small muted">回复 #' + r.replyTo + '</span>' : '')
          + '<span class="when">' + window.UI.timeAgo(r.createdAt) + '</span></div>'
          + '<div class="reply-body md" data-reply="' + r.id + '"></div>'
          + ((r.images && r.images.length)
            ? '<div class="post-images small">' + r.images.map(function (src) {
              return '<a class="post-image" href="' + src + '" target="_blank" rel="noopener"><img src="' + src + '" alt="回复图片" loading="lazy" /></a>';
            }).join('') + '</div>'
            : '')
          + '</div></div>';
      }).join('');

      replies.forEach(function (r) {
        const box = list.querySelector('[data-reply="' + r.id + '"]');
        if (box) window.Md.render(box, r.body);
      });

      const count = document.getElementById('replyCount');
      if (count) count.textContent = replies.length;
      if (hasAI) {
        const pending = document.getElementById('aiPending');
        if (pending) pending.textContent = '';
      }
    }

    async function sendReply() {
      if (!St.me) { window.UI.requireLogin(); return; }
      const ta = document.getElementById('replyInput');
      const body = ta.value.trim();
      if (body.length < 2) { window.UI.toast('回复不能为空', 'err'); return; }
      const btn = document.getElementById('replyBtn');
      btn.disabled = true;
      try {
        await window.API.post('/api/forum/' + id + '/reply', { body: body });
        ta.value = '';
        btn.disabled = false;
        load(true);
        window.UI.toast('已回复', 'ok');
      } catch (e) {
        window.UI.toast(e.message, 'err');
        btn.disabled = false;
      }
    }

    load(false);
    return function () { clearTimeout(pollTimer); };
  };
})();
