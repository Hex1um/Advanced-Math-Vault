import fs from 'fs';
const BASE='https://math-vault-10141.app.workbuddy.host';
const SC='Q6CZHVVW3K';
const get=async(u)=>{const r=await fetch(u);if(!r.ok)throw new Error(u+' '+r.status);return r.json();};
let size=50;
// 探测 size 上限
for (const s of [200,100,60,50]) {
  const j=await get(`${BASE}/api/problems?size=${s}&page=1&sharecode=${SC}`);
  if ((j.items||[]).length===s) { size=s; break; }
}
const first=await get(`${BASE}/api/problems?size=${size}&page=1&sharecode=${SC}`);
const pages=first.pages, total=first.total;
let items=[...first.items];
for (let p=2;p<=pages;p++){
  const j=await get(`${BASE}/api/problems?size=${size}&page=${p}&sharecode=${SC}`);
  items.push(...j.items);
}
fs.writeFileSync('.audit/all.json',JSON.stringify({total,pages,size,count:items.length,items},null,1));
console.log('拉取完成 size='+size,'页数='+pages,'题数='+items.length,'声明的 total='+total);
