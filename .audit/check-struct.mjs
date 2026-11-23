import fs from 'fs';
const {items}=JSON.parse(fs.readFileSync('.audit/all.json','utf8'));
const R=[];
const p=(...a)=>R.push(a.join(' '));

// 1 编号
const codes=items.map(x=>x.code);
const dupCode=codes.filter((c,i)=>codes.indexOf(c)!==i);
const nums=codes.map(c=>{const m=/^([A-Za-z]+)(\d+)$/.exec(c);return m?{pre:m[1],n:+m[2],code:c}:null;}).filter(Boolean);
const pres=[...new Set(nums.map(x=>x.pre))];
p('## 编号\n前缀:',pres.join(','),'| 重复编号:',dupCode.length?dupCode.join(','):'无');
for(const pre of pres){
  const ns=nums.filter(x=>x.pre===pre).map(x=>x.n).sort((a,b)=>a-b);
  const gaps=[];for(let i=1;i<ns.length;i++)if(ns[i]!==ns[i-1]+1)gaps.push(ns[i-1]+'→'+ns[i]);
  p('  '+pre+': '+ns.length+' 题, 范围 '+ns[0]+'-'+ns[ns.length-1]+', 缺口 '+(gaps.length?gaps.slice(0,8).join(' ')+(gaps.length>8?' …共'+gaps.length:'')+'':'无'));
}

// 2 标题重复
const norm=s=>String(s||'').toLowerCase().replace(/[\s$\\{}]/g,'').replace(/\\[a-z]+/g,'').replace(/[·・,，。;；:：]/g,'');
const byNorm=new Map();
for(const it of items){const k=norm(it.title);if(!byNorm.has(k))byNorm.set(k,[]);byNorm.get(k).push(it.code);}
const exact=[...byNorm.values()].filter(v=>v.length>1);
p('\n## 标题完全重复\n'+ (exact.length?exact.slice(0,15).map(v=>v.join(' = ')).join('\n') : '无') + (exact.length>15?'\n…共 '+exact.length+' 组':''));

// 3 近似重复（字符 3-gram Jaccard，分桶降复杂度）
const grams=s=>{const t=norm(s).replace(/[^0-9a-z\u4e00-\u9fa5+*/^=<>]/g,'');const g=new Set();for(let i=0;i+3<=t.length;i++)g.add(t.slice(i,i+3));return g;};
const sig=items.map(it=>({code:it.code,g:grams(it.title),t:it.title}));
const cand=[];
for(let i=0;i<sig.length;i++){
  if(sig[i].g.size<6)continue;
  for(let j=i+1;j<sig.length;j++){
    const a=sig[i].g,b=sig[j].g;if(!b.size)continue;
    if(Math.abs(a.size-b.size)>Math.max(a.size,b.size)*0.5)continue;
    let inter=0;for(const x of a)if(b.has(x))inter++;
    const jac=inter/(a.size+b.size-inter);
    if(jac>=0.72)cand.push([jac,sig[i],sig[j]]);
  }
}
cand.sort((x,y)=>y[0]-x[0]);
p('\n## 近似重复（标题相似度≥0.72）\n'+(cand.length?cand.slice(0,12).map(([j,a,b])=>j.toFixed(2)+'  '+a.code+' ↔ '+b.code+'  「'+a.t.slice(0,26)+'」').join('\n'):'无')+(cand.length>12?'\n…共 '+cand.length+' 对':''));
p('  疑似重复对总数: '+cand.length);

// 4 字段完整性
const empty=k=>items.filter(x=>!x[k]||(Array.isArray(x[k])&&!x[k].length)).length;
const shortEx=items.filter(x=>String(x.excerpt||'').replace(/\s/g,'').length<8).length;
const badScore=items.filter(x=>!(x.thinking>=1&&x.thinking<=10)||!(x.difficulty>=1)||!(x.calc>=1&&x.calc<=10)).length;
p('\n## 字段完整性');
p('  无 source:',empty('source'),'| 无 tags:',empty('tags'),'| excerpt 过短(<8字):',shortEx,'| 三维分异常:',badScore);
p('  无来源占比:',(empty('source')/items.length*100).toFixed(1)+'%');
p('  solvedCount=0 的题:',items.filter(x=>!x.solvedCount).length+'/'+items.length);

// 5 评分口径
const pure=items.filter(x=>x.calc>=7&&x.thinking>=7&&x.thinking>=x.calc*0.85);
p('\n## 评分口径可疑（计算量≥7 且 思维量≥7 且 思维≥0.85×计算）: '+pure.length+' 题');
p('  '+pure.slice(0,15).map(x=>x.code+' '+x.thinking+'/'+x.difficulty+'/'+x.calc).join(', '));
const hi=items.filter(x=>x.difficulty>15);
p('  难度>15 的题:',hi.length, hi.slice(0,8).map(x=>x.code+':'+x.difficulty).join(','));
const thinkDist={};for(const x of items)thinkDist[x.thinking]=(thinkDist[x.thinking]||0)+1;
p('  思维量分布:',Object.keys(thinkDist).sort((a,b)=>a-b).map(k=>k+'→'+thinkDist[k]).join(' '));
const calcDist={};for(const x of items)calcDist[x.calc]=(calcDist[x.calc]||0)+1;
p('  计算量分布:',Object.keys(calcDist).sort((a,b)=>a-b).map(k=>k+'→'+calcDist[k]).join(' '));
const lv={};for(const x of items)lv[x.level]=(lv[x.level]||0)+1;
p('  难度等级分布:',JSON.stringify(lv));

// 6 标签长尾
const tagC={};for(const x of items)for(const t of x.tags||[])tagC[t]=(tagC[t]||0)+1;
const longTail=Object.entries(tagC).filter(([,c])=>c===1);
p('\n## 标签\n标签总数:',Object.keys(tagC).length,'| 仅出现 1 次的标签:',longTail.length);
p('  长尾示例:',longTail.slice(0,25).map(([t])=>t).join('、'));

fs.writeFileSync('.audit/report-struct.txt',R.join('\n'));
console.log(R.join('\n'));
