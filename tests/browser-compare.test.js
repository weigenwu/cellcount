const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const experiment = fs.mkdtempSync(path.join(os.tmpdir(), "cellscope-compare-"));
const group = path.join(experiment, "实验组A");
fs.mkdirSync(group);
const metadata = path.join(group, "MetaData");
fs.mkdirSync(metadata);
for (const view of ["Overlay001", "Overlay002"]) {
  for (const suffix of ["", "_ch00", "_ch01", "_ch02"]) {
    fs.writeFileSync(path.join(group, `${view}${suffix}.png`), png);
  }
  fs.writeFileSync(path.join(metadata,`${view}.xml`),`<?xml version="1.0"?><Data><Image><ImageDescription><Channels><ChannelDescription LUTName="Red"/><ChannelDescription LUTName="Green"/><ChannelDescription LUTName="Blue"/></Channels><Dimensions><DimensionDescription DimID="1" NumberOfElements="100" Length="2.18e-5" Unit="m"/></Dimensions></ImageDescription></Image></Data>`);
}
const partialGroup=path.join(experiment,"单通道组"),partialMetadata=path.join(partialGroup,"MetaData");
fs.mkdirSync(partialMetadata,{recursive:true});
fs.writeFileSync(path.join(partialGroup,"Image006.png"),png);
fs.writeFileSync(path.join(partialGroup,"Image006_ch00.png"),png);
fs.writeFileSync(path.join(partialMetadata,"Image006.xml"),`<?xml version="1.0"?><Data><Image><ImageDescription><Channels><ChannelDescription LUTName="Blue"/></Channels></ImageDescription></Image></Data>`);

const workerContext={
  console,importScripts(){},postMessage(){},Blob,Map,Math,
  Uint8Array,Uint8ClampedArray,Uint16Array,Uint32Array,Int32Array,Float64Array,
};
vm.createContext(workerContext);
vm.runInContext(fs.readFileSync(path.join(root,"browser-worker.js"),"utf8"),workerContext);

async function verifyGuidedSignal() {
  const width=80,height=60,signal=new Uint8Array(width*height).fill(20);
  for(let y=23;y<=26;y++)for(let x=18;x<=21;x++)signal[y*width+x]=110;
  const nuclei=[
    {id:"auto-7",x:20,y:25,radius:4,area_px:50,circularity:.9,manual:false,deleted:false},
    {id:"auto-8",x:29,y:25,radius:4,area_px:50,circularity:.9,manual:false,deleted:false},
  ];
  workerContext.decode=async()=>({data:signal,width,height});
  const result=await workerContext.analyze({
    type:"analyze",target:"nk",targetLabel:"NK",channelBuffer:new ArrayBuffer(0),channelExtension:".png",
    anchorDetections:nuclei,pixelSizeUm:.5,
    params:{analysis_mode:"nucleus_guided",ring_radius_um:2,ring_radius_px:99,signal_threshold:10,signal_mad_multiplier:3,min_signal_block_um2:1,positive_fraction:.02},
  });
  assert.strictEqual(result.detections.length,1);
  assert.strictEqual(result.detections[0].id,"auto-7");
  assert.strictEqual(result.detections[0].display_label,1);
  assert.strictEqual(result.detections[0].ring_radius_px_resolved,4);
  assert(result.detections[0].signal_runs.length>0);
  assert(result.detections[0].area_px>=16);

  const noise=new Uint8Array(width*height).fill(20);noise[25*width+20]=255;
  const owners=workerContext.nucleusOwners(nuclei,width,height);
  const filtered=workerContext.robustPositivity(noise,width,height,nuclei[0],0,nuclei,owners,
    {ring_radius_um:2,signal_threshold:10,signal_mad_multiplier:3,min_signal_block_um2:1},.5,null);
  assert.strictEqual(filtered.areaPx,0);
  const legacy=workerContext.robustPositivity(signal,width,height,nuclei[0],0,nuclei,owners,
    {ring_radius_um:null,ring_radius_px:6,signal_threshold:10,signal_mad_multiplier:3,min_signal_block_um2:1},.5,null);
  assert.strictEqual(legacy.ringRadiusPx,6);
  const denseSignal=new Uint8Array(width*height).fill(80);
  const giant=[{id:"dense",x:40,y:30,radius:100,area_px:4800,circularity:.9,manual:false,deleted:false}];
  const denseResult=workerContext.robustPositivity(denseSignal,width,height,giant[0],0,giant,
    workerContext.nucleusOwners(giant,width,height),
    {ring_radius_um:0,signal_threshold:10,signal_mad_multiplier:3,min_signal_block_um2:1},.5,null);
  assert.strictEqual(denseResult.background,80);
  assert.strictEqual(denseResult.areaPx,0);

  const scale=new Uint8Array(100*100),mask=new Uint8Array(100*100).fill(1);
  for(let x=92;x<100;x++)scale[99*100+x]=255;
  const region=workerContext.scaleBarRegion(scale,100,100);
  assert(region);workerContext.clearRegion(mask,region,100);
  assert.strictEqual(mask[99*100+95],0);assert.strictEqual(mask[50*100+50],1);
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
  await verifyGuidedSignal();
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
  await page.evaluate(()=>localStorage.clear());
  assert.strictEqual(await page.locator(".welcome h1").textContent(),"荧光细胞批量计数");
  assert.strictEqual(await page.locator('text=/CIC/i').count(),0);
  assert.strictEqual(await page.locator(".biology-legend span").count(),3);
  assert.strictEqual(await page.locator(".capability-rail span").count(),4);
  assert.strictEqual(await page.locator(".welcome-micrograph").getAttribute("src"),"static/assets/cellscope-fluorescence-hero.png");
  assert.strictEqual(await page.locator(".welcome-micrograph").evaluate(image=>image.complete&&image.naturalWidth>0),true);
  if(process.env.CELLSCOPE_LANDING_SCREENSHOT)await page.screenshot({path:process.env.CELLSCOPE_LANDING_SCREENSHOT,fullPage:true});
  if(process.env.CELLSCOPE_LANDING_MOBILE_SCREENSHOT){
    await page.setViewportSize({width:390,height:844});
    assert.strictEqual(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
    await page.screenshot({path:process.env.CELLSCOPE_LANDING_MOBILE_SCREENSHOT,fullPage:true});
    await page.setViewportSize({width:1500,height:900});
  }
  await page.locator("#folderInput").setInputFiles(experiment);
  await page.waitForTimeout(800);
  assert.match(await page.locator("#projectMeta").textContent(),/3 个视野/);
  const complete=await page.evaluate(()=>state.project.views.find(view=>view.name==="Overlay001"));
  assert.strictEqual(complete.fileNames.dapi,"Overlay001_ch02.png");
  assert.strictEqual(complete.fileNames.nk,"Overlay001_ch01.png");
  assert.strictEqual(complete.fileNames.tumor,"Overlay001_ch00.png");
  assert(Math.abs(complete.pixel_size_um-0.218)<1e-9);
  assert.match(await page.locator("#channelMappingTitle").textContent(),/Leica XML/);
  assert.match(await page.locator("#channelMappingSummary").getAttribute("title"),/DAPI ch02.*NK ch01.*肿瘤 ch00/);
  const partial=await page.evaluate(()=>{
    const view=state.project.views.find(item=>item.name==="Image006");
    return{mapping:view.channel_mapping,files:view.fileNames,error:view.error,source:view.channel_mapping_source,status:overallStatus(view)};
  });
  assert.deepStrictEqual(partial.mapping,{dapi:"_ch00"});
  assert.strictEqual(partial.files.dapi,"Image006_ch00.png");
  assert.strictEqual(partial.files.nk,"");
  assert.match(partial.error,/缺少绿色.*缺少红色/);
  assert.strictEqual(partial.source,"leica_xml");
  assert.strictEqual(partial.status,"partial");
  assert.deepStrictEqual(await page.evaluate(()=>{
    const legacy=serializableProject();
    legacy.cic_learning={samples:[{id:"old"}]};
    legacy.cic_parameters_by_group={};
    legacy.results[state.currentViewId]={
      dapi:{status:"done",error:"",detections:[{id:"kept",x:1,y:1,radius:1,classification:"dapi",manual:false,deleted:false}]},
      cic:{status:"done",events:[{id:"old"}]},
    };
    state.pendingProject=legacy;mergePendingProject();
    const output={
      project:"cic_learning" in state.project,
      result:"cic" in (state.project.results[state.currentViewId]||{}),
      dapi:targetResult(state.currentViewId,"dapi")?.detections?.length||0,
    };
    state.project.results[state.currentViewId]={};
    return output;
  }),{project:false,result:false,dapi:1});
  assert.strictEqual(await page.locator("#viewPositionBadge").textContent(),"1 / 2");
  assert.strictEqual(await page.locator("#previousViewBtn").isDisabled(),true);
  assert.strictEqual(await page.locator("#nextViewBtn").isEnabled(),true);
  await page.locator('#channelTabs button[data-channel="dapi"]').click();
  await page.locator("#nextViewBtn").click();
  await page.waitForFunction(()=>document.querySelector("#currentViewLabel").textContent==="Overlay002");
  assert.strictEqual(await page.locator("#viewPositionBadge").textContent(),"2 / 2");
  assert.strictEqual(await page.locator('#channelTabs button[data-channel="dapi"]').getAttribute("class"),"active");
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(()=>document.querySelector("#currentViewLabel").textContent==="Overlay001");
  assert.strictEqual(await page.evaluate(()=>state.channel),"dapi");
  assert.strictEqual(await page.locator("#ringRadiusUm").inputValue(),"2");
  assert.strictEqual(await page.locator("#signalMadMultiplier").inputValue(),"3");
  if(process.env.CELLSCOPE_WORKFLOW_SCREENSHOT)await page.screenshot({path:process.env.CELLSCOPE_WORKFLOW_SCREENSHOT,fullPage:true});
  await page.locator("#compareBtn").click();
  await page.locator("#compareDialog:not(.hidden)").waitFor();
  assert.strictEqual(await page.locator("#compareLeftView option").count(), 3);
  assert.strictEqual(await page.locator("#compareRightView option").count(), 3);
  await page.waitForFunction(()=>document.querySelector("#compareLeftImage").width===1);
  assert.match(await page.locator("#compareLeftStats").textContent(), /DAPI 0/);
  assert.match(await page.locator("#compareRightStats").textContent(), /肿瘤 0/);
  await page.locator("#compareLeftChannel").selectOption("nk");
  assert.strictEqual(await page.locator("#compareLeftChannel").inputValue(), "nk");
  const before=await page.locator("#compareRightStage").evaluate(node=>node.style.transform);
  await page.locator("#compareLeftViewer").dispatchEvent("wheel",{deltaY:-100,clientX:250,clientY:250});
  const after=await page.locator("#compareRightStage").evaluate(node=>node.style.transform);
  assert.notStrictEqual(after,before);
  const decodeFailure=await page.evaluate(async()=>{
    const pane=compareState.left,view=viewById(pane.viewId),original=view.files.nk;
    try{
      view.files.nk=new File(["not an image"],"broken.png",{type:"image/png"});
      await renderCompareSide("left",false);
      return{
        raw:pane.raw,
        stage:compareNode("left","Stage").style.display,
        stats:compareNode("left","Stats").textContent,
        error:compareNode("left","Empty").textContent,
      };
    }finally{view.files.nk=original;}
  });
  assert.deepStrictEqual({...decodeFailure,error:undefined},{raw:null,stage:"none",stats:"",error:undefined});
  assert.match(decodeFailure.error,/^读取失败：/);
  const partialViewValue=await page.locator("#compareLeftView option").evaluateAll(options=>options.find(option=>option.textContent.includes("Image006")).value);
  await page.locator("#compareLeftView").selectOption(partialViewValue);
  await page.locator("#compareLeftChannel").selectOption("nk");
  await page.waitForFunction(()=>document.querySelector("#compareLeftEmpty").textContent.includes("缺少"));
  assert.strictEqual(await page.locator("#compareLeftStats").textContent(),"");
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
  await page.evaluate(()=>{
    const view=viewById(state.currentViewId),groupParams=state.project.parameters_by_group[view.group];
    groupParams.nk.analysis_mode="nucleus_guided";
    groupParams.tumor.analysis_mode="particles";
    state.project.results[state.currentViewId].nk={status:"done",error:"",detections:[],parameters:{analysis_mode:"particles"}};
    state.project.results[state.currentViewId].tumor={status:"done",error:"",detections:[],parameters:{analysis_mode:"nucleus_guided"}};
    updateCounts();renderResults();
  });
  assert.strictEqual(await page.locator("#resultHeaderDapiMinusNk").textContent(),"DAPI-效应细胞");
  await page.evaluate(()=>{
    state.detections[0].deleted=false;
    syncCorrections();
  });
  assert.deepStrictEqual(await page.evaluate(()=>({
    dapi:targetStatus(state.currentViewId,"dapi"),
    nk:targetStatus(state.currentViewId,"nk"),
    tumor:targetStatus(state.currentViewId,"tumor"),
  })),{dapi:"done",nk:"done",tumor:"pending"});
  assert.deepStrictEqual(await page.evaluate(async()=>{
    const view=viewById(state.currentViewId),groupParams=state.project.parameters_by_group[view.group];
    groupParams.nk.analysis_mode="particles";
    groupParams.tumor.analysis_mode="nucleus_guided";
    state.project.results[view.id]={
      dapi:{status:"done",error:"",detections:[{id:"dapi-before",x:1,y:1,radius:1,classification:"dapi",manual:false,deleted:false}]},
      nk:{status:"done",error:"",detections:[{id:"nk-before"}],parameters:{analysis_mode:"nucleus_guided"}},
      tumor:{status:"done",error:"",detections:[{id:"tumor-before"}],parameters:{analysis_mode:"particles"}},
    };
    const originalAnalyzeOne=analyzeOne,originalConfirm=window.confirm;
    window.confirm=()=>true;
    analyzeOne=async()=>{state.cancelled=true;throw new Error("__cancelled__");};
    try{await analyzeScope("current");}
    finally{analyzeOne=originalAnalyzeOne;window.confirm=originalConfirm;}
    return Object.fromEntries(["dapi","nk","tumor"].map(target=>[
      target,{status:targetStatus(view.id,target),id:targetResult(view.id,target).detections[0].id}
    ]));
  }),{
    dapi:{status:"done",id:"dapi-before"},
    nk:{status:"done",id:"nk-before"},
    tumor:{status:"done",id:"tumor-before"},
  });
  assert.strictEqual(await page.locator(".view-item.active .status-dot").getAttribute("class"),"status-dot done");
  assert.match(await page.locator("#resultsBody tr").filter({hasText:"实验组A / Overlay001"}).locator("td:last-child").textContent(),/DAPI ✓.*效应细胞 ✓.*肿瘤 ✓/);
  await page.evaluate(()=>{
    state.project.results[state.currentViewId].nk={status:"done",error:"",detections:[]};
    state.project.results[state.currentViewId].tumor={status:"done",error:"",detections:[]};
    const partialView=state.project.views.find(view=>view.name==="Image006");
    state.project.results[partialView.id]={dapi:{status:"done",error:"",detections:[]}};
    refreshViewError(viewById(state.currentViewId));updateCounts();renderResults();
  });
  assert.strictEqual(await page.evaluate(()=>"cic_learning" in serializableProject()),false);
  assert.strictEqual(await page.evaluate(()=>Object.values(serializableProject().results).every(result=>!("cic" in result))),true);
  assert.strictEqual(await page.evaluate(()=>exportRunStamp(new Date(2026,7,30,1,2,3,4))),"20260830-010203004");
  const zipDownload=page.waitForEvent("download");
  await page.evaluate(()=>Object.defineProperty(window,"showDirectoryPicker",{
    configurable:true,value:async()=>({
      async getDirectoryHandle(){throw new DOMException("The request is not allowed by the user agent or the platform in the current context.","NotAllowedError");}
    })
  }));
  await page.locator("#exportBtn").click();
  const downloadedZip=await zipDownload;
  const downloadedZipPath=await downloadedZip.path();
  const zipBytes=fs.readFileSync(downloadedZipPath);
  assert.match(downloadedZip.suggestedFilename(),/_cell-count-results\.zip$/);
  assert.strictEqual(zipBytes.readUInt32LE(0),0x04034b50);
  assert(zipBytes.includes(Buffer.from("全部文件夹汇总.csv")));
  assert(zipBytes.includes(Buffer.from("标注图清单.csv")));
  assert(zipBytes.includes(Buffer.from("DAPI-效应细胞")));
  assert(zipBytes.includes(Buffer.from("Overlay001__DAPI__ch02__")));
  assert(zipBytes.includes(Buffer.from("Overlay001__效应细胞__ch01__")));
  assert(zipBytes.includes(Buffer.from("Overlay001__肿瘤__ch00__")));
  assert(zipBytes.includes(Buffer.from("Image006__DAPI__ch00__")));
  assert(zipBytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]))>0);
  await page.waitForFunction(()=>!state.busy);
  assert.match(await page.locator("#toast").textContent(),/已下载 ZIP/);
  if(process.env.CELLSCOPE_REAL_FOLDER){
    const realPage=await browser.newPage({viewport:{width:1500,height:900}});
    realPage.setDefaultTimeout(60000);
    await realPage.goto(`http://127.0.0.1:${server.address().port}/`);
    await realPage.evaluate(()=>indexedDB.deleteDatabase("cellscope-projects"));
    await realPage.locator("#folderInput").setInputFiles(process.env.CELLSCOPE_REAL_FOLDER);
    await realPage.waitForFunction(()=>state.project?.views?.length>0);
    await realPage.waitForFunction(()=>document.querySelector("#channelMappingTitle").textContent!=="正在检查通道顺序");
    const mappingAudit=await realPage.evaluate(()=>({
      views:state.project.views.length,
      mappings:[...new Set(state.project.views.map(view=>JSON.stringify(view.channel_mapping)))],
      sources:[...new Set(state.project.views.map(view=>view.channel_mapping_source))],
      files:state.project.views.slice(0,2).map(view=>view.fileNames),
      pixelsByGroup:Object.fromEntries(state.project.groups.map(group=>[
        group,[...new Set(state.project.views.filter(view=>view.group===group).map(view=>Number(view.pixel_size_um.toFixed(3))))].sort()
      ])),
      title:document.querySelector("#channelMappingTitle").textContent,
      detail:document.querySelector("#channelMappingDetail").textContent,
      partial:(()=>{const view=state.project.views.find(item=>item.group.includes("CMA+DCI 0.3")&&item.name==="Image006");return view?{mapping:view.channel_mapping,fileNames:view.fileNames,error:view.error,source:view.channel_mapping_source}:null;})(),
    }));
    assert.deepStrictEqual(mappingAudit.sources,["leica_xml"]);
    const folderName=path.basename(process.env.CELLSCOPE_REAL_FOLDER);
    if(folderName==="20260801"){
      assert.strictEqual(mappingAudit.views,20);
      assert(mappingAudit.files.every(files=>/_ch02\.(tif|jpg)$/i.test(files.dapi)&&/_ch01\.(tif|jpg)$/i.test(files.nk)&&/_ch00\.(tif|jpg)$/i.test(files.tumor)));
      assert.deepStrictEqual(mappingAudit.pixelsByGroup["0"],[0.218]);
      assert.deepStrictEqual(mappingAudit.pixelsByGroup["0.1"],[0.218,0.436]);
    }else if(folderName==="20260830"){
      assert.strictEqual(mappingAudit.views,57);
      assert(mappingAudit.partial);
      assert.deepStrictEqual(mappingAudit.partial.mapping,{dapi:"_ch00"});
      assert.match(mappingAudit.partial.fileNames.dapi,/Image006_ch00\.tif$/i);
      assert.strictEqual(mappingAudit.partial.fileNames.nk,"");
      assert.match(mappingAudit.partial.error,/缺少绿色.*缺少红色/);
    }else assert(mappingAudit.views>0);
    if(process.env.CELLSCOPE_REAL_ANALYZE){
      realPage.setDefaultTimeout(240000);
      await realPage.locator('#channelTabs button[data-channel="dapi"]').click();
      await realPage.locator("#analyzeCurrentBtn").click();
      await realPage.waitForFunction(()=>!state.busy&&targetStatus(state.currentViewId,"dapi")==="done");
      await realPage.locator('#channelTabs button[data-channel="nk"]').click();
      await realPage.locator("#analyzeCurrentBtn").click();
      await realPage.waitForFunction(()=>!state.busy&&targetStatus(state.currentViewId,"nk")==="done");
      await realPage.locator('#channelTabs button[data-channel="tumor"]').click();
      await realPage.locator("#analyzeCurrentBtn").click();
      await realPage.waitForFunction(()=>!state.busy&&targetStatus(state.currentViewId,"tumor")==="done");
      const guidedAudit=await realPage.evaluate(()=>{
        const dapi=targetResult(state.currentViewId,"dapi").detections.filter(item=>!item.deleted);
        const nk=targetResult(state.currentViewId,"nk").detections.filter(item=>!item.deleted);
        const tumor=targetResult(state.currentViewId,"tumor").detections.filter(item=>!item.deleted);
        const ids=new Set(dapi.map(item=>item.id));
        return{dapi:dapi.length,nk:nk.length,tumor:tumor.length,allAnchored:[...nk,...tumor].every(item=>ids.has(item.id)&&item.display_label!=null&&item.signal_runs?.length)};
      });
      assert(guidedAudit.dapi>0);assert(guidedAudit.allAnchored);
      console.log("real guided analysis audit",guidedAudit);
    }
    if(process.env.CELLSCOPE_CHANNEL_SCREENSHOT)await realPage.screenshot({path:process.env.CELLSCOPE_CHANNEL_SCREENSHOT,fullPage:true});
    console.log("real folder channel audit",mappingAudit);
    await realPage.close();
  }
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
