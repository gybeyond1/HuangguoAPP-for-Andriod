// Real application assets; Android bridge and content fixtures are explicitly mocked.
import fs from 'node:fs';
import path from 'node:path';
const pages = await (await fetch('http://127.0.0.1:19337/json')).json();
const ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => ws.onopen = resolve);
let seq = 0;
const pending = new Map(), errors = [], checks = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const entry = pending.get(message.id); pending.delete(message.id);
    message.error ? entry.reject(message.error) : entry.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, {resolve, reject}); ws.send(JSON.stringify({id, method, params})); });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for (let i = 0; i < 60; i++) {
    try { if (await evaluate(expression)) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + expression);
}
async function check(name, expression) {
  const passed = !!await evaluate(expression);
  checks.push({name, passed});
  console.log((passed ? 'PASS ' : 'FAIL ') + name);
  if (!passed) throw new Error(name);
}
const output = path.resolve('qa/dual-mode-results'); fs.mkdirSync(output, {recursive:true});
async function screenshot(name) {
  const result = await cdp('Page.captureScreenshot', {format:'png'});
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(result.data, 'base64'));
}
await cdp('Runtime.enable'); await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', {width:412,height:852,deviceScaleFactor:2,mobile:true});
await cdp('Page.addScriptToEvaluateOnNewDocument', {source:`
const cover = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="850"><rect width="600" height="850" fill="#586455"/><circle cx="350" cy="250" r="180" fill="#dfba72"/></svg>');
window.AndroidHost = {setBackEnabled(){},setDetailMode(){},request(id, action, json) {
  const args=JSON.parse(json), source=sessionStorage.getItem('qa-source') || 'hongguo';
  const status=()=>({source:sessionStorage.getItem('qa-source') || 'hongguo',unlocked:localStorage.getItem('qa-unlocked')==='1',needsAgeConfirmation:localStorage.getItem('qa-unlocked')==='1' && localStorage.getItem('qa-age')!=='1'});
  let value=null, error='';
  if (action==='content-status') value=status();
  else if (action==='enter-private') {
    if (!status().unlocked && args.password!=='ssgnb') error='密码不正确';
    else { localStorage.setItem('qa-unlocked','1'); if(localStorage.getItem('qa-age')==='1') sessionStorage.setItem('qa-source','huangguo'); value=status(); }
  } else if(action==='confirm-private-age') {localStorage.setItem('qa-age','1');sessionStorage.setItem('qa-source','huangguo');value=status();}
  else if(action==='leave-private') {sessionStorage.setItem('qa-source','hongguo');value=status();}
  else if(args.source!==source) error='内容已切换，请重新打开';
  else {
    const items=Array.from({length:8},(_,i)=>({id:String(i+1),title:(source==='huangguo'?'黄果示例':'红果示例')+(i+1),cover:'https://qa.invalid/'+i,score:'',episodeLabel:'共 24 集',description:'仅用于界面回归的模拟内容。',category:source==='huangguo'?'ai-duanju':'short'}));
    if(action==='home') value={featured:items.slice(0,2),recommend:{items,nextPage:null},newest:{items,nextPage:null}};
    if(action==='category') {
      const page=Number(args.page)||1;
      window.qaCategoryRequests ||= [];
      window.qaCategoryRequests.push({category:args.id,page});
      const from=(page-1)*24+1;
      const rows=Array.from({length:24},(_,i)=>({...items[i%items.length],id:String(from+i),title:(source==='huangguo'?'黄果示例':'红果示例')+(from+i)}));
      if(page>1) rows.unshift({...items[0],id:String(from-1)});
      if(page===2 && window.qaFailCategoryPage2) { window.qaFailCategoryPage2=false; error='分页连接失败'; }
      value={items:rows,nextPage:page<3?page+1:null};
    }
    if(action==='search') value={items,nextPage:null};
    if(action==='cover') value=cover;
    if(action==='account') value={loggedIn:false};
    if(action==='window-insets') value=40;
    if(action==='screen-corners') value={topLeft:32,topRight:32,bottomRight:32,bottomLeft:32};
    if(action==='theme') value='dark';
    if(action==='app-version') value='0.3.2';
    if(action==='cached-update'||action==='check-update') value={status:'unconfigured'};
    if(action==='hot-update-status'||action==='check-hot-update') value={enabled:false,pending:0,version:'内置'};
    if(action==='library') value={bookmarks:[],progress:[]};
    if(action==='bookmark-state') value=false;
    if(action==='detail') value={...items.find(item=>item.id===args.id),episodes:[{number:1},{number:2}]};
  }
  setTimeout(()=>error?NativeCallbacks.reject(id,error):NativeCallbacks.resolve(id,value),10);
}};
`});
await cdp('Page.navigate', {url:'http://127.0.0.1:19837/app.html'});
await until("!!document.querySelector('.home-page')");
await evaluate("localStorage.removeItem('qa-unlocked'); localStorage.removeItem('qa-age'); sessionStorage.setItem('qa-source','hongguo'); location.reload()");
await until("contentSource==='hongguo' && !!document.querySelector('.home-page')");
await check('public startup has red branding and no adult confirmation', "document.title==='橙子短剧' && document.getElementById('age-gate').hidden && contentSource==='hongguo'");
await check('public navigation shows short drama and comic', "document.querySelector('[data-nav=adult]').innerText==='短剧' && document.querySelector('[data-nav=ai]').innerText==='漫剧'");
await check('public home exposes all types without adult labels', "!!document.querySelector('[data-all-tags]') && !document.getElementById('app').innerText.includes('成人')");
await check('public search does not promise unsupported tag filtering', "searchInput.placeholder==='搜索剧名'");
await screenshot('public-home');
await evaluate("goCategory('adult')"); await until("!!document.querySelector('.category-grid,.category-page .film-grid') || state.category?.items?.length>0");
await check('public category preserves existing page layout', "state.route==='category' && document.querySelector('.category-head h1').innerText==='短剧'");
await check('scheme A removes the single-option category toolbar', "!document.querySelector('.category-page .segmented') && compact.innerHTML===''");
await check('short drama introduction matches approved wording', "document.querySelector('.category-head p').innerText==='真人演的看了不烧心'");
await check('short drama banner exposes five real item positions', "bannerSlides().length===5 && document.querySelectorAll('.category-carousel + .hero-dots [data-slide]').length===5");
await evaluate("stopBannerAuto(); document.querySelectorAll('.category-carousel + .hero-dots [data-slide]')[4].click()");
await until("state.categoryBanner===4 && !bannerChanging");
await check('dot navigation changes the banner item', "document.querySelector('.category-carousel .hero-cover-button').dataset.openId==='5'");
await evaluate("changeBanner(0,1)"); await until("state.categoryBanner===0 && !bannerChanging");
await check('category carousel wraps from last to first', "document.querySelector('.category-carousel .hero-cover-button').dataset.openId==='1'");
await until("state.categoryBanner===1 && !bannerChanging");
await check('category carousel advances automatically', "document.querySelector('.category-carousel .hero-cover-button').dataset.openId==='2'");
await evaluate(`stopBannerAuto(); var carousel=content.querySelector('.category-carousel'); var firstTouch=new Touch({identifier:1,target:carousel,clientX:320,clientY:310}); var lastTouch=new Touch({identifier:1,target:carousel,clientX:160,clientY:312}); carousel.dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[firstTouch],changedTouches:[firstTouch]})); carousel.dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[],changedTouches:[lastTouch]}));`);
await until("state.categoryBanner===2 && !bannerChanging");
await check('horizontal swipe changes banner without opening detail', "state.route==='category' && document.querySelector('.category-carousel .hero-cover-button').dataset.openId==='3'");
await until("performance.now()>heroSuppressClickUntil");
await evaluate("stopBannerAuto(); var titleBox=document.querySelector('.category-carousel .category-spotlight-copy h2').getBoundingClientRect(); document.elementFromPoint(titleBox.left+titleBox.width/2,titleBox.top+titleBox.height/2).click()");
await until("state.route==='detail' && !state.detailLoading");
await check('banner opens the selected series', "state.detail.id==='3'");
await evaluate("hgBack()"); await until("state.route==='category' && !document.querySelector('.card-transition-surface')");
await check('return from banner detail restores carousel position', "state.categoryBanner===2 && document.querySelector('.category-carousel .hero-cover-button').dataset.openId==='3'");
await screenshot('short-category-scheme-a');
await evaluate("window.qaFailCategoryPage2=true; scroll.scrollTop=scroll.scrollHeight");
await until("!!document.querySelector('[data-retry-category]')");
await check('infinite feed preserves content when next page fails', "state.category.items.length===24 && state.category.error");
await evaluate("document.querySelector('[data-retry-category]').click()");
await until("state.category.items.length===48 && !state.category.loading");
await check('retry appends unique cards and updates count', "document.querySelectorAll('.category-grid .film-card').length===48 && document.querySelector('.category-count').innerText==='已显示 48 部'");
await check('public scroll does not show a redundant sticky switcher', "scroll.scrollTop>92 && !compact.classList.contains('visible') && !document.querySelector('.category-page').classList.contains('is-collapsed')");
await evaluate("Promise.all([loadMoreCategory(),loadMoreCategory()])");
await until("state.category.items.length===72 && !state.category.loading");
await check('concurrent loading sends one request for the next page', "qaCategoryRequests.filter(r=>r.page===3).length===1");
await check('real end removes sentinel without repeating the list', "!state.category.nextPage && !document.querySelector('.category-sentinel') && document.querySelector('.category-footer').innerText==='已经到底了'");
await evaluate("goCategory('ai')");
await until("state.route==='category' && state.tab==='ai' && state.category?.items?.length===24");
await check('comic column uses scheme A too', "document.querySelector('.category-head h1').innerText==='漫剧' && !document.querySelector('.category-page .segmented')");
await check('comic column has an independent five-item banner', "state.categoryBanner===0 && bannerSlides().length===5 && document.querySelectorAll('.category-carousel + .hero-dots [data-slide]').length===5");
await evaluate("changeBanner(1,1)"); await until("state.categoryBanner===1 && !bannerChanging");
await check('comic banner can switch independently', "state.tab==='ai' && document.querySelector('.category-carousel .hero-cover-button').dataset.openId==='2'");
await screenshot('comic-category-scheme-a');
await evaluate("scroll.scrollTop=scroll.scrollHeight");
await until("state.category.items.length===48 && !state.category.loading");
await check('comic infinite feed loads on scroll', "document.querySelectorAll('.category-grid .film-card').length===48");
await evaluate('goSettings()'); await until("!!document.querySelector('[data-secret-entry]')");
await evaluate("for(let i=0;i<4;i++) document.querySelector('[data-secret-entry]').click()");
await check('four version taps do not reveal password', "unlockOverlay.hidden");
await evaluate("document.querySelector('[data-secret-entry]').click()"); await until('!unlockOverlay.hidden');
await screenshot('password-entry');
await evaluate("document.getElementById('unlock-password').value='wrong'; document.getElementById('unlock-form').requestSubmit()");
await until("!document.getElementById('unlock-error').hidden");
await check('incorrect password keeps public content', "contentSource==='hongguo' && document.getElementById('unlock-error').innerText==='密码不正确'");
await evaluate("document.getElementById('unlock-password').value='ssgnb'; document.getElementById('unlock-form').requestSubmit()");
await until("!document.getElementById('age-gate').hidden");
await check('first private entry requires adult confirmation', "unlockOverlay.hidden && contentSource==='hongguo'");
await evaluate("document.getElementById('age-confirm').click()");
await until("contentSource==='huangguo' && !!document.querySelector('.home-page')");
await check('private mode restores original navigation and branding', "document.title==='橙子短剧' && document.querySelector('[data-nav=adult]').innerText==='剧场' && document.querySelector('[data-nav=ai]').innerText==='AI'");
await evaluate("goCategory('adult')"); await until("state.category?.items?.length===24");
await check('private category retains its original two-option toolbar', "document.querySelectorAll('.category-page .segmented button').length===2");
await screenshot('private-home');
await evaluate('goSettings()'); await until("!!document.querySelector('[data-return-public]')");
await evaluate("document.querySelector('[data-return-public]').click()");
await until("contentSource==='hongguo' && !!document.querySelector('.home-page')");
await check('return restores public content', "document.title==='橙子短剧' && !document.getElementById('app').innerText.includes('黄果示例')");
await evaluate('goSettings()'); await until("!!document.querySelector('[data-secret-entry]')");
await evaluate("for(let i=0;i<5;i++) document.querySelector('[data-secret-entry]').click()");
await until("contentSource==='huangguo' && !!document.querySelector('.home-page')");
await check('unlocked entry still requires five taps and no password', "unlockOverlay.hidden && document.getElementById('age-gate').hidden");
await evaluate("sessionStorage.setItem('qa-source','hongguo'); location.reload()");
await until("contentSource==='hongguo' && !!document.querySelector('.home-page')");
await check('restart returns public while retaining unlock qualification', "localStorage.getItem('qa-unlocked')==='1' && document.title==='橙子短剧'");
fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify({bridge:'mocked',checks,errors},null,2));
ws.close();
if(errors.length) throw new Error(errors.join('\n'));
