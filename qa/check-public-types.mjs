// Real UI assets; Android bridge and pagination data are explicitly mocked.
import fs from 'node:fs';
import path from 'node:path';
const pages=await(await fetch('http://127.0.0.1:19337/json')).json();
const ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
await new Promise(resolve=>ws.onopen=resolve);
let sequence=0;
const pending=new Map();
ws.onmessage=event=>{
  const message=JSON.parse(event.data);
  if(message.id){const entry=pending.get(message.id);pending.delete(message.id);message.error?entry.reject(message.error):entry.resolve(message.result);}
};
const cdp=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
});
async function evaluate(expression){
  const result=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression){
  for(let i=0;i<70;i++){if(await evaluate(expression).catch(()=>false))return;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('Timed out '+expression);
}
const file=fs.readFileSync('qa/check-dual-mode.mjs','utf8').replaceAll('\r\n','\n');
const start=file.indexOf('source:`')+8;
let fixture=file.slice(start,file.indexOf('\n`});',start));
const catalog=JSON.parse(fs.readFileSync('qa/fixtures/hongguo-major-categories.json','utf8'));
fixture=fixture.replace("if(action==='category') {",`if(action==='tags') value=source==='hongguo'?${JSON.stringify(catalog)}:{items:[{slug:'dushi',name:'都市',group:'popular'},{slug:'chuanyue',name:'穿越',group:'story'}]};
if(action==='tag-list'){
 window.qaTagRequests ||= [];window.qaTagRequests.push({source,slug:args.slug,page:args.page});
 const page=Number(args.page)||1;
 if(source==='huangguo'&&args.slug.includes(':'))error='来源错误';
 if(source==='hongguo'&&!/^(short|comic):/.test(args.slug))error='来源错误';
 if(page===2&&window.qaFailTagPage2){window.qaFailTagPage2=false;error='模拟分页失败';}
 value={items:Array.from({length:24},(_,i)=>({...items[i%items.length],id:String(2000+page*100+i),title:'分类作品'+(page*100+i)})),nextPage:page<3?page+1:null,contentType:args.slug.startsWith('comic:')?'comic':'short'};
}
if(action==='category') {`);
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride',{width:363,height:792,deviceScaleFactor:2,mobile:true});
await cdp('Page.addScriptToEvaluateOnNewDocument',{source:fixture});
await cdp('Page.navigate',{url:'http://127.0.0.1:19837/app.html'});
await until("contentSource==='hongguo'&&!!document.querySelector('.home-page')");
const output=path.resolve('qa/public-types-results');fs.mkdirSync(output,{recursive:true});
const checks=[];
async function check(name,expression){const passed=!!await evaluate(expression);checks.push({name,passed});if(!passed)throw new Error(name);}
async function screenshot(name){const result=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));}
await check('public home has all types and eight shortcuts',"!!document.querySelector('[data-all-tags]')&&document.querySelectorAll('.home-tags [data-tag-slug]').length===8");
await evaluate('goTags()');await until("!!document.querySelector('.tags-page')&&state.tags?.items?.length===32");
await check('short and comic groups retain separate typed slugs',"[...document.querySelectorAll('.tag-choice')].filter(x=>x.dataset.tagSlug.startsWith('short:')).length===24&&[...document.querySelectorAll('.tag-choice')].filter(x=>x.dataset.tagSlug.startsWith('comic:')).length===8");
await check('major groups use existing yellow pill grid',"document.querySelectorAll('.tags-group').length===2&&getComputedStyle(document.querySelector('.tag-choice')).borderRadius==='22px'");
await evaluate("document.documentElement.dataset.theme='light'");await screenshot('public-types-light');
await evaluate("window.qaFailTagPage2=true;goTag('short:suspense','悬疑')");await until("state.listing?.items?.length===24&&!state.listing.refreshing");
await check('short type list title',"document.querySelector('.listing-page h1').textContent==='短剧 · 悬疑'");
await evaluate('scroll.scrollTop=scroll.scrollHeight');await until('state.listing?.error===true');
await check('failed automatic pagination exposes retry',"!!document.querySelector('[data-retry-listing]')");
await evaluate("document.querySelector('[data-retry-listing]').click()");await until('state.listing.items.length===48&&!state.listing.loading');
await check('pagination appends distinct cards',"new Set(state.listing.items.map(x=>x.id)).size===48");
await evaluate('window.hgBack()');await until("state.route==='tags'");
await check('back restores types page',"document.querySelectorAll('.tag-choice').length===32");
await evaluate("goTag('comic:fantasy','玄幻')");await until('state.listing?.items?.length===24&&!state.listing.refreshing');
await check('comic scope remains distinguishable',"document.querySelector('.listing-page h1').textContent==='漫剧 · 玄幻'&&searchInput.value==='#漫剧·玄幻'");
await screenshot('comic-type-list');
await evaluate("sessionStorage.setItem('qa-source','huangguo');localStorage.setItem('qa-unlocked','1');localStorage.setItem('qa-age','1');location.reload()");
await until("contentSource==='huangguo'&&!!document.querySelector('.home-page')");
await evaluate('goTags()');await until("state.tags?.items?.length===2&&state.route==='tags'");
await check('yellow groups and original slugs retained',"document.querySelectorAll('.tags-group').length===2&&!!document.querySelector('[data-tag-slug=dushi]')");
await screenshot('private-types-unchanged');
await evaluate("goTag('dushi','都市')");await until('state.listing?.items?.length===24&&!state.listing.refreshing');
await check('yellow tag route still works',"document.querySelector('.listing-page h1').textContent==='#都市'");
fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify(checks,null,2));
console.log('PASS '+checks.length+' real UI genre checks with mocked bridge');
await cdp('Browser.close');ws.close();
