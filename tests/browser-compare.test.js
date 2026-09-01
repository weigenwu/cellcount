const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { chromium } = require("playwright");
const learning = require(path.join(__dirname,"..","browser-learning.js"));

const root = path.resolve(__dirname, "..");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
function storedZipEntries(bytes) {
  const entries=new Map();let offset=0;
  while(offset+30<=bytes.length&&bytes.readUInt32LE(offset)===0x04034b50){
    assert.strictEqual(bytes.readUInt16LE(offset+8),0,"test parser only supports stored ZIP entries");
    const size=bytes.readUInt32LE(offset+18),nameLength=bytes.readUInt16LE(offset+26),extraLength=bytes.readUInt16LE(offset+28);
    const nameStart=offset+30,dataStart=nameStart+nameLength+extraLength;
    entries.set(bytes.subarray(nameStart,nameStart+nameLength).toString("utf8"),bytes.subarray(dataStart,dataStart+size));
    offset=dataStart+size;
  }
  return entries;
}
function verifyCellCountWorkbook(bytes) {
  assert.strictEqual(bytes.readUInt32LE(0),0x04034b50);
  const entries=storedZipEntries(bytes);
  for(const name of ["[Content_Types].xml","_rels/.rels","xl/workbook.xml","xl/_rels/workbook.xml.rels","xl/styles.xml"]){
    assert(entries.has(name),`missing ${name}`);
  }
  const workbook=entries.get("xl/workbook.xml").toString("utf8"),styles=entries.get("xl/styles.xml").toString("utf8");
  for(const name of ["汇总","说明","实验组A","单通道组"])assert(workbook.includes(`name="${name}"`));
  assert.strictEqual(/patternType="solid"|<fgColor/i.test(styles),false);
  assert.match(styles,/<fills count="2"><fill><patternFill patternType="none"\/><\/fill><fill><patternFill patternType="gray125"\/><\/fill><\/fills>/);
  const sheets=[...entries].filter(([name])=>/^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(([,value])=>value.toString("utf8"));
  assert(sheets.some(xml=>xml.includes("效应细胞")&&xml.includes("Overlay001")));
  assert(sheets.some(xml=>xml.includes("错误/QC")));
  assert(sheets.some(xml=>/<f>S6-C6<\/f><v>-?\d+(?:\.\d+)?<\/v>/.test(xml)),"missing formula with cached value");
  const partial=sheets.find(xml=>xml.includes("Image006"));assert(partial);
  const imageRow=partial.match(/<row r="6"[^>]*>([\s\S]*?)<\/row>/)?.[1]||"";
  assert(imageRow.includes('r="A6"'));assert(imageRow.includes('r="B6"'));
  assert.strictEqual(/r="[CDE]6"/.test(imageRow),false);
  return entries;
}
function verifyLocalLearning() {
  const key="test:nk";learning.clearProfile(key);
  for(let index=0;index<4;index++){
    learning.record(key,{area_px:900+index,circularity:.85,positive_fraction:.7,signal_mad:2,nuclei_per_cell:1},"positive");
    learning.record(key,{area_px:90+index,circularity:.12,positive_fraction:.04,signal_mad:20,nuclei_per_cell:1},"negative");
  }
  assert.strictEqual(learning.stats(key).trained,true);
  const candidate={classification:"nk",learning_label:"positive",area_px:92,circularity:.12,positive_fraction:.04,signal_mad:20,nuclei_per_cell:1,review_reasons:[]};
  learning.apply(key,[candidate]);
  assert.strictEqual(candidate.review_required,true);
  assert(candidate.review_reasons.includes("learned_mismatch"));
  const exported=learning.exportData();learning.clearProfile(key);assert.strictEqual(learning.stats(key).total,0);
  learning.importData(exported,{replace:true});assert.strictEqual(learning.stats(key).trained,true);
  learning.clearProfile(key);
}
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

function verifyParticleCalibrationParameters() {
  const values=Uint8Array.from([10,10,100,100]);
  const legacy=workerContext.thresholdMask(values,{threshold_mode:"auto"});
  const explicitDefaults=workerContext.thresholdMask(values,{threshold_mode:"auto",auto_threshold_factor:1});
  assert.deepStrictEqual([...legacy],[...explicitDefaults],"missing factor must preserve the old Otsu result");
  assert.deepStrictEqual(
    [...workerContext.thresholdMask(values,{threshold_mode:"auto",auto_threshold_factor:1.5})],
    [0,0,1,1],"raising the factor should reject pixels between the old and adjusted thresholds"
  );

  const params={min_area_px:1,max_area_px:100,min_circularity:0,max_circularity:1};
  const square=new Int32Array(25);
  for(let y=1;y<=2;y++)for(let x=1;x<=2;x++)square[y*5+x]=1;
  const squareDetection=workerContext.regionDetections(square,5,5,params)[0];
  assert.strictEqual(squareDetection.solidity,1);
  const concave=new Int32Array(25);
  for(const [x,y] of [[0,0],[0,1],[0,2],[1,2],[2,2]])concave[y*5+x]=1;
  const concaveDetection=workerContext.regionDetections(concave,5,5,params)[0];
  assert(concaveDetection.solidity<.9&&concaveDetection.solidity>0);
  assert.strictEqual(workerContext.regionDetections(concave,5,5,{...params,min_solidity:.9}).length,0);
  assert.strictEqual(workerContext.regionDetections(concave,5,5,{...params,min_solidity:0}).length,1);
}

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
  assert.strictEqual(result.result_kind,"cell_instances_v1");
  assert.strictEqual(result.detections.length,1);
  assert.strictEqual(result.detections[0].id,"nk-cell-1");
  assert.strictEqual(result.detections[0].cell_instance_id,"nk-cell-1");
  assert.strictEqual(result.detections[0].object_type,"marker_cell_instance");
  assert.deepStrictEqual([...result.detections[0].nucleus_ids],["auto-7"]);
  assert.strictEqual(result.detections[0].nuclei_per_cell,1);
  assert.strictEqual(result.detections[0].display_label,1);
  assert.strictEqual(result.detections[0].ring_radius_px_resolved,4);
  assert(result.detections[0].signal_runs.length>0);
  assert(result.detections[0].area_px>=16);

  const continuous=new Uint8Array(width*height).fill(20);
  for(let y=22;y<=28;y++)for(let x=15;x<=34;x++)continuous[y*width+x]=110;
  workerContext.decode=async()=>({data:continuous,width,height});
  const joined=await workerContext.analyze({
    type:"analyze",target:"tumor",targetLabel:"肿瘤",channelBuffer:new ArrayBuffer(0),channelExtension:".png",
    anchorDetections:nuclei,pixelSizeUm:.5,
    params:{analysis_mode:"nucleus_guided",ring_radius_um:2,ring_radius_px:99,signal_threshold:10,signal_mad_multiplier:3,min_signal_block_um2:1,positive_fraction:.02,max_area_px:20000},
  });
  assert.strictEqual(joined.result_kind,"cell_instances_v1");
  assert.strictEqual(joined.detections.length,1,"continuous marker signal should form one cell instance");
  assert.strictEqual(joined.detections[0].id,"tumor-cell-1");
  assert.deepStrictEqual([...joined.detections[0].nucleus_ids],["auto-7","auto-8"]);
  assert.strictEqual(joined.detections[0].nuclei_per_cell,2);
  assert.strictEqual(joined.detections[0].review_required,true);
  assert(joined.detections[0].review_reasons.includes("multinucleated"));
  assert(joined.detections[0].runs.length>0);
  assert(joined.detections[0].x>20&&joined.detections[0].x<29);

  const separated=new Uint8Array(width*height).fill(20);
  for(let y=22;y<=28;y++)for(let x=16;x<=22;x++)separated[y*width+x]=110;
  for(let y=22;y<=28;y++)for(let x=27;x<=33;x++)separated[y*width+x]=110;
  workerContext.decode=async()=>({data:separated,width,height});
  const split=await workerContext.analyze({
    type:"analyze",target:"nk",targetLabel:"NK",channelBuffer:new ArrayBuffer(0),channelExtension:".png",
    anchorDetections:nuclei,pixelSizeUm:.5,
    params:{analysis_mode:"nucleus_guided",ring_radius_um:2,ring_radius_px:99,signal_threshold:10,signal_mad_multiplier:3,min_signal_block_um2:1,positive_fraction:.02,max_area_px:20000},
  });
  assert.strictEqual(split.detections.length,2,"separated marker signals should remain two cell instances");
  assert.deepStrictEqual([...split.detections].map(detection=>detection.nuclei_per_cell),[1,1]);
  assert(split.detections.every(detection=>detection.object_type==="marker_cell_instance"));

  const conservativeInstances=(centres,pixelSizeUm=.218)=>workerContext.markerCellInstances(
    centres.map((x,index)=>({
      nucleus:{id:`n${index+1}`,display_label:index+1,x,y:5,radius:4,area_px:50,manual:false},
      signal:{runs:[5,2,140],fraction:.5,background:20,mad:1,threshold:30,delta:10,
        autoThreshold:0,userMinimum:10,madThreshold:3,ringRadiusPx:4,areaPx:139},
    })),150,20,"nk",{max_area_px:20000},pixelSizeUm
  );
  const nearPair=conservativeInstances([10,65]);
  assert.strictEqual(nearPair.length,1,"two nuclei at 55 reference pixels should merge");
  assert.strictEqual(nearPair[0].nuclei_per_cell,2);
  assert.strictEqual(nearPair[0].source_group_nucleus_count,2);
  const farPair=conservativeInstances([10,66]);
  assert.strictEqual(farPair.length,2,"two nuclei beyond 55 reference pixels should split");
  assert(farPair.every(item=>item.nuclei_per_cell===1&&item.source_group_nucleus_count===2));
  assert(farPair.every(item=>item.review_required&&item.review_reasons.includes("crowded")));
  assert(farPair.every(item=>JSON.stringify(item.runs)===JSON.stringify([5,2,140])));
  const nearTriple=conservativeInstances([10,40,80]);
  assert.strictEqual(nearTriple.length,1,"three nuclei within a 70 reference-pixel diameter should merge");
  assert.strictEqual(nearTriple[0].nuclei_per_cell,3);
  const farTriple=conservativeInstances([10,45,81]);
  assert.strictEqual(farTriple.length,3,"a three-nucleus group wider than 70 reference pixels should split");
  assert(farTriple.every(item=>item.source_group_nucleus_count===3&&item.review_reasons.includes("crowded")));
  const fourNuclei=conservativeInstances([10,20,30,40]);
  assert.strictEqual(fourNuclei.length,4,"four connected nuclei should always split for review");
  assert.strictEqual(new Set(fourNuclei.map(item=>item.cell_instance_id)).size,4);
  assert(fourNuclei.every(item=>item.source_group_nucleus_count===4&&item.review_reasons.includes("crowded")));
  assert.strictEqual(conservativeInstances([10,37],.436).length,1,"physical merge distance should scale with pixel size");
  assert.strictEqual(conservativeInstances([10,38],.436).length,2,"physical split distance should scale with pixel size");

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

  const adaptiveWidth=100,adaptiveHeight=60,adaptiveSignal=new Uint8Array(adaptiveWidth*adaptiveHeight).fill(20);
  const adaptiveNuclei=[
    {id:"weak",x:22,y:30,radius:4,area_px:50,circularity:.9,manual:false,deleted:false},
    {id:"strong",x:72,y:30,radius:4,area_px:50,circularity:.9,manual:false,deleted:false},
  ];
  for(let y=0;y<adaptiveHeight;y++)for(let x=0;x<adaptiveWidth;x++){
    const weakDistance=(x-22)**2+(y-30)**2,strongDistance=(x-72)**2+(y-30)**2;
    if(weakDistance<=6**2)adaptiveSignal[y*adaptiveWidth+x]=32;
    if(strongDistance<=5**2)adaptiveSignal[y*adaptiveWidth+x]=100;
  }
  workerContext.decode=async()=>({data:adaptiveSignal,width:adaptiveWidth,height:adaptiveHeight});
  const adaptiveParams={analysis_mode:"nucleus_guided",ring_radius_um:2,signal_threshold:10,
    signal_mad_multiplier:0,min_signal_block_um2:1,positive_fraction:.02,max_area_px:20000};
  const manualThreshold=await workerContext.analyze({
    type:"analyze",target:"nk",targetLabel:"NK",channelBuffer:new ArrayBuffer(0),channelExtension:".png",
    anchorDetections:adaptiveNuclei,pixelSizeUm:.5,params:adaptiveParams,
  });
  assert.strictEqual(manualThreshold.detections.length,2,"legacy/manual threshold should keep both signals");
  assert.strictEqual(manualThreshold.resolved_signal_threshold,null);
  const automaticThreshold=await workerContext.analyze({
    type:"analyze",target:"nk",targetLabel:"NK",channelBuffer:new ArrayBuffer(0),channelExtension:".png",
    anchorDetections:adaptiveNuclei,pixelSizeUm:.5,params:{...adaptiveParams,signal_threshold_mode:"auto"},
  });
  assert.strictEqual(automaticThreshold.detections.length,1,"auto residual threshold should remove diffuse weak signal");
  assert.deepStrictEqual([...automaticThreshold.detections[0].nucleus_ids],["strong"]);
  assert(automaticThreshold.resolved_signal_threshold>12);
  assert.strictEqual(automaticThreshold.detections[0].auto_signal_threshold,automaticThreshold.resolved_signal_threshold);
  assert.strictEqual(automaticThreshold.detections[0].resolved_signal_threshold,automaticThreshold.resolved_signal_threshold);

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
  verifyLocalLearning();
  verifyParticleCalibrationParameters();
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
  assert.deepStrictEqual(await page.evaluate(()=>{
    const original={views:state.project.views,groups:state.project.groups,results:state.project.results};
    const makeView=(group,name)=>({id:`${group}/${name}`,group,name,files:{},fileNames:{},channel_mapping:{},channel_mapping_source:"test"});
    const makeResult=count=>({
      status:"done",error:"",result_kind:"nuclei_v1",
      detections:[...Array.from({length:count},(_,index)=>({id:`n-${index}`,deleted:false})),{id:"deleted",deleted:true}],
    });
    const lowGroup="QC低计数组",normalGroup="QC正常组",shortGroup="QC不足组";
    const lowViews=["低","正常1","正常2","正常3"].map(name=>makeView(lowGroup,name));
    const normalViews=["正常1","正常2","正常3","正常4"].map(name=>makeView(normalGroup,name));
    const shortViews=["短1","短2","短3"].map(name=>makeView(shortGroup,name));
    let output;
    try{
      state.project.views=[...original.views,...lowViews,...normalViews,...shortViews];
      state.project.groups=[...original.groups,lowGroup,normalGroup,shortGroup];
      state.project.results={...original.results};
      [40,98,100,102].forEach((count,index)=>state.project.results[lowViews[index].id]={dapi:makeResult(count)});
      [90,100,100,110].forEach((count,index)=>state.project.results[normalViews[index].id]={dapi:makeResult(count)});
      [100,40,100].forEach((count,index)=>state.project.results[shortViews[index].id]={dapi:makeResult(count)});
      const lowOutliers=refreshDapiGroupQc(lowGroup),normalOutliers=refreshDapiGroupQc(normalGroup);
      refreshDapiGroupQc(shortGroup);renderResults();
      const lowResult=targetResult(lowViews[0].id,"dapi"),sameGroupNormal=targetResult(lowViews[1].id,"dapi");
      const shortResult=targetResult(shortViews[1].id,"dapi"),record=xlsxResultRecord(lowViews[0]);
      const row=[...document.querySelectorAll("#resultsBody tr")].find(item=>item.textContent.includes(`${lowGroup} / 低`));
      output={
        lowOutliers:lowOutliers.map(view=>view.name),normalOutliers:normalOutliers.length,
        lowFlags:lowResult.qc_flags,lowRatio:lowResult.qc_ratio,lowMessage:lowResult.qc_message,
        sameGroupNormalFlags:sameGroupNormal.qc_flags,
        shortMarked:["qc_flags","qc_message","qc_ratio"].some(key=>Object.hasOwn(shortResult,key)),
        statusText:row.lastElementChild.textContent,statusTitle:row.lastElementChild.title,statusClass:row.lastElementChild.className,
        viewError:lowViews[0].error||"",excelIssue:record.issue,excelIssueText:viewIssueText(lowViews[0]),
        jsonFlags:serializableProject().results[lowViews[0].id].dapi.qc_flags,
      };
    }finally{
      state.project.views=original.views;state.project.groups=original.groups;state.project.results=original.results;renderResults();
    }
    return output;
  }),{
    lowOutliers:["低"],normalOutliers:0,lowFlags:["dapi_group_outlier"],lowRatio:.404,
    lowMessage:"DAPI有效计数 40，比同组中位数 99 低 60%（阈值 30%）",sameGroupNormalFlags:[],shortMarked:false,
    statusText:"DAPI ✓ · NK — · 肿瘤 — · DAPI异常⚠",statusTitle:"DAPI有效计数 40，比同组中位数 99 低 60%（阈值 30%）",
    statusClass:"status-partial",viewError:"",excelIssue:true,
    excelIssueText:"DAPI有效计数 40，比同组中位数 99 低 60%（阈值 30%）",jsonFlags:["dapi_group_outlier"],
  });
  assert.match(await page.locator("#learningStatus").textContent(),/正确 0.*误识别 0/);
  assert.deepStrictEqual(await page.evaluate(()=>{
    const original=collectParameters();
    $("autoThresholdFactor").value="1.15";$("minSolidity").value="0.75";
    const changed=collectParameters();populateParameters(original);
    return{
      defaults:[original.auto_threshold_factor,original.min_solidity],
      changed:[changed.auto_threshold_factor,changed.min_solidity],
      restored:[$("autoThresholdFactor").value,$("minSolidity").value],
    };
  }),{defaults:[1,0],changed:[1.15,.75],restored:["1","0"]});
  assert.deepStrictEqual(await page.evaluate(()=>{
    const group=state.project.groups[0],saved=serializableProject();
    const fingerprint=saved.views.find(view=>view.name==="Overlay001").file_fingerprints.dapi;
    saved.version=4;saved.results={};
    for(const target of TARGETS){
      delete saved.parameters_by_group[group][target].signal_threshold_mode;
      delete saved.parameters_by_group[group][target].auto_threshold_factor;
      delete saved.parameters_by_group[group][target].min_solidity;
    }
    state.pendingProject=saved;mergePendingProject();
    return{
      projectVersion:serializableProject().version,
      newMode:defaultParams("nk").signal_threshold_mode,
      migratedMode:state.project.parameters_by_group[group].nk.signal_threshold_mode,
      newFactor:defaultParams("dapi").auto_threshold_factor,
      migratedFactor:state.project.parameters_by_group[group].dapi.auto_threshold_factor,
      newSolidity:defaultParams("dapi").min_solidity,
      migratedSolidity:state.project.parameters_by_group[group].dapi.min_solidity,
      fingerprintKeys:Object.keys(fingerprint).sort(),fingerprintName:fingerprint.name,
    };
  }),{
    projectVersion:6,newMode:"auto",migratedMode:"manual",
    newFactor:1,migratedFactor:1,newSolidity:0,migratedSolidity:0,
    fingerprintKeys:["lastModified","name","size"],fingerprintName:"Overlay001_ch02.png",
  });
  assert.deepStrictEqual(await page.evaluate(()=>{
    const view=state.project.views.find(item=>item.name==="Overlay002");
    const makeSaved=()=>{
      const saved=serializableProject();
      saved.results={
        [view.id]:{dapi:{status:"done",error:"",detections:[{id:"saved-dapi",x:1,y:1,manual:true,deleted:false}]}}
      };
      return saved;
    };
    delete state.project.results[view.id];
    const legacy=makeSaved();delete legacy.views.find(item=>item.id===view.id).file_fingerprints;
    state.pendingProject=legacy;mergePendingProject();
    const legacyRestored=Boolean(state.project.results[view.id]);
    delete state.project.results[view.id];
    const changed=makeSaved();changed.views.find(item=>item.id===view.id).file_fingerprints.dapi.size++;
    state.pendingProject=changed;mergePendingProject();
    const changedRestored=Boolean(state.project.results[view.id]);
    delete state.project.results[view.id];
    return{legacyRestored,changedRestored};
  }),{legacyRestored:true,changedRestored:false});
  assert.deepStrictEqual(await page.evaluate(async()=>{
    const originalDecode=decodeRgba,originalChannel=state.channel,view=viewById(state.currentViewId),pending={};
    let output;
    decodeRgba=file=>new Promise(resolve=>{pending[file.name]=resolve;});
    try{
      state.channel="dapi";const first=showImage();
      state.channel="nk";const second=showImage();
      pending[view.files.nk.name]({rgba:new Uint8ClampedArray([0,255,0,255]),width:1,height:1});
      await second;
      pending[view.files.dapi.name]({rgba:new Uint8ClampedArray([0,0,255,255]),width:1,height:1});
      await first;
      output={channel:state.channel,rgba:Array.from(state.rawImage.rgba)};
    }finally{
      decodeRgba=originalDecode;state.channel=originalChannel;await showImage();
    }
    return output;
  }),{channel:"nk",rgba:[0,255,0,255]});
  assert.deepStrictEqual(await page.evaluate(()=>({
    preferred:detectionRuns({runs:[1,2,3],signal_runs:[4,5,6]}),
    inferred:(()=>{
      const view=viewById(state.currentViewId),previous=state.project.results[view.id];
      state.project.results[view.id]={
        dapi:{status:"done",result_kind:"nuclei_v1",detections:["a","b","c"].map((id,index)=>({id,x:index,y:0,classification:"dapi",deleted:false}))},
        nk:{status:"done",result_kind:"cell_instances_v1",detections:[{id:"nk-cell-1",classification:"nk",nucleus_ids:["a","b"],review_required:true,deleted:false}]},
        tumor:{status:"done",result_kind:"cell_instances_v1",detections:[]},
      };
      const counts=viewCounts(view.id);
      state.project.results[view.id]={
        dapi:{status:"done",result_kind:"nuclei_v1",detections:[["a",0],["b",40],["c",80]].map(([id,x])=>({id,x,y:0,classification:"dapi",deleted:false}))},
        nk:{status:"done",result_kind:"cell_instances_v1",detections:[{nucleus_ids:["a","b"],deleted:false}]},
        tumor:{status:"done",result_kind:"cell_instances_v1",detections:[{nucleus_ids:["b","c"],deleted:false}]},
      };
      const farChain=inferredDapiCellCount(view.id);
      state.project.results[view.id].dapi.detections[1].x=35;
      state.project.results[view.id].dapi.detections[2].x=70;
      const nearChain=inferredDapiCellCount(view.id);
      if(previous)state.project.results[view.id]=previous;else delete state.project.results[view.id];
      return{nuclei:counts.dapi.total,cells:counts.dapi.cells,review:counts.nk.review,farChain,nearChain};
    })(),
  })),{preferred:[1,2,3],inferred:{nuclei:3,cells:2,review:1,farChain:3,nearChain:1}});
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
  assert.match(await page.locator("#compareLeftStats").textContent(), /DAPI核 0/);
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
  assert.deepStrictEqual(await page.evaluate(()=>{
    const view=viewById(state.currentViewId);
    state.project.results[view.id]={
      dapi:{status:"done",error:"",detections:[{id:"review-dapi",x:1,y:1,radius:1,classification:"dapi",review_required:true,manual:false,deleted:false}]},
      nk:{status:"done",error:"",detections:[{id:"keep-nk"}],parameters:{analysis_mode:"nucleus_guided"}},
      tumor:{status:"done",error:"",detections:[{id:"keep-tumor"}],parameters:{analysis_mode:"nucleus_guided"}},
    };
    state.target="dapi";state.detections=state.project.results[view.id].dapi.detections;state.selectedId="review-dapi";
    confirmSelectedDetection();
    return{
      reviewed:state.detections[0].reviewed,
      dapi:targetStatus(view.id,"dapi"),nk:targetStatus(view.id,"nk"),tumor:targetStatus(view.id,"tumor"),
      nkId:targetResult(view.id,"nk").detections[0].id,tumorId:targetResult(view.id,"tumor").detections[0].id,
    };
  }),{reviewed:true,dapi:"done",nk:"done",tumor:"done",nkId:"keep-nk",tumorId:"keep-tumor"});
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
  assert.strictEqual(await page.locator("#resultHeaderDapiMinusNk").textContent(),"DAPI细胞-效应细胞");
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
  assert.deepStrictEqual(await page.evaluate(async()=>{
    const view=viewById(state.currentViewId);
    state.target="dapi";
    state.project.results[view.id]={
      dapi:{status:"done",error:"",detections:[{id:"manual-dapi",x:2,y:3,radius:2,classification:"dapi",manual:true,deleted:false}]},
      nk:{status:"done",error:"",detections:[{id:"guided-nk"}],parameters:{analysis_mode:"nucleus_guided"}},
      tumor:{status:"done",error:"",detections:[{id:"guided-tumor"}],parameters:{analysis_mode:"nucleus_guided"}},
    };
    state.detections=state.project.results[view.id].dapi.detections;
    const originalAnalyzeOne=analyzeOne,originalConfirm=window.confirm;
    window.confirm=()=>true;analyzeOne=async()=>{throw new Error("synthetic analysis failure");};
    try{await analyzeScope("current");}
    finally{analyzeOne=originalAnalyzeOne;window.confirm=originalConfirm;}
    return{
      dapi:{status:targetStatus(view.id,"dapi"),id:targetResult(view.id,"dapi").detections[0].id,manual:targetResult(view.id,"dapi").detections[0].manual},
      nk:targetResult(view.id,"nk").detections[0].id,tumor:targetResult(view.id,"tumor").detections[0].id,
      error:targetResult(view.id,"dapi").error,viewError:view.error,
    };
  }),{
    dapi:{status:"done",id:"manual-dapi",manual:true},nk:"guided-nk",tumor:"guided-tumor",
    error:"synthetic analysis failure",viewError:"DAPI：synthetic analysis failure",
  });
  assert.match(await page.locator("#toast").textContent(),/1 个视野失败.*保留旧结果/);
  assert.strictEqual(await page.locator(".view-item.active .status-dot").getAttribute("class"),"status-dot done");
  assert.match(await page.locator("#resultsBody tr").filter({hasText:"实验组A / Overlay001"}).locator("td:last-child").textContent(),/DAPI ✓.*效应细胞 ✓.*肿瘤 ✓/);
  await page.evaluate(()=>{
    state.project.results[state.currentViewId].nk={status:"done",error:"",result_kind:"cell_instances_v1",detections:[]};
    state.project.results[state.currentViewId].tumor={status:"done",error:"",result_kind:"cell_instances_v1",detections:[]};
    const partialView=state.project.views.find(view=>view.name==="Image006");
    state.project.results[partialView.id]={dapi:{status:"done",error:"",detections:[]}};
    refreshViewError(viewById(state.currentViewId));updateCounts();renderResults();
  });
  assert.strictEqual(await page.evaluate(()=>"cic_learning" in serializableProject()),false);
  assert.strictEqual(await page.evaluate(()=>Object.values(serializableProject().results).every(result=>!("cic" in result))),true);
  assert.strictEqual(await page.evaluate(()=>exportRunStamp(new Date(2026,7,30,1,2,3,4))),"20260830-010203004");
  assert.deepStrictEqual(await page.evaluate(()=>({
    names:[...xlsxSheetNames(["a/b","a:b","汇总","History","12345678901234567890123456789012345",`${"a".repeat(30)}'suffix`,`${"😀".repeat(20)}a`]).values()],
    escaped:xlsxXml("A&B<1> _x000A_"),
  })),{
    names:["a_b","a_b_2","汇总_2","History_","1234567890123456789012345678901","a".repeat(30),"😀".repeat(15)],
    escaped:"A&amp;B&lt;1&gt; _x005F_x000A_",
  });
  const xlsxDownload=page.waitForEvent("download");
  await page.locator("#excelBtn").click();
  const downloadedXlsx=await xlsxDownload,downloadedXlsxPath=await downloadedXlsx.path();
  const xlsxBytes=fs.readFileSync(downloadedXlsxPath);verifyCellCountWorkbook(xlsxBytes);
  assert.match(downloadedXlsx.suggestedFilename(),/_细胞计数结果\.xlsx$/);
  if(process.env.CELLSCOPE_XLSX_OUTPUT)fs.copyFileSync(downloadedXlsxPath,process.env.CELLSCOPE_XLSX_OUTPUT);
  await page.waitForFunction(()=>!state.busy);
  assert.match(await page.locator("#toast").textContent(),/Excel 已下载/);
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
  const zipEntries=storedZipEntries(zipBytes),nestedXlsx=[...zipEntries].find(([name])=>name.endsWith("_细胞计数结果.xlsx"));
  assert(nestedXlsx);verifyCellCountWorkbook(nestedXlsx[1]);
  assert(zipBytes.includes(Buffer.from("标注图清单.csv")));
  assert(zipBytes.includes(Buffer.from("DAPI细胞-效应细胞")));
  assert(zipBytes.includes(Buffer.from("所含DAPI核数")));
  assert(zipBytes.includes(Buffer.from("本地纠正学习.json")));
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
        const marker=[...nk,...tumor],cellIds=marker.map(item=>item.cell_instance_id);
        return{
          dapi:dapi.length,nk:nk.length,tumor:tumor.length,dapiCells:viewCounts(state.currentViewId).dapi.cells,
          review:marker.filter(item=>item.review_required).length,multinucleated:marker.filter(item=>detectionNucleusCount(item)>1).length,
          allAnchored:marker.every(item=>item.object_type==="marker_cell_instance"&&item.display_label!=null&&item.runs?.length&&item.nucleus_ids?.every(id=>ids.has(id))),
          uniqueCellIds:new Set(cellIds).size===cellIds.length,
        };
      });
      assert(guidedAudit.dapi>0);assert(guidedAudit.allAnchored);assert(guidedAudit.uniqueCellIds);assert(guidedAudit.dapiCells>0);
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
