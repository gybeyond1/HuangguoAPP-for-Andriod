// Render real app assets with the existing mocked Android bridge, for both content modes.
import fs from 'node:fs';
import path from 'node:path';
const pages = await (await fetch('http://127.0.0.1:19337/json')).json();
const ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => ws.onopen = resolve);
let seq = 0;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const entry = pending.get(message.id); pending.delete(message.id);
    message.error ? entry.reject(message.error) : entry.resolve(message.result);
  }
};
function cdp(method, params = {}) {
  return new Promise((resolve,reject) => { const id=++seq; pending.set(id,{resolve,reject}); ws.send(JSON.stringify({id,method,params})); });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for (let i=0;i<60;i++) { if (await evaluate(expression).catch(()=>false)) return; await new Promise(resolve=>setTimeout(resolve,100)); }
  throw new Error('Timed out: '+expression);
}
const fixtureFile=fs.readFileSync('qa/check-dual-mode.mjs','utf8').replaceAll('\r\n','\n');
const start=fixtureFile.indexOf('source:`')+'source:`'.length;
const fixture=fixtureFile.slice(start,fixtureFile.indexOf('\n`});',start));
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride',{width:363,height:792,deviceScaleFactor:2,mobile:true});
await cdp('Page.addScriptToEvaluateOnNewDocument',{source:fixture});
await cdp('Page.navigate',{url:'http://127.0.0.1:19837/app.html'});
await until("!!document.querySelector('.home-page')");
const output=path.resolve('qa/settings-header-results'); fs.mkdirSync(output,{recursive:true});
const checks=[];
for(const mode of ['hongguo','huangguo']) {
  await evaluate(`sessionStorage.setItem('qa-source','${mode}');localStorage.setItem('qa-unlocked','1');localStorage.setItem('qa-age','1');location.reload()`);
  await until(`contentSource==='${mode}' && !!document.querySelector('.home-page')`);
  await evaluate("goLibrary('bookmarks')"); await until("state.route==='library' && !!document.querySelector('.library-page')");
  await evaluate('goSettings()'); await until("state.route==='settings' && !!document.querySelector('.settings-page')");
  const result=await evaluate(`({
    headerHidden:document.querySelector('#app>.app-top').getClientRects().length===0,
    fullHeight:Math.abs(document.getElementById('scroll').getBoundingClientRect().height-document.getElementById('app').getBoundingClientRect().height)<1,
    safeBack:document.querySelector('.settings-page [data-back]').getBoundingClientRect().top>=parseFloat(getComputedStyle(document.getElementById('app')).getPropertyValue('--status-bar-height')),
    versionEntry:!!document.querySelector('.settings-page [data-secret-entry]')
  })`);
  for(const [name,passed] of Object.entries(result)) { checks.push({mode,name,passed});if(!passed)throw new Error(mode+': '+name); }
  const shot=await cdp('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(output,mode+'-settings.png'),Buffer.from(shot.data,'base64'));
  const preview=await evaluate("window.hgPredictiveBackStart(false) && document.querySelector('.back-preview>.app-top').getClientRects().length>0");
  checks.push({mode,name:'parentHeaderVisibleInPredictiveReturn',passed:preview});if(!preview)throw new Error(mode+': parent preview');
  await evaluate('clearPredictivePreview();window.hgBack()');
  await until("state.route==='library'");
  const returned=await evaluate("document.querySelector('#app>.app-top').getClientRects().length>0");
  checks.push({mode,name:'libraryHeaderRestored',passed:returned});if(!returned)throw new Error(mode+': library header');
}
fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify(checks,null,2));
console.log(`PASS ${checks.length} settings header checks (both modes, real DOM/CSS with mocked data)`);
ws.close();
