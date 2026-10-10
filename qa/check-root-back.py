"""Run the shipping JS back handlers in isolation; Android's false-result fallback backgrounds the task."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
script = r'''
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(process.argv[1], 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const sandbox = {
  state: {}, window: {}, detailCard: null, predictivePreview: null, predictiveFrame: null,
  unlockOverlay: {hidden:true}, authOverlay: {hidden:true}, confirmOverlay: {hidden:true}, updateOverlay: {hidden:true},
  updateDownloading: false, searchInput: {value:''},
  headerSettings: {}, stopBannerAuto() {}, registered: null,
  privateMode() { return sandbox.state.mode==='huangguo'; },
  document: {getElementById(){return {dataset:{},classList:{toggle(){}}};}},
  goHome() { sandbox.homeCalls++; sandbox.state.route='home'; },
  restoreScreen(snapshot) { sandbox.state.route=snapshot.route; },
  closeUnlock() { sandbox.unlockOverlay.hidden=true; sandbox.updateBackEnabled(); },
  hideAuth() {}, closeConfirmation() {}, returnFromDetail() {}, homeCalls:0
};
sandbox.searchInput.setAttribute=()=>{};
sandbox.window.AndroidHost={setDetailMode(){},setBackEnabled(enabled){sandbox.registered=enabled;}};
vm.createContext(sandbox);
vm.runInContext(extract('function updateBackEnabled()', 'function setRoute(route)') +
  extract('function setRoute(route)', 'function isRootColumn()') +
  extract('function isRootColumn()', 'function clearPredictivePreview()') +
  extract('window.hgBack = () =>', 'window.hgResume = () =>') +
  extract('window.hgPredictiveBackCommit = () =>', 'function setNav(tab)'), sandbox);
let checks=0;
function check(value,label) { if(!value) throw new Error(label); checks++; }
for (const mode of ['hongguo','huangguo']) {
  for (const [route,tab] of [['home','home'],['category','adult'],['category','ai'],['library','library']]) {
    sandbox.state={route,tab,mode}; sandbox.homeCalls=0;
    sandbox.setRoute(route);
    check(sandbox.registered===false, `${mode}/${tab}: system back-to-home animation owns gesture, same as home`);
    check(sandbox.backDestination()===null, `${mode}/${tab}: no home preview`);
    check(sandbox.window.hgBack()===false, `${mode}/${tab}: native desktop fallback`);
    check(sandbox.window.hgPredictiveBackCommit()===false, `${mode}/${tab}: gesture uses desktop fallback`);
    check(sandbox.state.route===route && sandbox.homeCalls===0, `${mode}/${tab}: current column retained`);
  }
}
sandbox.state={route:'category',tab:'adult'}; sandbox.unlockOverlay.hidden=false;
sandbox.updateBackEnabled(); check(sandbox.registered===true, 'root dialog temporarily owns back');
check(sandbox.window.hgBack()===true && sandbox.unlockOverlay.hidden, 'visible dialog closes before leaving column');
check(sandbox.registered===false, 'dismissed dialog restores system animation');
sandbox.state={route:'settings',settingsReturn:{route:'library'}};
sandbox.setRoute('settings'); check(sandbox.registered===true, 'settings retains custom parent animation');
check(sandbox.backDestination()==='library', 'settings keeps parent preview');
check(sandbox.window.hgBack()===true && sandbox.state.route==='library', 'settings returns to library');
let closed=0; sandbox.state={route:'detail',previous:{route:'category'}}; sandbox.detailCard={close(){closed++;}};
sandbox.setRoute('detail'); check(sandbox.registered===true, 'detail retains custom source animation');
check(sandbox.backDestination()==='category', 'detail keeps source column preview');
check(sandbox.window.hgBack()===true && closed===1, 'detail keeps normal close behavior');
sandbox.detailCard=null; sandbox.state={route:'search'};
sandbox.setRoute('search'); check(sandbox.registered===true, 'search retains custom back handling');
check(sandbox.window.hgBack()===true && sandbox.state.route==='home', 'search retains existing return behavior');
console.log(`PASS ${checks} root-column and child-page back checks`);
'''
result = subprocess.run(['node', '-e', script, str(root / 'app/src/main/assets/app.js')], capture_output=True, text=True)
if result.returncode:
    raise SystemExit(next((line for line in result.stderr.splitlines() if line.startswith('Error:')), result.stderr[:1200]))
print(result.stdout.strip())
(root / 'qa/root-back-result.txt').write_text(result.stdout, encoding='utf-8')
