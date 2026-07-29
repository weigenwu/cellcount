const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const experiment = fs.mkdtempSync(path.join(os.tmpdir(), "cellscope-compare-"));
const group = path.join(experiment, "实验组A");
fs.mkdirSync(group);
for (const view of ["Overlay001", "Overlay002"]) {
  for (const suffix of ["", "_ch00", "_ch01", "_ch02"]) {
    fs.writeFileSync(path.join(group, `${view}${suffix}.png`), png);
  }
}

const mime = {".html":"text/html", ".js":"text/javascript", ".css":"text/css"};
const server = http.createServer((request,response)=>{
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const file = path.join(root, pathname === "/" ? "index.html" : pathname.slice(1));
  if (!file.startsWith(root) || !fs.existsSync(file)) {
    response.writeHead(404); response.end(); return;
  }
  response.setHeader("Content-Type", mime[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(response);
});
let browser, page;

(async()=>{
  await new Promise(resolve=>server.listen(0, "127.0.0.1", resolve));
  const installedBrowser = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].find(fs.existsSync);
  browser = await chromium.launch({headless:true, ...(installedBrowser ? {executablePath:installedBrowser} : {})});
  page = await browser.newPage({viewport:{width:1500,height:900}});
  page.setDefaultTimeout(15000);
  const errors=[];
  page.on("console",message=>message.type()==="error"&&errors.push(message.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator("#folderInput").setInputFiles(experiment);
  await page.waitForTimeout(800);
  assert.match(await page.locator("#projectMeta").textContent(),/2 个视野/);
  await page.locator("#compareBtn").click();
  await page.locator("#compareDialog:not(.hidden)").waitFor();
  assert.strictEqual(await page.locator("#compareLeftView option").count(), 2);
  assert.strictEqual(await page.locator("#compareRightView option").count(), 2);
  await page.waitForFunction(()=>document.querySelector("#compareLeftImage").width===1);
  assert.match(await page.locator("#compareLeftStats").textContent(), /DAPI 0/);
  assert.match(await page.locator("#compareRightStats").textContent(), /肿瘤 0/);
  await page.locator("#compareLeftChannel").selectOption("nk");
  assert.strictEqual(await page.locator("#compareLeftChannel").inputValue(), "nk");
  const before=await page.locator("#compareRightStage").evaluate(node=>node.style.transform);
  await page.locator("#compareLeftViewer").dispatchEvent("wheel",{deltaY:-100,clientX:250,clientY:250});
  const after=await page.locator("#compareRightStage").evaluate(node=>node.style.transform);
  assert.notStrictEqual(after,before);
  if(process.env.CELLSCOPE_SCREENSHOT)await page.screenshot({path:process.env.CELLSCOPE_SCREENSHOT,fullPage:true});
  await page.locator("#compareCloseBtn").click();
  await page.locator(".channel-name-editor summary").click();
  await page.locator("#channelNameNk").fill("效应细胞");
  await page.locator("#saveChannelNamesBtn").click();
  await page.waitForFunction(()=>document.querySelector("#autosaveStatus").textContent==="已自动保存");
  assert.strictEqual(await page.locator("#viewerLabelNk").textContent(),"效应细胞");
  await page.evaluate(()=>{
    const result={status:"done",error:"",detections:[{id:"test-cell",x:0,y:0,radius:1,classification:"dapi",manual:false,deleted:false}]};
    state.project.results[state.currentViewId]={dapi:result};
    state.target="dapi";state.detections=result.detections;
    pushHistory("cell");
    state.detections[0].deleted=true;state.detections[0].manual=true;
    syncCorrections();
  });
  await page.locator("#undoBtn").click();
  assert.strictEqual(await page.evaluate(()=>state.detections[0].deleted),false);
  await page.locator("#redoBtn").click();
  assert.strictEqual(await page.evaluate(()=>state.detections[0].deleted),true);
  assert.strictEqual(await page.evaluate(()=>cicRawCsv().includes("证据等级")&&cicRawCsv().includes("径向一致性")),true);
  assert.deepStrictEqual(errors,[]);
  await browser.close();
  server.close();
  fs.rmSync(experiment,{recursive:true,force:true});
  console.log("browser compare and autosave tests passed");
})().catch(async error=>{
  console.error(error);
  if(page)console.error("page state",await page.evaluate(()=>({
    files:document.querySelector("#folderInput").files.length,
    meta:document.querySelector("#projectMeta").textContent,
    toast:document.querySelector("#toast").textContent,
  })).catch(()=>null));
  if(browser)await browser.close();
  server.close();
  fs.rmSync(experiment,{recursive:true,force:true});
  process.exitCode=1;
});
