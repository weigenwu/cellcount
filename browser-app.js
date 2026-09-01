/* global UTIF, CellScopeLearning */
const APP_ASSET_VERSION = "20260901-dapi-calibration1";
const DEFAULTS = {
  threshold_mode: "manual", threshold_low: 15, threshold_high: 255,
  auto_threshold_factor: 1, min_solidity: 0,
  gaussian_sigma: 1, opening_radius: 1, watershed_min_distance: 12,
  min_area_px: 400, max_area_px: 20000, min_circularity: 0.3,
  max_circularity: 1,
};
const TARGETS = ["dapi", "nk", "tumor"];
const DEFAULT_CHANNEL_LABELS = {dapi:"DAPI", nk:"NK", tumor:"肿瘤"};
function defaultParams(target) {
  return {
    ...DEFAULTS,
    analysis_mode:target === "dapi" ? "particles" : "nucleus_guided",
    signal_threshold_mode:"auto",
    signal_threshold:target === "nk" ? 10 : 15,
    positive_fraction:0.05,
    ring_radius_um:2,
    signal_mad_multiplier:3,
    min_signal_block_um2:0.5,
    ring_radius_px:6,
  };
}
const state = {
  project: null, currentViewId: null, currentGroup: null, channel: "overlay", target: "dapi",
  detections: [], selectedId: null, mode: "select", zoom: 1, worker: null,
  cancelled: false, cancelReject: null, pendingProject: null, busy: false,
  inspectionMode: "original", showLabels: true, rawImage: null,
  visibleClasses: new Set(["dapi", "tumor", "nk"]),
  selectedGroups: new Set(),
  panX: 0, panY: 0, fitLeft: 0, fitTop: 0,
  spacePressed: false, panning: false, panPointerId: null,
  panStartX: 0, panStartY: 0, panOriginX: 0, panOriginY: 0,
  panMoved: false,
  undoStack: [], redoStack: [], autosaveTimer: null,
};
const compareState = {
  open:false,
  left:{viewId:null,channel:"overlay",zoom:1,panX:0,panY:0,fitLeft:0,fitTop:0,raw:null,dragging:false,pointerId:null,startX:0,startY:0,originX:0,originY:0},
  right:{viewId:null,channel:"overlay",zoom:1,panX:0,panY:0,fitLeft:0,fitTop:0,raw:null,dragging:false,pointerId:null,startX:0,startY:0,originX:0,originY:0},
};
const $ = id => document.getElementById(id);
const colors = {dapi:"#4d7cff", tumor:"#ff4a5b", nk:"#41e090"};
const supported = new Set([".tif", ".tiff", ".png", ".jpg", ".jpeg"]);
function targetLabel(target) {
  return state.project?.channel_labels?.[target] || DEFAULT_CHANNEL_LABELS[target];
}
function learningProfileKey(target=state.target) {
  return `cell-v1:${target}:${targetLabel(target).trim().toLocaleLowerCase()}`;
}
function updateLearningStatus() {
  if(!$("learningStatus")||typeof CellScopeLearning==="undefined")return;
  const stats=CellScopeLearning.stats(learningProfileKey());
  $("learningStatus").textContent=stats.trained
    ? `${targetLabel(state.target)}：已训练 · 正确 ${stats.positive} · 误识别 ${stats.negative}；新结果会自动标出相似性冲突`
    : `${targetLabel(state.target)}：正确 ${stats.positive} · 误识别 ${stats.negative}；两类各至少 ${stats.minSamplesPerClass} 个后开始学习`;
}
function recordLearningFeedback(item,label) {
  if(!item||typeof CellScopeLearning==="undefined")return;
  try{
    CellScopeLearning.record(learningProfileKey(),item,label,{
      target:state.target,channel_label:targetLabel(state.target),project:state.project?.name,
      group:state.currentGroup,view:state.currentViewId,source:item.manual?"manual":"automatic",
    });
    updateLearningStatus();
  }catch(error){console.warn("本地纠正学习记录失败",error);}
}
function applyLocalLearning(target,detections) {
  if(typeof CellScopeLearning==="undefined")return detections;
  for(const item of detections)item.learning_label="positive";
  return CellScopeLearning.apply(learningProfileKey(target),detections);
}

function toast(message, error=false) {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.className = "toast", 3800);
}
function extension(name) { return name.slice(name.lastIndexOf(".")).toLowerCase(); }
function stem(name) { return name.slice(0, name.length - extension(name).length); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function channelMappingKey(directory,base) {
  return `${String(directory).toLowerCase()}/${String(base).toLowerCase()}`;
}
function parseLeicaChannelMapping(xmlText) {
  try{
    const documentNode=new DOMParser().parseFromString(xmlText,"application/xml");
    if(documentNode.querySelector("parsererror"))return null;
    const imageDescription=documentNode.getElementsByTagName("ImageDescription")[0];
    const channels=imageDescription?.getElementsByTagName("Channels")[0];
    const descriptions=channels?[...channels.children].filter(node=>node.tagName==="ChannelDescription"):[];
    const colorTargets={blue:"dapi",green:"nk",red:"tumor"};
    const mapping={},order=[];
    descriptions.forEach((node,index)=>{
      const color=String(node.getAttribute("LUTName")||"").trim().toLowerCase();
      order.push(color);
      if(colorTargets[color])mapping[colorTargets[color]]=`_ch${String(index).padStart(2,"0")}`;
    });
    if(!Object.keys(mapping).length)return null;
    const dimensions=imageDescription?.getElementsByTagName("Dimensions")[0];
    const xDimension=dimensions?[...dimensions.children].find(node=>node.tagName==="DimensionDescription"&&node.getAttribute("DimID")==="1"):null;
    const elements=Number(xDimension?.getAttribute("NumberOfElements"));
    const length=Number(xDimension?.getAttribute("Length"));
    const unit=String(xDimension?.getAttribute("Unit")||"").toLowerCase();
    const unitToUm=unit==="m"?1e6:unit==="mm"?1e3:unit==="µm"||unit==="um"?1:null;
    const pixelSizeUm=elements>0&&length>0&&unitToUm?length/elements*unitToUm:null;
    return{mapping,order,source:"leica_xml",pixelSizeUm};
  }catch(error){console.warn("Leica 通道元数据解析失败",error);return null;}
}
async function detectLeicaChannelMappings(files,root) {
  const mappings=new Map();
  for(const file of files){
    if(!/\.xml$/i.test(file.name)||/_Properties\.xml$/i.test(file.name))continue;
    const fullPath=file.webkitRelativePath||file.name;
    const relative=fullPath.startsWith(root+"/")?fullPath.slice(root.length+1):fullPath;
    const parts=relative.split("/");
    const metadataIndex=parts.findIndex(part=>part.toLowerCase()==="metadata");
    if(metadataIndex<0)continue;
    const directory=parts.slice(0,metadataIndex).join("/");
    const base=stem(file.name);
    const parsed=parseLeicaChannelMapping(await file.text());
    if(parsed)mappings.set(channelMappingKey(directory,base),parsed);
  }
  return mappings;
}
function channelMappingText(mapping) {
  const short=value=>value?String(value).replace(/^_/,""):"缺失";
  return `${targetLabel("dapi")} ${short(mapping.dapi)} · ${targetLabel("nk")} ${short(mapping.nk)} · ${targetLabel("tumor")} ${short(mapping.tumor)}`;
}
function channelMappingSignature(mapping) {
  return TARGETS.map(target=>`${target}:${mapping?.[target]||""}`).join("|").toLowerCase();
}
function viewFileFingerprints(view) {
  return Object.fromEntries([...TARGETS,"overlay"].map(channel=>{
    const file=view.files?.[channel];
    return[channel,file?{name:file.name,size:file.size,lastModified:file.lastModified}:null];
  }));
}
function sameFileFingerprints(saved,current) {
  return [...TARGETS,"overlay"].every(channel=>{
    const left=saved?.[channel],right=current?.[channel];
    return !left&&!right || Boolean(left&&right&&left.name===right.name&&left.size===right.size&&left.lastModified===right.lastModified);
  });
}
function sameLegacyFileNames(saved,current) {
  if(!saved||!current)return false;
  const comparable=[...TARGETS,...(Object.hasOwn(saved,"overlay")?["overlay"]:[])];
  return comparable.every(channel=>String(saved[channel]||"").toLowerCase()===String(current[channel]||"").toLowerCase());
}

async function scanFolder(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const suffixes = {dapi:$("suffixDapi").value.trim(), nk:$("suffixNk").value.trim(), tumor:$("suffixTumor").value.trim()};
  if (!suffixes.dapi || !suffixes.nk || !suffixes.tumor) return toast("通道后缀不能为空", true);
  const root = (files[0].webkitRelativePath || files[0].name).split("/")[0];
  const map = new Map();
  files.forEach(file => {
    const path = file.webkitRelativePath || file.name;
    const relative = path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
    map.set(relative.toLowerCase(), {file, relative});
  });
  const detectedMappings=await detectLeicaChannelMappings(files,root);
  let pixelSizeUm = 0.218;
  const propertyFile = files.find(file => /_properties\.xml$/i.test(file.name));
  if (propertyFile) {
    const match = (await propertyFile.text()).match(/Voxel="([\d.]+)"/);
    if (match) pixelSizeUm = Number(match[1]);
  }
  const candidates=new Map();
  for (const {file, relative} of map.values()) {
    if (!supported.has(extension(file.name))) continue;
    const fileStem = stem(file.name);
    const channelMatch=fileStem.match(/^(.*)(_ch\d+)$/i);
    if(!channelMatch)continue;
    const base=channelMatch[1];
    const slash = relative.lastIndexOf("/");
    const directory = slash >= 0 ? relative.slice(0, slash) : "";
    const candidateKey=channelMappingKey(directory,base);
    const preference={".tif":4,".tiff":4,".png":3,".jpg":2,".jpeg":2}[extension(file.name)]||1;
    if(!candidates.has(candidateKey)||preference>candidates.get(candidateKey).preference){
      candidates.set(candidateKey,{base,directory,ext:extension(file.name),preference});
    }
  }
  const views = [];
  for(const candidate of candidates.values()){
    const {base,directory,ext}=candidate;
    const group = directory || root;
    const key = name => `${directory ? directory + "/" : ""}${name}${ext}`.toLowerCase();
    const findAny = name => name ? map.get(key(name)) || [...map.values()].find(item => {
      const itemSlash = item.relative.lastIndexOf("/");
      const itemDir = itemSlash >= 0 ? item.relative.slice(0, itemSlash) : "";
      return itemDir.toLowerCase() === directory.toLowerCase() && stem(item.file.name).toLowerCase() === name.toLowerCase() && supported.has(extension(item.file.name));
    }) : null;
    const detected=detectedMappings.get(channelMappingKey(directory,base));
    const channelMapping={...(detected?.mapping||suffixes)};
    const dapi=findAny(base+channelMapping.dapi),nk=findAny(base+channelMapping.nk),tumor=findAny(base+channelMapping.tumor),overlay=findAny(base);
    const errors = [];
    if (!dapi) errors.push(`缺少蓝色 ${targetLabel("dapi")} 通道`);
    if (!nk) errors.push(`缺少绿色 ${targetLabel("nk")} 通道`);
    if (!tumor) errors.push(`缺少红色 ${targetLabel("tumor")} 通道`);
    views.push({
      id: `${group}/${base}`, group, name: base,
      files: {dapi:dapi?.file||null, nk:nk?.file||null, tumor:tumor?.file||null, overlay:overlay?.file||dapi?.file||null},
      fileNames: {dapi:dapi?.file.name||"", nk:nk?.file.name||"", tumor:tumor?.file.name||"", overlay:overlay?.file.name||dapi?.file.name||""},
      channel_mapping:channelMapping,
      channel_mapping_source:detected?.source||"manual_suffix",
      channel_lut_order:detected?.order||[],
      pixel_size_um:detected?.pixelSizeUm||pixelSizeUm,
      width:0, height:0, status:errors.length ? "error" : "pending", import_error:errors.join("；"), error:errors.join("；"),
    });
  }
  if (!views.length) return toast("没有找到可配对的 _ch00 / _ch01 / _ch02 通道图片", true);
  views.sort((a,b) => a.id.localeCompare(b.id, "zh-CN", {numeric:true}));
  const groups = [...new Set(views.map(view => view.group))];
  state.project = {
    version:6, browserVersion:true, name:root, pixel_size_um:pixelSizeUm, suffixes,
    channel_labels:{...DEFAULT_CHANNEL_LABELS},
    groups, views,
    parameters_by_group:Object.fromEntries(groups.map(group => [
      group,
      Object.fromEntries(TARGETS.map(target => [target, defaultParams(target)]))
    ])),
    results:{}, created_at:new Date().toISOString(),
  };
  state.selectedGroups=new Set(groups);
  if (!state.pendingProject) await restoreAutosave(root);
  mergePendingProject();
  openWorkspace();
  $("folderInput").value = "";
  $("welcomeFolderInput").value = "";
}

function mergePendingProject() {
  const saved = state.pendingProject;
  if (!saved || !state.project) return;
  if (saved.name !== state.project.name) {
    toast("项目文件与所选图片文件夹名称不同，未合并旧结果", true);
    return;
  }
  state.project.channel_labels = {...DEFAULT_CHANNEL_LABELS, ...(saved.channel_labels || {})};
  if(saved.learning_data&&typeof CellScopeLearning!=="undefined"){
    try{CellScopeLearning.importData(saved.learning_data);}catch(error){console.warn("项目中的本地学习配置无法恢复",error);}
  }
  if (Array.isArray(saved.selected_groups)) {
    state.selectedGroups=new Set(saved.selected_groups.filter(group=>state.project.groups.includes(group)));
  }
  const restoreParams=(target,params)=>{
    const restored={...defaultParams(target),...params};
    if(Number(saved.version)===4&&!Object.hasOwn(params,"signal_threshold_mode"))restored.signal_threshold_mode="manual";
    if(!Object.hasOwn(params,"ring_radius_um")&&Object.hasOwn(params,"ring_radius_px"))restored.ring_radius_um=null;
    return restored;
  };
  for (const group of state.project.groups) {
    const savedGroup = saved.parameters_by_group?.[group];
    if (!savedGroup) continue;
    if (savedGroup.dapi || savedGroup.nk || savedGroup.tumor) {
      for (const target of TARGETS) {
        if (savedGroup[target]) {
          state.project.parameters_by_group[group][target] = restoreParams(target,savedGroup[target]);
        }
      }
    } else {
      for (const target of TARGETS) {
        state.project.parameters_by_group[group][target] = restoreParams(target,savedGroup);
      }
    }
  }
  let channelMismatchCount=0,fileMismatchCount=0,legacyRestoreCount=0;
  for (const view of state.project.views) {
    if (saved.results?.[view.id]) {
      const savedResult = saved.results[view.id];
      const savedView=(saved.views||[]).find(item=>item.id===view.id);
      const savedMapping=savedView?.channel_mapping||saved.channel_mapping||saved.suffixes;
      if(channelMappingSignature(savedMapping)!==channelMappingSignature(view.channel_mapping)){
        channelMismatchCount++;
        continue;
      }
      const savedFingerprints=savedView?.file_fingerprints;
      if(!savedFingerprints){
        if(!sameLegacyFileNames(savedView?.fileNames,view.fileNames)){
          fileMismatchCount++;
          continue;
        }
        legacyRestoreCount++;
      }
      else if(!sameFileFingerprints(savedFingerprints,viewFileFingerprints(view))){
        fileMismatchCount++;
        continue;
      }
    if (savedResult.dapi || savedResult.nk || savedResult.tumor) {
        state.project.results[view.id] = {};
        for (const target of TARGETS) {
          if (!savedResult[target]) continue;
          const restored={
            ...savedResult[target],
            detections:(savedResult[target].detections||[]).map(inflateDetection)
          };
          if(!restored.result_kind){
            restored.result_kind=target==="dapi"?"nuclei_v1":
              restored.parameters?.analysis_mode==="nucleus_guided"?"legacy_nucleus_positive_v4":"particles_v1";
            if(restored.result_kind==="legacy_nucleus_positive_v4")restored.legacy_algorithm=true;
          }
          state.project.results[view.id][target]=restored;
        }
      }
      view.status = overallStatus(view);
    }
  }
  refreshAllDapiQc();
  state.pendingProject = null;
  updateHistoryButtons();
  const mismatchCount=channelMismatchCount+fileMismatchCount;
  toast(mismatchCount
    ? `已恢复项目参数；${mismatchCount} 个视野因通道或原图无法安全核对，旧计数未恢复`
    : legacyRestoreCount
      ? `已按旧项目的原文件名恢复 ${legacyRestoreCount} 个视野；建议抽查标注后再继续`
      : "已恢复项目参数和计数结果",mismatchCount>0);
}

function openWorkspace() {
  $("appShell").classList.remove("empty");
  $("welcome").classList.add("hidden");
  ["sidebar","workspace","controlPanel"].forEach(id => $(id).classList.remove("hidden"));
  $("projectName").textContent = state.project.name;
  $("projectMeta").textContent = `${state.project.groups.length} 个实验组 · ${state.project.views.length} 个视野`;
  $("pixelSizeBadge").textContent = `${state.project.pixel_size_um} µm/px`;
  refreshChannelLabels();renderChannelMappingSummary();renderGroups();renderResults();updateLearningStatus();
  const first = state.project.views.find(view => !view.error) || state.project.views[0];
  if (first) selectView(first.id);
  toast(`已在浏览器中识别 ${state.project.views.length} 个视野`);
}
function renderChannelMappingSummary() {
  if(!state.project||!$("channelMappingSummary"))return;
  const views=state.project.views;
  const automatic=views.filter(view=>view.channel_mapping_source==="leica_xml").length;
  const descriptions=[...new Set(views.map(view=>channelMappingText(view.channel_mapping)))];
  const missing=views.filter(view=>TARGETS.some(target=>!view.files[target])).length;
  const allAutomatic=views.length>0&&automatic===views.length;
  $("channelMappingSummary").classList.toggle("warning",!allAutomatic||missing>0);
  $("channelMappingTitle").textContent=allAutomatic
    ? `已按 Leica XML 匹配${missing?`；${missing} 个视野通道不全`:"通道"}`
    : "部分通道使用手动后缀";
  $("channelMappingDetail").textContent=descriptions.length===1
    ? descriptions[0]
    : `${descriptions.length} 种通道顺序，已逐视野匹配`;
  $("channelMappingSummary").title=views.map(view=>`${view.group}/${view.name}：${channelMappingText(view.channel_mapping)}（${view.channel_mapping_source==="leica_xml"?"XML自动":"手动"}）`).join("\n");
}
function groupViews(group) { return state.project.views.filter(view => view.group === group); }
function viewById(id) { return state.project.views.find(view => view.id === id); }
function updateViewNavigation() {
  if(!state.project||!state.currentViewId)return;
  const current=viewById(state.currentViewId);
  const views=current?groupViews(current.group):[];
  const index=views.findIndex(view=>view.id===state.currentViewId);
  const previous=views[index-1],next=views[index+1];
  $("previousViewBtn").disabled=!previous;
  $("nextViewBtn").disabled=!next;
  $("previousViewBtn").title=previous?`上一张：${previous.name}（键盘 ←）`:"已经是当前文件夹第一张";
  $("nextViewBtn").title=next?`下一张：${next.name}（键盘 →）`:"已经是当前文件夹最后一张";
  $("viewPositionBadge").textContent=index>=0?`${index+1} / ${views.length}`:`0 / ${views.length}`;
  $("viewPositionBadge").title=current?current.group:"";
}
async function navigateCurrentGroup(offset) {
  if(!state.project||!state.currentViewId||state.busy)return;
  const current=viewById(state.currentViewId),views=groupViews(current.group);
  const index=views.findIndex(view=>view.id===current.id);
  const target=views[index+offset];
  if(target)await selectView(target.id);
}
function targetResult(viewId, target=state.target) { return state.project.results[viewId]?.[target]; }
function targetStatus(viewId, target) { return targetResult(viewId,target)?.status || "pending"; }
const DAPI_QC_FLAG="dapi_group_outlier";
function refreshDapiGroupQc(group) {
  const views=groupViews(group),completed=[];
  for(const view of views){
    const result=targetResult(view.id,"dapi");
    if(!result)continue;
    delete result.qc_flags;delete result.qc_message;delete result.qc_ratio;
    if(result.status==="done")completed.push({view,result,total:countTargetDetections(result.detections).total});
  }
  if(completed.length<4)return [];
  const totals=completed.map(item=>item.total).sort((left,right)=>left-right),middle=Math.floor(totals.length/2);
  const median=totals.length%2?totals[middle]:(totals[middle-1]+totals[middle])/2;
  const outliers=[];
  for(const item of completed){
    const ratio=median?item.total/median:(item.total===0?1:null),deviation=ratio==null?1:Math.abs(ratio-1),outlier=deviation>.3;
    item.result.qc_ratio=ratio==null?null:Math.round(ratio*10000)/10000;
    item.result.qc_flags=outlier?[DAPI_QC_FLAG]:[];
    item.result.qc_message=outlier
      ? `DAPI有效计数 ${item.total}，比同组中位数 ${median} ${item.total<median?"低":"高"} ${Math.round(deviation*100)}%（阈值 30%）`
      : "";
    if(outlier)outliers.push(item.view);
  }
  return outliers;
}
function refreshAllDapiQc() { return state.project.groups.flatMap(refreshDapiGroupQc); }
function dapiQcMessage(view) {
  const result=targetResult(view.id,"dapi");
  return result?.qc_flags?.includes(DAPI_QC_FLAG)?result.qc_message||"":"";
}
function resultUsesDapiAnchor(view,target,result=targetResult(view.id,target)) {
  const mode=result?.parameters?.analysis_mode
    ??state.project.parameters_by_group[view.group]?.[target]?.analysis_mode;
  return mode==="nucleus_guided";
}
function refreshViewError(view) {
  const errors=[view.import_error];
  for(const target of TARGETS){
    const error=targetResult(view.id,target)?.error;
    if(error)errors.push(`${targetLabel(target)}：${error}`);
  }
  view.error=[...new Set(errors.filter(Boolean))].join("；");
  return view.error;
}
function viewIssueText(view) { return [refreshViewError(view),dapiQcMessage(view)].filter(Boolean).join("；"); }
function invalidateGuidedDependents(view,notify=false) {
  const invalidated=[];
  for(const target of ["nk","tumor"]){
    const result=targetResult(view.id,target);
    if(!result||result.status==="pending"||!resultUsesDapiAnchor(view,target,result))continue;
    state.project.results[view.id][target]={
      status:"pending",
      error:`${targetLabel("dapi")} 核已更新，请重新分析 ${targetLabel(target)}`,
      detections:[],
    };
    invalidated.push(targetLabel(target));
  }
  refreshViewError(view);
  if(notify&&invalidated.length)toast(`${targetLabel("dapi")} 核已改变；旧 ${invalidated.join("、")} 结果已清除，请重新分析`);
  return invalidated;
}
function overallStatus(view) {
  const statuses = TARGETS.map(target => targetStatus(view.id,target));
  if (statuses.includes("running")) return "running";
  const availableTargets=TARGETS.filter(target=>Boolean(view.files[target]));
  if (availableTargets.length&&availableTargets.every(target=>targetStatus(view.id,target)==="done")) {
    return availableTargets.length===TARGETS.length?"done":"partial";
  }
  if (statuses.some(status => status === "done")) return "partial";
  if (statuses.some(status => status === "error")) return "error";
  if (view.import_error) return "partial";
  return "pending";
}

function renderGroups() {
  $("groupList").innerHTML = "";
  state.project.groups.forEach(group => {
    const wrapper = document.createElement("div");
    wrapper.className = "group";
    const views = groupViews(group);
    wrapper.innerHTML = `<div class="group-header"><label class="group-select" title="选择此文件夹进行批量处理"><input type="checkbox" ${state.selectedGroups.has(group)?"checked":""}></label><button class="group-toggle"><strong>${escapeHtml(group)}</strong><small>${views.length}</small></button></div><div class="view-list"></div>`;
    const list = wrapper.querySelector(".view-list");
    views.forEach(view => {
      view.status = overallStatus(view);
      const button = document.createElement("button");
      button.className = `view-item${view.id === state.currentViewId ? " active" : ""}`;
      button.innerHTML = `<span class="status-dot ${view.status}"></span><span>${escapeHtml(view.name)}</span>`;
      button.title=view.error||"";
      button.onclick = () => selectView(view.id);
      list.appendChild(button);
    });
    wrapper.querySelector(".group-select input").onchange=event=>{
      event.target.checked?state.selectedGroups.add(group):state.selectedGroups.delete(group);
      updateSelectedGroupCount();
      scheduleAutosave();
    };
    wrapper.querySelector(".group-toggle").onclick = () => list.classList.toggle("hidden");
    $("groupList").appendChild(wrapper);
  });
  updateSelectedGroupCount();
}
function updateSelectedGroupCount() {
  $("selectedGroupCount").textContent=`${state.selectedGroups.size} / ${state.project?.groups.length||0} 个已选`;
}

async function selectView(id) {
  state.currentViewId = id; state.selectedId = null;
  const view = viewById(id);
  state.currentGroup = view.group;
  $("currentGroupLabel").textContent = view.group;
  $("currentViewLabel").textContent = view.name;
  $("pixelSizeBadge").textContent=`${Number(view.pixel_size_um||state.project.pixel_size_um).toFixed(3)} µm/px`;
  $("profileGroup").textContent = `${view.group} · ${targetLabel(state.target)}`;
  populateParameters(state.project.parameters_by_group[view.group][state.target]);
  state.detections = targetResult(id)?.detections || [];
  updateCounts();
  updateViewNavigation();
  renderGroups();
  await showImage();
}

async function decodeRgba(file) {
  const ext = extension(file.name);
  if (ext === ".tif" || ext === ".tiff") {
    const buffer = await file.arrayBuffer();
    const ifds = UTIF.decode(buffer);
    if (!ifds.length) throw new Error("TIFF 中没有图像");
    UTIF.decodeImage(buffer, ifds[0]);
    return {rgba:new Uint8ClampedArray(UTIF.toRGBA8(ifds[0])), width:ifds[0].width, height:ifds[0].height};
  }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0); bitmap.close();
  return {rgba:context.getImageData(0,0,canvas.width,canvas.height).data, width:canvas.width, height:canvas.height};
}

async function showImage() {
  const view = viewById(state.currentViewId);
  const channel=state.channel,requestToken=Symbol("image");
  state.imageRequest=requestToken;
  const file = view?.files[channel] || (channel==="overlay"?view?.files.dapi:null);
  if (!file) {
    state.rawImage=null;
    $("imageStage").style.display="none";
    $("viewerEmpty").textContent=`当前视野缺少 ${targetLabel(channel)} 通道`;
    $("viewerEmpty").classList.remove("hidden");
    $("decodeBusy").classList.add("hidden");
    return;
  }
  $("viewerEmpty").textContent="选择左侧视野以查看图像";
  $("decodeBusy").classList.remove("hidden");
  try {
    const decoded = await decodeRgba(file);
    if (state.imageRequest!==requestToken||state.currentViewId!==view.id||state.channel!==channel) return;
    view.width = decoded.width; view.height = decoded.height;
    const imageCanvas = $("imageCanvas"), overlay = $("overlayCanvas");
    imageCanvas.width = overlay.width = decoded.width;
    imageCanvas.height = overlay.height = decoded.height;
    state.rawImage = decoded;
    fitStage(decoded.width, decoded.height);
    $("imageStage").style.display = "block";
    $("viewerEmpty").classList.add("hidden");
    renderInspectionView();
  } catch (error) {
    if(state.imageRequest===requestToken&&state.currentViewId===view.id&&state.channel===channel)toast(error.message,true);
  }
  finally {
    if(state.imageRequest===requestToken)$("decodeBusy").classList.add("hidden");
  }
}

function fitStage(width, height) {
  const viewer = $("viewer"), ratio = width / height;
  let displayWidth = viewer.clientWidth, displayHeight = displayWidth / ratio;
  if (displayHeight > viewer.clientHeight) { displayHeight = viewer.clientHeight; displayWidth = displayHeight * ratio; }
  const stage = $("imageStage");
  stage.style.width = `${displayWidth}px`; stage.style.height = `${displayHeight}px`;
  state.fitLeft = (viewer.clientWidth - displayWidth) / 2;
  state.fitTop = (viewer.clientHeight - displayHeight) / 2;
  stage.style.left = `${state.fitLeft}px`;
  stage.style.top = `${state.fitTop}px`;
  state.panX = 0; state.panY = 0; state.zoom = 1;
  applyViewportTransform();
}

function detectionRuns(item) { return item.runs?.length?item.runs:(item.signal_runs||[]); }
function detectionNucleusCount(item) {
  return Number.isFinite(Number(item.nuclei_per_cell)) ? Number(item.nuclei_per_cell) :
    Number.isFinite(Number(item.nucleus_count)) ? Number(item.nucleus_count) :
    Array.isArray(item.nucleus_ids) ? item.nucleus_ids.length : 0;
}
function reviewReasonsText(item) {
  const labels={
    multinucleated:"多核候选",three_plus_nuclei:"3 个及以上细胞核",oversized:"信号团块过大",
    edge:"触及图像边缘",weak_positive:"临界弱阳性",crowded:"细胞密集或粘连",
    learned_mismatch:"与本地纠正样本不一致",
  };
  return (item.review_reasons||[]).map(reason=>labels[reason]||reason).join("、");
}
function detectionDisplayLabel(item,fallback,labelPrefix="") {
  const base=item.display_label??item.cell_id??item.cell_instance_id??fallback;
  const nuclei=detectionNucleusCount(item);
  return `${labelPrefix}${base}${nuclei>1?`·${nuclei}核`:""}${item.review_required?"⚠":""}`;
}
function buildDetectionMask(width, height, detections, visibleClasses=null) {
  const mask = document.createElement("canvas");
  mask.width = width; mask.height = height;
  const context = mask.getContext("2d");
  context.fillStyle = "#fff";
  for (const item of detections) {
    if (item.deleted || (visibleClasses && !visibleClasses.has(item.classification))) continue;
    const runs=detectionRuns(item);
    if (runs.length) {
      for (let i=0; i<runs.length; i+=3) {
        const y=runs[i], start=runs[i+1], end=runs[i+2];
        context.fillRect(start,y,end-start+1,1);
      }
    } else {
      context.beginPath();
      context.arc(item.x,item.y,Math.max(8,item.radius||12),0,Math.PI*2);
      context.fill();
    }
  }
  return mask;
}

function buildAcceptedMask() {
  const source = $("overlayCanvas");
  return buildDetectionMask(source.width,source.height,state.detections,state.visibleClasses);
}

function tintMask(mask, color) {
  const output=document.createElement("canvas");
  output.width=mask.width;output.height=mask.height;
  const context=output.getContext("2d");
  context.drawImage(mask,0,0);
  context.globalCompositeOperation="source-in";
  context.fillStyle=color;
  context.fillRect(0,0,output.width,output.height);
  context.globalCompositeOperation="source-over";
  return output;
}

function outlineMask(mask, color, width=3) {
  const output=document.createElement("canvas");
  output.width=mask.width;output.height=mask.height;
  const context=output.getContext("2d");
  for (let offset=-width;offset<=width;offset++) {
    context.drawImage(mask,offset,-width);
    context.drawImage(mask,offset,width);
    context.drawImage(mask,-width,offset);
    context.drawImage(mask,width,offset);
  }
  context.globalCompositeOperation="destination-out";
  context.drawImage(mask,0,0);
  context.globalCompositeOperation="source-in";
  context.fillStyle=color;
  context.fillRect(0,0,output.width,output.height);
  context.globalCompositeOperation="source-over";
  return output;
}

function renderInspectionView() {
  const imageCanvas=$("imageCanvas");
  if (!imageCanvas.width || !state.rawImage) return;
  const context=imageCanvas.getContext("2d");
  context.clearRect(0,0,imageCanvas.width,imageCanvas.height);
  const mask=buildAcceptedMask();
  if (state.inspectionMode==="binary") {
    context.fillStyle="#fff";
    context.fillRect(0,0,imageCanvas.width,imageCanvas.height);
    context.drawImage(tintMask(mask,"#050505"),0,0);
  } else {
    context.putImageData(new ImageData(state.rawImage.rgba,state.rawImage.width,state.rawImage.height),0,0);
  }
  drawOverlay($("overlayCanvas"),mask);
}

function drawOverlay(target=$("overlayCanvas"), existingMask=null) {
  if (!target.width) return;
  const context=target.getContext("2d");
  context.clearRect(0,0,target.width,target.height);
  const mask=existingMask||buildAcceptedMask();
  const outlineColor=state.inspectionMode==="binary"?"#ffe600":colors[state.target];
  context.drawImage(outlineMask(mask,outlineColor,state.inspectionMode==="binary"?3:2),0,0);
  const reviewItems=state.detections.filter(item=>!item.deleted&&item.review_required&&state.visibleClasses.has(item.classification));
  if(reviewItems.length){
    const reviewMask=buildDetectionMask(target.width,target.height,reviewItems);
    context.drawImage(outlineMask(reviewMask,"#ffb84d",4),0,0);
    reviewMask.width=1;reviewMask.height=1;
  }
  let activeIndex=0;
  for (const item of state.detections) {
    if (item.deleted || !state.visibleClasses.has(item.classification)) continue;
    activeIndex++;
    if (item.id===state.selectedId) {
      context.strokeStyle="#fff";
      context.lineWidth=4;
      context.beginPath();
      context.arc(item.x,item.y,Math.max(9,item.radius||12)+5,0,Math.PI*2);
      context.stroke();
    }
    if (!state.showLabels) continue;
    const fontSize=Math.max(13,Math.min(24,(item.radius||12)*0.8));
    context.font=`700 ${fontSize}px system-ui`;
    context.textAlign="center";
    context.textBaseline="middle";
    context.lineWidth=3;
    context.strokeStyle=state.inspectionMode==="binary"?"#111":"rgba(0,0,0,.85)";
    context.fillStyle="#fff";
    const label=detectionDisplayLabel(item,activeIndex);
    context.strokeText(label,item.x,item.y);
    context.fillText(label,item.x,item.y);
  }
}

const fieldMap = {
  analysisMode:"analysis_mode",
  thresholdMode:"threshold_mode", thresholdLow:"threshold_low", thresholdHigh:"threshold_high",
  autoThresholdFactor:"auto_threshold_factor", minSolidity:"min_solidity",
  minArea:"min_area_px", maxArea:"max_area_px", minCircularity:"min_circularity",
  maxCircularity:"max_circularity", gaussianSigma:"gaussian_sigma",
  watershedDistance:"watershed_min_distance",
  signalThreshold:"signal_threshold", positiveFraction:"positive_fraction",
  signalThresholdMode:"signal_threshold_mode",
  ringRadiusUm:"ring_radius_um", signalMadMultiplier:"signal_mad_multiplier",
  minSignalBlockUm2:"min_signal_block_um2",
};
function populateParameters(params) {
  Object.entries(fieldMap).forEach(([id,key]) => {
    const pixelSize=viewById(state.currentViewId)?.pixel_size_um||state.project.pixel_size_um;
    $(id).value=key==="ring_radius_um"&&params[key]==null
      ? Number(params.ring_radius_px||0)*pixelSize
      : params[key];
  });
  $("analysisMode").disabled = state.target === "dapi";
  if (state.target === "dapi") $("analysisMode").value = "particles";
  updateParameterVisibility();
  updateAreaNote();
}
function collectParameters() {
  const params = {...state.project.parameters_by_group[state.currentGroup][state.target]};
  Object.entries(fieldMap).forEach(([id,key]) => {
    params[key] = ["thresholdMode","analysisMode","signalThresholdMode"].includes(id) ? $(id).value : Number($(id).value);
  });
  return params;
}
function updateParameterVisibility() {
  const guided = $("analysisMode").value === "nucleus_guided" && state.target !== "dapi";
  document.querySelectorAll(".particle-only").forEach(node=>node.classList.toggle("hidden",guided));
  document.querySelectorAll(".guided-only").forEach(node=>node.classList.toggle("hidden",!guided));
  $("targetParameterTitle").textContent=`${targetLabel(state.target)} ${guided ? "核引导阳性参数" : "独立计数参数"}`;
}
function saveParameters(all=false) {
  if (!state.currentGroup) return false;
  const params = collectParameters();
  if (params.threshold_low > params.threshold_high) { toast("阈值下限不能大于上限", true); return false; }
  if (params.auto_threshold_factor < 0.5 || params.auto_threshold_factor > 1.5) { toast("自动阈值系数必须在 0.5–1.5 之间",true); return false; }
  if (params.min_solidity < 0 || params.min_solidity > 1) { toast("最小实心度必须在 0–1 之间",true); return false; }
  if (params.positive_fraction < 0 || params.positive_fraction > 1) { toast("阳性像素比例必须在 0–1 之间", true); return false; }
  if (params.ring_radius_um < 0 || params.signal_mad_multiplier < 0 || params.min_signal_block_um2 < 0) { toast("核周范围、MAD 倍数和最小信号块不能为负数",true); return false; }
  state.project.parameters_by_group[state.currentGroup][state.target] = params;
  if (all) state.project.groups.forEach(group => state.project.parameters_by_group[group][state.target] = {...params});
  scheduleAutosave();
  toast(all ? `${targetLabel(state.target)} 参数已应用到全部实验组` : `已保存“${state.currentGroup}”的 ${targetLabel(state.target)} 参数`);
  return true;
}
function updateAreaNote() {
  if (!state.project) return;
  const area = Number($("minArea").value||0);
  const pixelSize=viewById(state.currentViewId)?.pixel_size_um||state.project.pixel_size_um;
  $("areaConversion").textContent = `${area} px² ≈ ${(area*pixelSize**2).toFixed(1)} µm²`;
}

function createWorker() {
  if (state.worker) state.worker.terminate();
  state.worker = new Worker(`browser-worker.js?v=${APP_ASSET_VERSION}`);
  return state.worker;
}
function analyzeOne(view, params, target) {
  return new Promise(async (resolve,reject) => {
    state.cancelReject = () => reject(new Error("__cancelled__"));
    const worker = createWorker();
    worker.onmessage = event => {
      if (event.data.type === "progress") {
        $("jobCurrent").textContent = `${view.group} / ${view.name} · ${event.data.phase}`;
      } else if (event.data.type === "result") {
        state.cancelReject = null;
        resolve(event.data);
      } else if (event.data.type === "error") {
        state.cancelReject = null;
        reject(new Error(event.data.error));
      }
    };
    worker.onerror = event => {
      state.cancelReject = null;
      reject(new Error(event.message || "分析线程失败"));
    };
    try {
      const channelBuffer = await view.files[target].arrayBuffer();
      const guided = target !== "dapi" && params.analysis_mode === "nucleus_guided";
      const anchorDetections = guided && targetStatus(view.id,"dapi") === "done"
        ? (targetResult(view.id,"dapi").detections || []).filter(item=>!item.deleted).map((item,index)=>({...item,display_label:item.display_label??index+1}))
        : null;
      const anchorBuffer = guided && !anchorDetections ? await view.files.dapi.arrayBuffer() : null;
      const transfers = anchorBuffer ? [channelBuffer,anchorBuffer] : [channelBuffer];
      worker.postMessage({
        type:"analyze", params, target, targetLabel:targetLabel(target),
        pixelSizeUm:view.pixel_size_um||state.project.pixel_size_um,
        channelBuffer, channelExtension:extension(view.files[target].name),
        anchorBuffer, anchorExtension:guided ? extension(view.files.dapi.name) : null,
        anchorParams:guided ? state.project.parameters_by_group[view.group].dapi : null,
        anchorDetections,
      },transfers);
    } catch (error) {
      state.cancelReject = null;
      reject(error);
    }
  });
}

async function analyzeScope(scope) {
  if (!state.project) return;
  if (state.busy) return toast("已有批处理正在运行，请先等待完成或停止");
  if(!saveParameters(false))return;
  const target = state.target;
  let views = scope === "current" ? [viewById(state.currentViewId)] :
    scope === "group" ? groupViews(state.currentGroup) :
    scope === "pending" ? state.project.views.filter(view => state.selectedGroups.has(view.group) && targetStatus(view.id,target) !== "done") :
    state.project.views.filter(view=>state.selectedGroups.has(view.group));
  views = views.filter(view => Boolean(view.files[target])&&(
    target==="dapi"||state.project.parameters_by_group[view.group][target].analysis_mode!=="nucleus_guided"||view.files.dapi
  ));
  if (!views.length) return toast(scope==="all"||scope==="pending"?"请先勾选至少一个有可分析视野的文件夹":"没有未完成且可分析的视野",true);
  const label = targetLabel(target);
  const hasCorrections=views.some(view=>countTargetDetections(targetResult(view.id,target)?.detections||[]).corrected>0);
  const dependentViews=target==="dapi"?views.filter(view=>["nk","tumor"].some(dependent=>{
    const result=targetResult(view.id,dependent);
    return Boolean(result)&&result.status!=="pending"&&resultUsesDapiAnchor(view,dependent,result);
  })).length:0;
  if (hasCorrections||dependentViews) {
    const guidance = target === "dapi"
      ? `\n\nDAPI 核坐标改变后，${dependentViews} 个视野中依赖 DAPI 的 ${targetLabel("nk")}/${targetLabel("tumor")} 旧结果会被清除并要求重跑。若本意是分析其他通道，请先选择对应通道。`
      : `\n\n只会清除 ${label} 自身的人工修正，其他通道不受影响。`;
    if (!confirm(`当前正在重新分析 ${label}。是否继续？${guidance}`)) return;
  }
  state.cancelled = false;
  state.busy = true;
  $("jobPanel").classList.remove("hidden");
  const started = performance.now();
  let failureCount=0;
  for (let index=0; index<views.length; index++) {
    if (state.cancelled) break;
    const view = views[index];
    if (!state.project.results[view.id]) state.project.results[view.id] = {};
    const previous = cloneResult(state.project.results[view.id][target]);
    const previousDependents=target==="dapi"?Object.fromEntries(
      ["nk","tumor"].map(dependent=>[dependent,cloneResult(targetResult(view.id,dependent))])
    ):null;
    if(target==="dapi")invalidateGuidedDependents(view,false);
    state.project.results[view.id][target] = {...(previous||{}),status:"running",error:""};
    refreshViewError(view);view.status=overallStatus(view);renderGroups();renderResults();
    const percent = Math.round(index/views.length*100);
    $("jobPercent").textContent = `${percent}%`; $("jobProgress").style.width = `${percent}%`;
    $("jobTitle").textContent = `正在分析 ${index+1}/${views.length}`;
    try {
      const result = await analyzeOne(view,state.project.parameters_by_group[view.group][target],target);
      if (state.cancelled) throw new Error("__cancelled__");
      view.width=result.width; view.height=result.height; view.status="done";
      state.project.results[view.id][target] = {
        status:"done",error:"",detections:applyLocalLearning(target,result.detections),
        result_kind:result.result_kind,
        resolved_signal_threshold:result.resolved_signal_threshold,
        parameter_group:view.group,parameters:{...state.project.parameters_by_group[view.group][target]}
      };
      if(target==="dapi")refreshDapiGroupQc(view.group);
    } catch (error) {
      const cancelled=state.cancelled||error.message==="__cancelled__";
      if(previous){
        state.project.results[view.id][target]=previous;
        if(!cancelled)state.project.results[view.id][target].error=error.message;
      }else if(cancelled){
        delete state.project.results[view.id][target];
      }else{
        state.project.results[view.id][target]={status:"error",error:error.message,detections:[]};
      }
      if(previousDependents)for(const [dependent,result] of Object.entries(previousDependents)){
        if(result)state.project.results[view.id][dependent]=result;
        else delete state.project.results[view.id][dependent];
      }
      if(target==="dapi")refreshDapiGroupQc(view.group);
      refreshViewError(view);view.status=overallStatus(view);
      if(cancelled){renderGroups();renderResults();break;}
      failureCount++;
    }
    const elapsed=(performance.now()-started)/1000, remaining=elapsed/(index+1)*(views.length-index-1);
    $("jobCurrent").textContent = `${view.group} / ${view.name} · 剩余约 ${formatSeconds(remaining)}`;
    renderGroups(); renderResults();
  }
  if (state.worker) state.worker.terminate();
  state.worker=null;
  state.cancelReject=null;
  state.busy = false;
  $("jobPanel").classList.add("hidden");
  if (state.currentViewId) {
    state.detections=targetResult(state.currentViewId)?.detections||[];
    updateCounts(); renderInspectionView();
  }
  scheduleAutosave();
  const reportDapiQc=target==="dapi"&&!state.cancelled&&scope!=="current";
  const outlierCount=reportDapiQc
    ? [...new Set(views.map(view=>view.group))].flatMap(group=>groupViews(group)).filter(view=>dapiQcMessage(view)).length
    : 0;
  const completionMessage=(state.cancelled
    ? `${targetLabel(target)} 批处理已停止，已完成结果仍保留`
    : failureCount
      ? `${targetLabel(target)} 分析完成；${failureCount} 个视野失败，已保留旧结果`
      : `${targetLabel(target)} 分析完成`)+(reportDapiQc?`；DAPI组内QC：${outlierCount} 个异常视野${outlierCount?"⚠":""}`:"");
  toast(completionMessage,failureCount>0&&!state.cancelled);
}

function countTargetDetections(detections=[]) {
  const active=detections.filter(item=>!item.deleted);
  return {
    total:active.length,
    corrected:detections.filter(item=>item.manual||item.deleted).length,
    review:active.filter(item=>item.review_required).length,
    multinucleated:active.filter(item=>detectionNucleusCount(item)>1).length,
  };
}
function resultUsesCellInstances(view,target) {
  const result=targetResult(view.id,target);
  return result?.status==="done"&&result.result_kind==="cell_instances_v1";
}
function nucleiMayShareCell(nuclei,pixelSizeUm) {
  if(nuclei.length<=1)return true;
  const referenceLimitPx=nuclei.length===2?55:nuclei.length===3?70:0;
  if(!referenceLimitPx)return false;
  const limitPx=referenceLimitPx*.218/Math.max(.001,Number(pixelSizeUm)||.218);
  for(let left=0;left<nuclei.length;left++)for(let right=left+1;right<nuclei.length;right++){
    if(Math.hypot(nuclei[left].x-nuclei[right].x,nuclei[left].y-nuclei[right].y)>limitPx+1e-9)return false;
  }
  return true;
}
function inferredDapiCellCount(viewId) {
  const view=viewById(viewId),dapi=(targetResult(viewId,"dapi")?.detections||[]).filter(item=>!item.deleted);
  if(!view||targetStatus(viewId,"dapi")!=="done")return null;
  const markerTargets=["nk","tumor"].filter(target=>Boolean(view.files[target]));
  if(!markerTargets.length||markerTargets.some(target=>!resultUsesCellInstances(view,target)))return null;
  const ids=new Set(dapi.map(item=>item.id)),parent=new Map([...ids].map(id=>[id,id]));
  const find=id=>{
    let root=parent.get(id);
    while(root!==parent.get(root))root=parent.get(root);
    for(let current=id;current!==root;){const next=parent.get(current);parent.set(current,root);current=next;}
    return root;
  };
  const unite=(first,second)=>{const a=find(first),b=find(second);if(a!==b)parent.set(b,a);};
  for(const target of markerTargets){
    for(const item of targetResult(viewId,target).detections||[]){
      if(item.deleted)continue;
      const nucleusIds=[...new Set((item.nucleus_ids||[]).filter(id=>ids.has(id)))];
      for(let index=1;index<nucleusIds.length;index++)unite(nucleusIds[0],nucleusIds[index]);
    }
  }
  const groups=new Map(),byId=new Map(dapi.map(item=>[item.id,item]));
  for(const id of ids){const root=find(id);if(!groups.has(root))groups.set(root,[]);groups.get(root).push(byId.get(id));}
  const pixelSizeUm=view.pixel_size_um||state.project.pixel_size_um;
  return [...groups.values()].reduce((count,nuclei)=>count+(nucleiMayShareCell(nuclei,pixelSizeUm)?1:nuclei.length),0);
}
function viewCounts(viewId) {
  const counts=Object.fromEntries(TARGETS.map(target=>[
    target,
    countTargetDetections(targetResult(viewId,target)?.detections||[])
  ]));
  counts.dapi.cells=inferredDapiCellCount(viewId);
  return counts;
}
function updateCounts() {
  const counts=state.currentViewId?viewCounts(state.currentViewId):{};
  $("countDapi").textContent=targetStatus(state.currentViewId,"dapi")==="done"
    ? `${counts.dapi.total} / ${counts.dapi.cells??"—"}`:"—";
  $("countTumor").textContent=targetStatus(state.currentViewId,"tumor")==="done"?counts.tumor.total:"—";
  $("countNk").textContent=targetStatus(state.currentViewId,"nk")==="done"?counts.nk.total:"—";
  $("countReview").textContent=counts[state.target]?.review??0;
  $("currentTargetName").textContent=targetLabel(state.target);
  updateActionLabels();
  updateReviewControls();
}
function updateActionLabels() {
  if (!state.project) return;
  const label=targetLabel(state.target);
  $("analyzeCurrentBtn").textContent=`预跑当前图片（${label}）`;
  $("analyzeGroupBtn").textContent=`批量当前组（${label}）`;
  $("analyzeAllBtn").textContent=`批量已选文件夹（${label}）`;
  $("resumeBtn").textContent=`继续已选文件夹的 ${label}`;
}
function renderResults() {
  if (!state.project) return;
  const short={pending:"—",running:"…",done:"✓",error:"!"};
  $("resultsBody").innerHTML=state.project.views.map(view=>{
    const c=viewCounts(view.id);
    const corrected=c.dapi.corrected+c.nk.corrected+c.tumor.corrected;
    const pendingReview=c.nk.review+c.tumor.review;
    const dapiMinusNk=c.dapi.cells!=null&&targetStatus(view.id,"nk")==="done"?c.dapi.cells-c.nk.total:"—";
    const dapiDisplay=targetStatus(view.id,"dapi")==="done"?`${c.dapi.total} / ${c.dapi.cells??"—"}`:"—";
    const qc=dapiQcMessage(view),status=TARGETS.map(target=>`${targetLabel(target)} ${short[targetStatus(view.id,target)]}`).join(" · ")+(qc?" · DAPI异常⚠":"");
    return `<tr><td>${escapeHtml(view.group)} / ${escapeHtml(view.name)}</td><td title="核数 / 基于红绿细胞实例推算的细胞数">${dapiDisplay}</td><td>${targetStatus(view.id,"nk")==="done"?c.nk.total:"—"}</td><td>${targetStatus(view.id,"tumor")==="done"?c.tumor.total:"—"}</td><td>${dapiMinusNk}</td><td>${pendingReview||"—"}</td><td>${corrected}</td><td class="status-${overallStatus(view)}" title="${escapeHtml(viewIssueText(view))}">${escapeHtml(status)}</td></tr>`;
  }).join("");
}

function canvasPoint(event) {
  const canvas=$("overlayCanvas"),rect=canvas.getBoundingClientRect();
  return {x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height};
}
function detectionAtPoint(point) {
  const candidates=state.detections.filter(item=>!item.deleted);
  const pixelX=Math.round(point.x), pixelY=Math.round(point.y);
  const inside=candidates.find(item=>{
    const runs=detectionRuns(item);
    if (!runs.length) return false;
    for (let index=0; index<runs.length; index+=3) {
      if (runs[index]===pixelY && pixelX>=runs[index+1] && pixelX<=runs[index+2]) return true;
    }
    return false;
  });
  if (inside) return inside;
  let best=null,distance=Infinity;
  candidates.forEach(item=>{
    const d=Math.hypot(item.x-point.x,item.y-point.y);
    if(d<Math.max(20,item.radius*1.5)&&d<distance){best=item;distance=d;}
  });
  return best;
}
function updateReviewControls() {
  const item=state.detections.find(detection=>detection.id===state.selectedId&&!detection.deleted);
  $("confirmDetectionBtn").disabled=!item||Boolean(item.reviewed&&!item.review_required);
  $("confirmDetectionBtn").textContent=item?.review_required?"确认保留":"标记正确";
  if(!item){
    $("selectionHint").textContent="点击 Cell-ID 查看核数；黄色轮廓需要复核";
    return;
  }
  const nuclei=detectionNucleusCount(item),reason=reviewReasonsText(item);
  $("selectionHint").textContent=`${item.cell_id||item.cell_instance_id||item.id}${nuclei?` · ${nuclei} 核`:""}${reason?` · ${reason}`:" · 已确认"}`;
}
async function nextReviewRequired() {
  if(!state.project||state.busy)return;
  const current=viewById(state.currentViewId),views=groupViews(current.group);
  const start=Math.max(0,views.findIndex(view=>view.id===current.id));
  for(let offset=0;offset<views.length;offset++){
    const view=views[(start+offset)%views.length];
    const candidate=(targetResult(view.id,state.target)?.detections||[]).find(item=>!item.deleted&&item.review_required);
    if(!candidate)continue;
    if(view.id!==state.currentViewId)await selectView(view.id);
    state.detections=targetResult(view.id,state.target)?.detections||[];
    state.selectedId=candidate.id;updateReviewControls();drawOverlay();
    return;
  }
  toast(`当前文件夹的 ${targetLabel(state.target)} 没有待复核对象`);
}
function confirmSelectedDetection() {
  if(state.busy)return toast("正在分析或导出，请完成后再复核",true);
  const item=state.detections.find(detection=>detection.id===state.selectedId&&!detection.deleted);
  if(!item)return toast("请先选择一个 Cell-ID",true);
  pushHistory("cell");
  recordLearningFeedback(item,"positive");
  item.review_required=false;item.reviewed=true;item.manual=true;item.reviewed_at=new Date().toISOString();
  const id=item.cell_id||item.cell_instance_id||item.id;
  syncCorrections(false);$("selectionHint").textContent=`已确认保留 ${id}`;
}
function handleCanvasClick(event) {
  if(state.busy)return toast("正在分析或导出，请完成后再进行人工修正",true);
  if (state.mode==="pan") return;
  if (!targetResult(state.currentViewId)?.detections) return toast(`请先预跑当前视野的 ${targetLabel(state.target)}`);
  const point=canvasPoint(event);
  if (state.mode==="add") {
    pushHistory("cell");
    const pixelSize=viewById(state.currentViewId)?.pixel_size_um||state.project.pixel_size_um;
    const id=`manual-${Date.now()}`;
    const added={
      id,cell_instance_id:state.target==="dapi"?null:id,object_type:state.target==="dapi"?"nucleus":"marker_cell_instance",
      nucleus_ids:[],nucleus_labels:[],nuclei_per_cell:0,review_required:false,review_reasons:[],reviewed:true,
      x:point.x,y:point.y,area_px:452.39,area_um2:452.39*pixelSize**2,radius:12,circularity:1,
      classification:state.target,manual:true,deleted:false,
    };
    state.detections.push(added);
    recordLearningFeedback(added,"positive");
    syncCorrections(true); return;
  }
  const best=detectionAtPoint(point);
  if (state.mode==="delete") {
    if (!best) { $("selectionHint").textContent="未点中细胞标记"; return; }
    pushHistory("cell");
    recordLearningFeedback(best,"negative");
    best.deleted=true; best.manual=true;
    syncCorrections(true);
    $("selectionHint").textContent=`已删除 ${best.id}`;
    return;
  }
  state.selectedId=best?.id||null;
  updateReviewControls();
  drawOverlay();
}
function syncCorrections(dapiGeometryChanged=true) {
  state.project.results[state.currentViewId][state.target].detections=state.detections;
  if(state.target==="dapi"){
    const view=viewById(state.currentViewId);
    if(dapiGeometryChanged)invalidateGuidedDependents(view,true);
    refreshDapiGroupQc(view.group);
  }
  state.selectedId=null; updateCounts(); renderInspectionView(); renderResults();renderGroups();
  scheduleAutosave();
}
function reclassify(classification) {
  if(state.busy)return toast("正在分析或导出，请完成后再进行人工修正",true);
  const item=state.detections.find(d=>d.id===state.selectedId); if(!item)return;
  item.classification=state.target;item.manual=true;syncCorrections(false);
}
function deleteSelected() {
  if(state.busy)return toast("正在分析或导出，请完成后再进行人工修正",true);
  const item=state.detections.find(d=>d.id===state.selectedId);
  if(!item) return toast("请先选择要删除的细胞标记",true);
  pushHistory("cell");
  recordLearningFeedback(item,"negative");
  item.deleted=true;item.manual=true;syncCorrections(true);
  $("selectionHint").textContent=`已删除 ${item.id}`;
}

function serializableProject() {
  const serializedResults={};
  for (const [viewId,viewResult] of Object.entries(state.project.results)) {
    serializedResults[viewId]={};
    for (const target of TARGETS) {
      if (!viewResult[target]) continue;
      serializedResults[viewId][target]={
        ...viewResult[target],
        detections:(viewResult[target].detections||[]).map(deflateDetection)
      };
    }
  }
  return {
    version:6,browserVersion:true,name:state.project.name,pixel_size_um:state.project.pixel_size_um,
    suffixes:state.project.suffixes,channel_labels:state.project.channel_labels,
    selected_groups:[...state.selectedGroups],
    learning_data:typeof CellScopeLearning==="undefined"?null:CellScopeLearning.exportData(),
    groups:state.project.groups,parameters_by_group:state.project.parameters_by_group,
    views:state.project.views.map(view=>({
      id:view.id,group:view.group,name:view.name,width:view.width,height:view.height,status:view.status,
      error:view.error,import_error:view.import_error,fileNames:view.fileNames,file_fingerprints:viewFileFingerprints(view),
      channel_mapping:view.channel_mapping,channel_mapping_source:view.channel_mapping_source,
      channel_lut_order:view.channel_lut_order,pixel_size_um:view.pixel_size_um
    })),
    results:serializedResults,updated_at:new Date().toISOString(),
  };
}
function openAutosaveDb() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open("cellscope-projects",1);
    request.onupgradeneeded=()=>request.result.createObjectStore("projects",{keyPath:"name"});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function restoreAutosave(name) {
  try {
    const db=await openAutosaveDb();
    const saved=await new Promise((resolve,reject)=>{
      const request=db.transaction("projects","readonly").objectStore("projects").get(name);
      request.onsuccess=()=>resolve(request.result?.project||null);
      request.onerror=()=>reject(request.error);
    });
    db.close();
    if(saved){
      state.pendingProject=saved;
      $("autosaveStatus").textContent="发现自动保存";
      $("autosaveStatus").className="autosave-status saved";
    }
  } catch(error) {
    console.warn("自动保存读取失败",error);
  }
}
function scheduleAutosave() {
  if(!state.project)return;
  clearTimeout(state.autosaveTimer);
  $("autosaveStatus").textContent="等待保存";
  $("autosaveStatus").className="autosave-status saving";
  state.autosaveTimer=setTimeout(saveAutosave,1200);
}
async function saveAutosave() {
  if(!state.project)return;
  const name=state.project.name;
  $("autosaveStatus").textContent="保存中…";
  $("autosaveStatus").className="autosave-status saving";
  try{
    const project=serializableProject();
    const db=await openAutosaveDb();
    await new Promise((resolve,reject)=>{
      const request=db.transaction("projects","readwrite").objectStore("projects").put({
        name,project,savedAt:new Date().toISOString()
      });
      request.onsuccess=()=>resolve();
      request.onerror=()=>reject(request.error);
    });
    db.close();
    if(state.project?.name===name){
      $("autosaveStatus").textContent="已自动保存";
      $("autosaveStatus").className="autosave-status saved";
    }
  }catch(error){
    console.warn("自动保存失败",error);
    $("autosaveStatus").textContent="自动保存失败";
    $("autosaveStatus").className="autosave-status";
  }
}
function cloneResult(value) {
  return value ? structuredClone(value) : null;
}
function dapiGeometrySignature(result) {
  return JSON.stringify((result?.detections||[]).map(item=>[
    String(item.id),Boolean(item.deleted),Number(item.x),Number(item.y),Number(item.radius),Number(item.area_px),detectionRuns(item)
  ]).sort((left,right)=>left[0].localeCompare(right[0])));
}
function historySnapshot(kind,viewId=state.currentViewId,target=state.target) {
  return {
    kind,viewId,target,value:cloneResult(state.project.results[viewId]?.[target]),
    learning:typeof CellScopeLearning==="undefined"?null:CellScopeLearning.exportData(),
  };
}
function pushHistory(kind,viewId=state.currentViewId,target=state.target) {
  state.undoStack.push(historySnapshot(kind,viewId,target));
  if(state.undoStack.length>60)state.undoStack.shift();
  state.redoStack=[];
  updateHistoryButtons();
}
function updateHistoryButtons() {
  if(!$("undoBtn"))return;
  $("undoBtn").disabled=!state.undoStack.length;
  $("redoBtn").disabled=!state.redoStack.length;
}
async function restoreHistorySnapshot(snapshot) {
  if(!snapshot||!state.project)return;
  if(!state.project.results[snapshot.viewId])state.project.results[snapshot.viewId]={};
  const geometryChanged=snapshot.target==="dapi"&&dapiGeometrySignature(state.project.results[snapshot.viewId][snapshot.target])!==dapiGeometrySignature(snapshot.value);
  state.project.results[snapshot.viewId][snapshot.target]=cloneResult(snapshot.value);
  if(snapshot.learning&&typeof CellScopeLearning!=="undefined")CellScopeLearning.importData(snapshot.learning,{replace:true});
  if(geometryChanged)invalidateGuidedDependents(viewById(snapshot.viewId),true);
  if(snapshot.target==="dapi")refreshDapiGroupQc(viewById(snapshot.viewId).group);
  if(snapshot.viewId!==state.currentViewId)await selectView(snapshot.viewId);
  if(state.target!==snapshot.target)await setTarget(snapshot.target);
  state.detections=targetResult(snapshot.viewId,snapshot.target)?.detections||[];
  state.selectedId=null;
  updateCounts();renderResults();renderGroups();renderInspectionView();updateLearningStatus();scheduleAutosave();
}
async function undoCorrection() {
  if(state.busy)return toast("正在分析或导出，请完成后再撤销人工修正",true);
  const snapshot=state.undoStack.pop();
  if(!snapshot)return;
  state.redoStack.push(historySnapshot(snapshot.kind,snapshot.viewId,snapshot.target));
  await restoreHistorySnapshot(snapshot);updateHistoryButtons();toast("已撤销上一次人工修正");
}
async function redoCorrection() {
  if(state.busy)return toast("正在分析或导出，请完成后再重做人工修正",true);
  const snapshot=state.redoStack.pop();
  if(!snapshot)return;
  state.undoStack.push(historySnapshot(snapshot.kind,snapshot.viewId,snapshot.target));
  await restoreHistorySnapshot(snapshot);updateHistoryButtons();toast("已重做人工修正");
}
function encodeRuns(runs) {
  if (!runs?.length) return "";
  const values=new Uint16Array(runs);
  const bytes=new Uint8Array(values.buffer);
  let binary="";
  const chunk=0x8000;
  for (let offset=0;offset<bytes.length;offset+=chunk) {
    binary+=String.fromCharCode(...bytes.subarray(offset,offset+chunk));
  }
  return btoa(binary);
}
function decodeRuns(encoded) {
  if (!encoded) return [];
  const binary=atob(encoded);
  const bytes=new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return Array.from(new Uint16Array(bytes.buffer));
}
function deflateDetection(detection) {
  const output={...detection};
  if (output.runs?.length) output.mask_rle=encodeRuns(output.runs);
  if (output.signal_runs?.length) output.signal_mask_rle=encodeRuns(output.signal_runs);
  delete output.runs;
  delete output.signal_runs;
  return output;
}
function inflateDetection(detection) {
  const output={...detection};
  if (!output.runs?.length&&output.mask_rle) output.runs=decodeRuns(output.mask_rle);
  if (!output.signal_runs?.length&&output.signal_mask_rle) output.signal_runs=decodeRuns(output.signal_mask_rle);
  delete output.mask_rle;
  delete output.signal_mask_rle;
  return output;
}
function downloadBlob(blob,name) {
  const url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function safeFileName(value) {
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]/g,"_").replace(/[. ]+$/g,"").trim() || "unnamed";
}
async function writeLocalFile(directory,name,data) {
  const handle=await directory.getFileHandle(safeFileName(name),{create:true});
  const writable=await handle.createWritable();
  await writable.write(data);
  await writable.close();
}
async function nestedDirectory(directory,path) {
  let current=directory;
  for (const segment of String(path).split(/[\\/]+/).filter(Boolean)) {
    current=await current.getDirectoryHandle(safeFileName(segment),{create:true});
  }
  return current;
}
function safeRelativePath(path) {
  return String(path).split(/[\\/]+/).filter(Boolean).map(safeFileName).join("/");
}
function exportRunStamp(date=new Date()) {
  const pad=value=>String(value).padStart(2,"0");
  return `${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${String(date.getMilliseconds()).padStart(3,"0")}`;
}
const ZIP_CRC_TABLE=(()=>{
  const table=new Uint32Array(256);
  for(let index=0;index<256;index++){
    let value=index;
    for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;
    table[index]=value>>>0;
  }
  return table;
})();
function zipDosTime(date=new Date()) {
  const year=Math.max(1980,date.getFullYear());
  return{
    time:(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1),
    date:((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate(),
  };
}
async function blobCrc32(blob) {
  let crc=0xffffffff;
  const reader=blob.stream().getReader();
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    for(const byte of value)crc=ZIP_CRC_TABLE[(crc^byte)&0xff]^(crc>>>8);
  }
  return(crc^0xffffffff)>>>0;
}
function zipView(size) {
  const bytes=new Uint8Array(size);
  return{bytes,view:new DataView(bytes.buffer)};
}
class BrowserZipArchive {
  constructor(){this.parts=[];this.entries=[];this.offset=0;this.encoder=new TextEncoder();}
  async add(path,data) {
    const blob=data instanceof Blob?data:new Blob([data]);
    if(blob.size>0xffffffff||this.offset>0xffffffff)throw new Error("导出内容超过 ZIP 兼容大小（4 GB）");
    const name=this.encoder.encode(safeRelativePath(path));
    const crc=await blobCrc32(blob),stamp=zipDosTime();
    const {bytes,view}=zipView(30);
    view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x0800,true);
    view.setUint16(8,0,true);view.setUint16(10,stamp.time,true);view.setUint16(12,stamp.date,true);
    view.setUint32(14,crc,true);view.setUint32(18,blob.size,true);view.setUint32(22,blob.size,true);
    view.setUint16(26,name.length,true);view.setUint16(28,0,true);
    this.parts.push(bytes,name,blob);
    this.entries.push({name,crc,size:blob.size,offset:this.offset,...stamp});
    this.offset+=bytes.length+name.length+blob.size;
  }
  finish() {
    const central=[],centralStart=this.offset;
    let centralSize=0;
    for(const entry of this.entries){
      const {bytes,view}=zipView(46);
      view.setUint32(0,0x02014b50,true);view.setUint16(4,20,true);view.setUint16(6,20,true);
      view.setUint16(8,0x0800,true);view.setUint16(10,0,true);view.setUint16(12,entry.time,true);view.setUint16(14,entry.date,true);
      view.setUint32(16,entry.crc,true);view.setUint32(20,entry.size,true);view.setUint32(24,entry.size,true);
      view.setUint16(28,entry.name.length,true);view.setUint16(30,0,true);view.setUint16(32,0,true);
      view.setUint16(34,0,true);view.setUint16(36,0,true);view.setUint32(38,0,true);view.setUint32(42,entry.offset,true);
      central.push(bytes,entry.name);centralSize+=bytes.length+entry.name.length;
    }
    const {bytes:end,view}=zipView(22);
    view.setUint32(0,0x06054b50,true);view.setUint16(4,0,true);view.setUint16(6,0,true);
    view.setUint16(8,this.entries.length,true);view.setUint16(10,this.entries.length,true);
    view.setUint32(12,centralSize,true);view.setUint32(16,centralStart,true);view.setUint16(20,0,true);
    return new Blob([...this.parts,...central,end],{type:"application/zip"});
  }
}
const XLSX_MIME="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function xlsxPlainText(value) {
  let output="";
  for(const character of String(value??"")){
    const code=character.codePointAt(0);
    if(code<=8||code===11||code===12||(code>=14&&code<=31)||code===0xfffe||code===0xffff)continue;
    output+=(code>=0xd800&&code<=0xdfff)?"\ufffd":character;
  }
  return output;
}
function xlsxXml(value) {
  return xlsxPlainText(value)
    .replace(/_x[0-9a-f]{4}_/gi,match=>`_x005F_${match.slice(1)}`)
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&apos;");
}
function xlsxTruncate(value,limit) {
  let output="",length=0;
  for(const character of value){
    if(length+character.length>limit)break;
    output+=character;length+=character.length;
  }
  return output;
}
function xlsxSheetBase(value,limit=31) {
  const cleaned=xlsxPlainText(value).replace(/[\\/?*\[\]:]/g,"_").trim();
  return xlsxTruncate(cleaned,limit).replace(/^'+|'+$/g,"").trim()||"实验组";
}
function xlsxColumn(index) {
  let output="";
  for(let value=index+1;value;value=Math.floor((value-1)/26))output=String.fromCharCode(65+(value-1)%26)+output;
  return output;
}
function xlsxSheetNames(groups) {
  const key=value=>xlsxPlainText(value).normalize("NFC").toLocaleLowerCase(),used=new Set(["汇总","说明"].map(key)),names=new Map();
  for(const group of groups){
    let base=xlsxSheetBase(group);
    if(/^history$/i.test(base))base="History_";
    let name=base,suffix=2;
    while(used.has(key(name))){
      const tail=`_${suffix++}`;name=xlsxSheetBase(base,31-tail.length)+tail;
    }
    used.add(key(name));names.set(group,name);
  }
  return names;
}
function xlsxSheetRef(name) { return `'${String(name).replaceAll("'","''")}'`; }
function xlsxCellXml(row,column,cell) {
  const descriptor=cell&&typeof cell==="object"&&Object.hasOwn(cell,"value")?cell:{value:cell};
  const value=descriptor.value,formula=descriptor.formula;
  if(value==null&&!formula)return "";
  const reference=`${xlsxColumn(column)}${row}`,style=descriptor.style?` s="${descriptor.style}"`:"";
  if(formula){
    const cached=Number.isFinite(Number(value))?`<v>${Number(value)}</v>`:"";
    return `<c r="${reference}"${style}><f>${xlsxXml(String(formula).replace(/^=/,""))}</f>${cached}</c>`;
  }
  if(typeof value==="number"&&Number.isFinite(value))return `<c r="${reference}"${style}><v>${value}</v></c>`;
  if(typeof value==="boolean")return `<c r="${reference}"${style} t="b"><v>${value?1:0}</v></c>`;
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xlsxXml(value)}</t></is></c>`;
}
function xlsxRowXml(number,cells,height=null) {
  const content=cells.map((cell,index)=>xlsxCellXml(number,index,cell)).join("");
  return `<row r="${number}"${height?` ht="${height}" customHeight="1"`:""}>${content}</row>`;
}
function xlsxWorksheetXml({rows,columnWidths,dimension,freeze,merges=[],autoFilter=""}) {
  const columns=columnWidths.map((width,index)=>`<col min="${index+1}" max="${index+1}" width="${width}" customWidth="1"/>`).join("");
  const pane=freeze?`<pane${freeze.x?` xSplit="${freeze.x}"`:""}${freeze.y?` ySplit="${freeze.y}"`:""} topLeftCell="${freeze.topLeft}" activePane="${freeze.x&&freeze.y?"bottomRight":freeze.x?"topRight":"bottomLeft"}" state="frozen"/>`:"";
  const merged=merges.length?`<mergeCells count="${merges.length}">${merges.map(ref=>`<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`:"";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0" showGridLines="1">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${columns}</cols><sheetData>${rows.join("")}</sheetData>${autoFilter?`<autoFilter ref="${autoFilter}"/>`:""}${merged}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
}
function xlsxStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.0"/><numFmt numFmtId="165" formatCode="0.000"/></numFmts><fonts count="4"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="16"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font><font><i/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FFBFBFBF"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="12"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="2" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1"/><xf numFmtId="164" fontId="2" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
}
function xlsxResultRecord(view) {
  const counts=viewCounts(view.id),status=Object.fromEntries(TARGETS.map(target=>[target,targetStatus(view.id,target)]));
  const values=Object.fromEntries(TARGETS.map(target=>[target,status[target]==="done"?counts[target].total:null]));
  return{
    view,counts,status,...values,
    dapiCells:counts.dapi.cells,
    dapiMinusNk:counts.dapi.cells!=null&&values.nk!=null?counts.dapi.cells-values.nk:null,
    review:counts.nk.review+counts.tumor.review,
    corrected:counts.dapi.corrected+counts.nk.corrected+counts.tumor.corrected,
    complete:TARGETS.every(target=>status[target]==="done"),
    issue:Boolean(viewIssueText(view))||TARGETS.some(target=>status[target]!=="done"),
  };
}
function xlsxSum(values) { return values.filter(Number.isFinite).reduce((sum,value)=>sum+value,0); }
function xlsxMean(values) { const numbers=values.filter(Number.isFinite);return numbers.length?xlsxSum(numbers)/numbers.length:0; }
function xlsxAggregate(values,style,formula,average=false) {
  const numbers=values.filter(Number.isFinite);
  return numbers.length?{value:average?xlsxMean(numbers):xlsxSum(numbers),style,formula}:null;
}
async function cellCountWorkbookBlob(processedGroups) {
  const groupSheetNames=xlsxSheetNames(processedGroups),exportedAt=new Date();
  const sheetModels=[],groupRecords=new Map(processedGroups.map(group=>[group,groupViews(group).map(xlsxResultRecord)]));
  const labels={dapi:targetLabel("dapi"),nk:targetLabel("nk"),tumor:targetLabel("tumor")};
  const summaryRows=[
    xlsxRowXml(1,[{value:`${state.project.name} 细胞计数汇总`,style:1}],28),
    xlsxRowXml(2,[{value:"网页当前计数结果；空白表示相应通道尚未完成，建议结合标注图复核。",style:3}],26),
    xlsxRowXml(4,["文件夹","视野数","三通道完成",`${labels.dapi} 核总数`,`${labels.nk} 细胞总数`,`${labels.tumor} 细胞总数`,`${labels.dapi}细胞-${labels.nk} 总数`,`平均 ${labels.dapi} 核`,`平均 ${labels.nk}`,`平均 ${labels.tumor}`,"人工修正总数","错误/QC/未完成视野",`${labels.dapi} 推算细胞总数`,`平均 ${labels.dapi} 推算细胞`,`${labels.nk} 待复核`,`${labels.tumor} 待复核`,"待复核总数"].map(value=>({value,style:4})),32),
  ];
  processedGroups.forEach((group,index)=>{
    const records=groupRecords.get(group),row=5+index,first=6,last=5+records.length,sheet=xlsxSheetRef(groupSheetNames.get(group));
    const dapi=records.map(record=>record.dapi),nk=records.map(record=>record.nk),tumor=records.map(record=>record.tumor),difference=records.map(record=>record.dapiMinusNk),dapiCells=records.map(record=>record.dapiCells);
    summaryRows.push(xlsxRowXml(row,[
      {value:group,style:11},{value:records.length,style:5},{value:records.filter(record=>record.complete).length,style:5},
      xlsxAggregate(dapi,5,`SUM(${sheet}!B${first}:B${last})`),
      xlsxAggregate(nk,5,`SUM(${sheet}!C${first}:C${last})`),
      xlsxAggregate(tumor,5,`SUM(${sheet}!D${first}:D${last})`),
      xlsxAggregate(difference,5,`SUM(${sheet}!E${first}:E${last})`),
      xlsxAggregate(dapi,6,`AVERAGE(${sheet}!B${first}:B${last})`,true),
      xlsxAggregate(nk,6,`AVERAGE(${sheet}!C${first}:C${last})`,true),
      xlsxAggregate(tumor,6,`AVERAGE(${sheet}!D${first}:D${last})`,true),
      {value:xlsxSum(records.map(record=>record.corrected)),style:5},
      {value:records.filter(record=>record.issue).length,style:5},
      xlsxAggregate(dapiCells,5,`SUM(${sheet}!S${first}:S${last})`),
      xlsxAggregate(dapiCells,6,`AVERAGE(${sheet}!S${first}:S${last})`,true),
      {value:xlsxSum(records.map(record=>record.counts.nk.review)),style:5,formula:`SUM(${sheet}!T${first}:T${last})`},
      {value:xlsxSum(records.map(record=>record.counts.tumor.review)),style:5,formula:`SUM(${sheet}!U${first}:U${last})`},
      {value:xlsxSum(records.map(record=>record.review)),style:5,formula:`SUM(${sheet}!V${first}:V${last})`},
    ]));
  });
  sheetModels.push({name:"汇总",xml:xlsxWorksheetXml({rows:summaryRows,columnWidths:[18,11,14,14,14,14,20,15,15,15,17,20,20,20,16,16,16],dimension:`A1:Q${4+processedGroups.length}`,freeze:{x:1,y:4,topLeft:"B5"},merges:["A1:Q1","A2:Q2"],autoFilter:`A4:Q${4+processedGroups.length}`})});
  const processedViews=[...groupRecords.values()].flat(),noteRows=[
    ["项目","内容","状态/参数","使用建议"],
    ["导出范围",`${state.project.name}：${processedGroups.length} 个文件夹，共 ${processedViews.length} 个视野。`,`导出时间 ${exportedAt.toLocaleString("zh-CN")}`,"每个文件夹对应一个独立工作表。"],
    ["通道映射","优先按 Leica XML 的 LUT 名称逐视野识别通道。","不固定假定 ch00/ch01/ch02。","请在汇总和组工作表查看缺失或错误状态。"],
    [labels.dapi,"阈值分割后进行形态学清理、分水岭及面积/圆度过滤。","参数按文件夹独立保存。","正式统计前建议抽查标注轮廓。"],
    [`${labels.nk}/${labels.tumor}`,`以 ${labels.dapi} 核校验局部背景校正信号，再按连续轮廓建立独立 Cell-ID。`,"同一 Cell-ID 可以包含多个核。","黄色多核、过大或触边对象应优先复核。"],
    [`${labels.dapi} 推算细胞数`,`由红绿 Cell-ID 中共享的多个 ${labels.dapi} 核合并推算。`,"红绿实例均完成后显示。","原始 ${labels.dapi} 核数始终单独保留。"],
    [`${labels.dapi}细胞-${labels.nk}`,`按 ${labels.dapi} 推算细胞数减 ${labels.nk} 细胞数计算。`,"相关实例分析完成后显示。","可与红色通道结果交叉核对。"],
    ["人工修正","修正数包含人工添加、删除或修改。","原始自动结果和修正保存在项目 JSON。","完整导出同时保留逐对象 CSV 和标注图。"],
    ["缺失/未完成","对应计数在 Excel 中留空，不自动写成 0。","状态和错误列保留原因。","补齐通道或完成分析后重新导出。"],
    ["数据解释","自动计数是可重复的图像定量工具，不等同于生物学验证。","阈值需按实验校准。","低背景、高背景、密集和稀疏视野均应抽查。"],
  ];
  const notes=[xlsxRowXml(1,[{value:"结果说明与自动计数口径",style:1}],28),xlsxRowXml(3,noteRows[0].map(value=>({value,style:4})),28)];
  noteRows.slice(1).forEach((row,index)=>notes.push(xlsxRowXml(4+index,row.map((value,column)=>({value,style:column===0?11:10})),45)));
  sheetModels.push({name:"说明",xml:xlsxWorksheetXml({rows:notes,columnWidths:[18,58,38,48],dimension:`A1:D${2+noteRows.length}`,freeze:{y:3,topLeft:"A4"},merges:["A1:D1"]})});
  const statusText={pending:"未分析",running:"分析中",done:"完成",error:"错误"};
  for(const group of processedGroups){
    const records=groupRecords.get(group),dataStart=6,dataEnd=5+records.length,totalRow=dataEnd+2,meanRow=dataEnd+3;
    const rows=[
      xlsxRowXml(1,[{value:`${group} — 逐视野细胞计数`,style:1}],28),
      xlsxRowXml(2,[{value:`视野数：${records.length}　｜　通道按逐视野 XML/后缀映射　｜　导出：${exportedAt.toLocaleString("zh-CN")}`,style:2}],22),
      xlsxRowXml(3,[{value:`${labels.dapi}细胞-${labels.nk} 为 Excel 公式；空白表示细胞实例尚未完成。人工修正数包含添加、删除、确认或修改。`,style:3}],24),
      xlsxRowXml(5,["视野",`${labels.dapi}核数`,`${labels.nk}细胞数`,`${labels.tumor}细胞数`,`${labels.dapi}细胞-${labels.nk}`,`${labels.dapi}修正数`,`${labels.nk}修正数`,`${labels.tumor}修正数`,"修正总数",`${labels.dapi}状态`,`${labels.nk}状态`,`${labels.tumor}状态`,`${labels.dapi}文件`,`${labels.nk}/绿文件`,`${labels.tumor}/红文件`,"通道映射","像素大小 µm/px","错误/QC",`${labels.dapi}推算细胞数`,`${labels.nk}待复核`,`${labels.tumor}待复核`,"待复核总数"].map(value=>({value,style:4})),34),
    ];
    records.forEach((record,index)=>{
      const row=dataStart+index,files=record.view.fileNames||{};
      rows.push(xlsxRowXml(row,[
        {value:record.view.name,style:11},{value:record.dapi,style:5},{value:record.nk,style:5},{value:record.tumor,style:5},
        record.dapiMinusNk==null?null:{value:record.dapiMinusNk,style:5,formula:`S${row}-C${row}`},
        {value:record.counts.dapi.corrected,style:5},{value:record.counts.nk.corrected,style:5},{value:record.counts.tumor.corrected,style:5},{value:record.corrected,style:5},
        {value:statusText[record.status.dapi],style:10},{value:statusText[record.status.nk],style:10},{value:statusText[record.status.tumor],style:10},
        {value:files.dapi||"",style:10},{value:files.nk||"",style:10},{value:files.tumor||"",style:10},
        {value:`${record.view.channel_mapping_source==="leica_xml"?"Leica XML":"手动后缀"}：${channelMappingText(record.view.channel_mapping)}`,style:10},
        {value:record.view.pixel_size_um||state.project.pixel_size_um,style:7},{value:viewIssueText(record.view),style:10},
        {value:record.dapiCells,style:5},{value:record.counts.nk.review,style:5},{value:record.counts.tumor.review,style:5},{value:record.review,style:5},
      ]));
    });
    const valueColumns=[records.map(record=>record.dapi),records.map(record=>record.nk),records.map(record=>record.tumor),records.map(record=>record.dapiMinusNk),records.map(record=>record.counts.dapi.corrected),records.map(record=>record.counts.nk.corrected),records.map(record=>record.counts.tumor.corrected),records.map(record=>record.corrected)];
    const reviewColumns=[records.map(record=>record.dapiCells),records.map(record=>record.counts.nk.review),records.map(record=>record.counts.tumor.review),records.map(record=>record.review)];
    rows.push(xlsxRowXml(totalRow,[{value:"合计",style:11},...valueColumns.map((values,index)=>xlsxAggregate(values,8,`SUM(${xlsxColumn(index+1)}${dataStart}:${xlsxColumn(index+1)}${dataEnd})`)),...Array(9).fill(null),...reviewColumns.map((values,index)=>xlsxAggregate(values,8,`SUM(${xlsxColumn(index+18)}${dataStart}:${xlsxColumn(index+18)}${dataEnd})`))]));
    rows.push(xlsxRowXml(meanRow,[{value:"均值",style:11},...valueColumns.map((values,index)=>xlsxAggregate(values,9,`AVERAGE(${xlsxColumn(index+1)}${dataStart}:${xlsxColumn(index+1)}${dataEnd})`,true)),...Array(9).fill(null),...reviewColumns.map((values,index)=>xlsxAggregate(values,9,`AVERAGE(${xlsxColumn(index+18)}${dataStart}:${xlsxColumn(index+18)}${dataEnd})`,true))]));
    sheetModels.push({name:groupSheetNames.get(group),xml:xlsxWorksheetXml({rows,columnWidths:[17,13,13,13,20,14,14,14,14,13,13,13,25,25,25,28,17,48,20,16,16,16],dimension:`A1:V${meanRow}`,freeze:{x:1,y:5,topLeft:"B6"},merges:["A1:V1","A2:V2","A3:V3"],autoFilter:`A5:V${dataEnd}`})});
  }
  const archive=new BrowserZipArchive(),sheetOverrides=sheetModels.map((_,index)=>`<Override PartName="/xl/worksheets/sheet${index+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  await archive.add("[Content_Types].xml",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`);
  await archive.add("_rels/.rels",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  await archive.add("xl/workbook.xml",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetModels.map((sheet,index)=>`<sheet name="${xlsxXml(sheet.name)}" sheetId="${index+1}" r:id="rId${index+1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`);
  await archive.add("xl/_rels/workbook.xml.rels",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetModels.map((_,index)=>`<Relationship Id="rId${index+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index+1}.xml"/>`).join("")}<Relationship Id="rId${sheetModels.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  await archive.add("xl/styles.xml",xlsxStylesXml());
  for(let index=0;index<sheetModels.length;index++)await archive.add(`xl/worksheets/sheet${index+1}.xml`,sheetModels[index].xml);
  return new Blob([archive.finish()],{type:XLSX_MIME});
}
async function createDirectoryExportSink(parent,rootName) {
  const root=await parent.getDirectoryHandle(rootName,{create:true});
  const directories=new Map([["",root]]);
  async function getDirectory(path) {
    const clean=safeRelativePath(path);
    if(directories.has(clean))return directories.get(clean);
    const handle=await nestedDirectory(root,clean);directories.set(clean,handle);return handle;
  }
  return{
    kind:"directory",
    async write(path,data){
      const clean=safeRelativePath(path),slash=clean.lastIndexOf("/");
      const directory=await getDirectory(slash<0?"":clean.slice(0,slash));
      await writeLocalFile(directory,slash<0?clean:clean.slice(slash+1),data);
    },
    async finish(){},
  };
}
function createZipExportSink(rootName) {
  const archive=new BrowserZipArchive();
  return{
    kind:"zip",
    write:(path,data)=>archive.add(`${rootName}/${path}`,data),
    async finish(){downloadBlob(archive.finish(),`${rootName}.zip`);},
  };
}
function isFileSystemAccessError(error) {
  return ["NotAllowedError","SecurityError","InvalidStateError"].includes(error?.name)
    || /not allowed|permission|user agent|platform|current context|getDirectoryHandle|createWritable/i.test(error?.message||"");
}
function canvasBlob(canvas) {
  return new Promise((resolve,reject)=>canvas.toBlob(
    blob=>blob?resolve(blob):reject(new Error("无法生成 PNG")),
    "image/png"
  ));
}
async function annotatedBlob(view,target) {
  const decoded=await decodeRgba(view.files[target]);
  const canvas=document.createElement("canvas");
  canvas.width=decoded.width;canvas.height=decoded.height;
  const context=canvas.getContext("2d");
  context.putImageData(new ImageData(decoded.rgba,decoded.width,decoded.height),0,0);
  const detections=(targetResult(view.id,target)?.detections||[]).filter(item=>!item.deleted);
  const mask=buildDetectionMask(decoded.width,decoded.height,detections);
  context.drawImage(outlineMask(mask,colors[target],2),0,0);
  const reviewDetections=detections.filter(item=>item.review_required);
  if(reviewDetections.length){
    const reviewMask=buildDetectionMask(decoded.width,decoded.height,reviewDetections);
    context.drawImage(outlineMask(reviewMask,"#ffb84d",4),0,0);
    reviewMask.width=1;reviewMask.height=1;
  }
  detections.forEach((item,index)=>{
    const fontSize=Math.max(13,Math.min(24,(item.radius||12)*0.8));
    context.font=`700 ${fontSize}px system-ui`;
    context.textAlign="center";context.textBaseline="middle";context.lineWidth=3;
    context.strokeStyle="rgba(0,0,0,.85)";context.fillStyle="#fff";
    const label=detectionDisplayLabel(item,index+1);
    context.strokeText(label,item.x,item.y);
    context.fillText(label,item.x,item.y);
  });
  const title=`${view.group} / ${view.name} · ${targetLabel(target)} · n=${detections.length} · 待复核 ${reviewDetections.length}`;
  context.font="700 22px system-ui";context.textAlign="left";context.textBaseline="top";
  const titleWidth=Math.min(decoded.width-24,context.measureText(title).width+28);
  context.fillStyle="rgba(0,0,0,.72)";context.fillRect(12,12,titleWidth,44);
  context.fillStyle="#fff";context.fillText(title,26,23,decoded.width-52);
  const blob=await canvasBlob(canvas);
  canvas.width=1;canvas.height=1;mask.width=1;mask.height=1;
  return blob;
}
function csvText(views=state.project.views) {
  const headers=[
    "实验组","视野",
    `${targetLabel("dapi")}核数`,`${targetLabel("dapi")}推算细胞数`,
    `${targetLabel("nk")}细胞数`,`${targetLabel("tumor")}细胞数`,
    `${targetLabel("dapi")}细胞-${targetLabel("nk")}`,
    `${targetLabel("nk")}待复核`,`${targetLabel("tumor")}待复核`,"待复核总数",
    ...TARGETS.map(target=>`${targetLabel(target)}修正数`),
    ...TARGETS.map(target=>`${targetLabel(target)}状态`),
    "DAPI原始文件","NK原始文件","肿瘤原始文件","通道映射来源","像素尺寸_um_per_px",
    "错误/QC"
  ];
  const rows=views.map(view=>{
    const c=viewCounts(view.id);
    return [
      view.group,view.name,
      targetStatus(view.id,"dapi")==="done"?c.dapi.total:"",
      c.dapi.cells??"",
      targetStatus(view.id,"nk")==="done"?c.nk.total:"",
      targetStatus(view.id,"tumor")==="done"?c.tumor.total:"",
      c.dapi.cells!=null&&targetStatus(view.id,"nk")==="done"?c.dapi.cells-c.nk.total:"",
      c.nk.review,c.tumor.review,c.nk.review+c.tumor.review,
      c.dapi.corrected,c.nk.corrected,c.tumor.corrected,
      targetStatus(view.id,"dapi"),targetStatus(view.id,"nk"),targetStatus(view.id,"tumor"),
      view.fileNames.dapi,view.fileNames.nk,view.fileNames.tumor,
      view.channel_mapping_source,view.pixel_size_um||state.project.pixel_size_um,
      viewIssueText(view)
    ];
  });
  const quote=value=>`"${String(value).replaceAll('"','""')}"`;
  return "\ufeff"+[headers,...rows].map(row=>row.map(quote).join(",")).join("\r\n");
}
function csvEncode(rows) {
  const quote=value=>`"${String(value??"").replaceAll('"','""')}"`;
  return "\ufeff"+rows.map(row=>row.map(quote).join(",")).join("\r\n");
}
function cellRawCsv(views=state.project.views) {
  const rows=[["实验组","视野","通道","对象编号","Cell-ID","对象类型","所含DAPI核数","DAPI核ID","DAPI核编号","分类","X_px","Y_px","完整轮廓面积_px2","面积_um2","信号面积_px2","圆度","实心度","阳性像素比例","局部背景","背景MAD","实际信号阈值","自动残差阈值","待复核","复核原因","本地学习评分","本地学习置信度","已人工确认","触及边缘","人工添加或修改","由人工核锚定","已删除"]];
  for(const view of views){
    for(const target of TARGETS){
      for(const item of targetResult(view.id,target)?.detections||[]){
        rows.push([
          view.group,view.name,targetLabel(target),item.id,item.cell_id||item.cell_instance_id||"",item.object_type|| (target==="dapi"?"nucleus":"legacy_detection"),
          detectionNucleusCount(item),(item.nucleus_ids||[]).join(";"),(item.nucleus_labels||[]).join(";"),item.classification,
          Number(item.x).toFixed(2),Number(item.y).toFixed(2),
          item.area_px??"",item.area_um2==null?"":Number(item.area_um2).toFixed(4),
          item.signal_area_px??item.signal_runs?.reduce((sum,_,index,runs)=>index%3===0?sum+runs[index+2]-runs[index+1]+1:sum,0)??"",
          item.circularity==null?"":Number(item.circularity).toFixed(4),
          item.solidity==null?"":Number(item.solidity).toFixed(4),
          item.positive_fraction==null?"":Number(item.positive_fraction).toFixed(4),
          item.signal_background==null?"":Number(item.signal_background).toFixed(4),
          item.signal_mad==null?"":Number(item.signal_mad).toFixed(4),
          item.signal_threshold_actual==null?"":Number(item.signal_threshold_actual).toFixed(4),
          item.auto_signal_threshold==null?"":Number(item.auto_signal_threshold).toFixed(4),
          Boolean(item.review_required),(item.review_reasons||[]).join(";"),
          item.learning_score==null?"":Number(item.learning_score).toFixed(4),item.confidence==null?"":Number(item.confidence).toFixed(4),
          Boolean(item.reviewed),Boolean(item.edge_touching),
          Boolean(item.manual),Boolean(item.anchor_manual),Boolean(item.deleted)
        ]);
      }
    }
  }
  return csvEncode(rows);
}
async function writeExportContents(sink,processedGroups) {
    const errors=[],processedViews=state.project.views.filter(view=>processedGroups.includes(view.group));
    await sink.write("全部文件夹汇总.csv",new Blob([csvText(processedViews)],{type:"text/csv;charset=utf-8"}));
    await sink.write(`${safeFileName(state.project.name)}_细胞计数结果.xlsx`,await cellCountWorkbookBlob(processedGroups));
    await sink.write("细胞逐对象原始数据.csv",new Blob([cellRawCsv(processedViews)],{type:"text/csv;charset=utf-8"}));
    await sink.write("项目.json",new Blob([JSON.stringify(serializableProject(),null,2)],{type:"application/json"}));
    if(typeof CellScopeLearning!=="undefined")await sink.write("本地纠正学习.json",new Blob([JSON.stringify(CellScopeLearning.exportData(),null,2)],{type:"application/json"}));
    const groupOutputs=new Map();
    for (const group of processedGroups) {
      const base=`按原目录排列/${safeRelativePath(group)}`,groupErrors=[];
      await sink.write(`${base}/计数结果.csv`,new Blob([csvText(groupViews(group))],{type:"text/csv;charset=utf-8"}));
      await sink.write(`${base}/细胞逐对象原始数据.csv`,new Blob([cellRawCsv(groupViews(group))],{type:"text/csv;charset=utf-8"}));
      groupOutputs.set(group,{base,errors:groupErrors});
    }
    const tasks=[];
    for (const view of processedViews) {
      for (const target of TARGETS) {
        if (targetStatus(view.id,target)==="done" && view.files[target]) tasks.push({view,target});
        else {
          const message=`${view.group} / ${view.name} / ${targetLabel(target)}：${targetResult(view.id,target)?.error||targetStatus(view.id,target)}`;
          errors.push(message);groupOutputs.get(view.group).errors.push(message);
        }
      }
    }
    const manifest=[["实验组","视野","通道","计数","文件","状态","错误"]];
    const started=performance.now();
    for (let index=0;index<tasks.length;index++) {
      if (state.cancelled) break;
      const {view,target}=tasks[index];
      const percent=Math.round(index/tasks.length*100);
      $("jobTitle").textContent=`正在导出标注图 ${index+1}/${tasks.length}`;
      $("jobPercent").textContent=`${percent}%`;$("jobProgress").style.width=`${percent}%`;
      $("jobCurrent").textContent=`${view.group} / ${view.name} · ${targetLabel(target)}`;
      try {
        const output=groupOutputs.get(view.group);
        const channelCode=String(view.channel_mapping?.[target]||target).replace(/^_/,"");
        const fileName=`${safeFileName(view.name)}__${safeFileName(targetLabel(target))}__${safeFileName(channelCode)}__标注.png`;
        await sink.write(`${output.base}/标注图/${fileName}`,await annotatedBlob(view,target));
        manifest.push([view.group,view.name,targetLabel(target),viewCounts(view.id)[target].total,`按原目录排列/${safeRelativePath(view.group)}/标注图/${fileName}`,"done",""]);
      } catch(error) {
        const message=`${view.group} / ${view.name} / ${targetLabel(target)}：${error.message}`;
        errors.push(message);groupOutputs.get(view.group).errors.push(message);
        manifest.push([view.group,view.name,targetLabel(target),"","","error",error.message]);
      }
      const elapsed=(performance.now()-started)/1000;
      const remaining=elapsed/(index+1)*(tasks.length-index-1);
      $("jobCurrent").textContent+=` · 剩余约 ${formatSeconds(remaining)}`;
    }
    const quote=value=>`"${String(value).replaceAll('"','""')}"`;
    const manifestText="\ufeff"+manifest.map(row=>row.map(quote).join(",")).join("\r\n");
    await sink.write("标注图清单.csv",new Blob([manifestText],{type:"text/csv;charset=utf-8"}));
    await sink.write("错误报告.txt",new Blob([errors.length?errors.join("\r\n"):"无错误"],{type:"text/plain;charset=utf-8"}));
    for (const output of groupOutputs.values()) {
      await sink.write(`${output.base}/错误报告.txt`,new Blob([output.errors.length?output.errors.join("\r\n"):"无错误"],{type:"text/plain;charset=utf-8"}));
    }
    await sink.finish();
}
function processedGroupNames() {
  return state.project.groups.filter(group=>groupViews(group).some(view=>TARGETS.some(target=>targetStatus(view.id,target)!=="pending")));
}
async function exportWorkbook() {
  if(!state.project||state.busy)return;
  const groups=processedGroupNames();
  if(!groups.length)return toast("还没有可导出的计数结果，请先运行至少一个通道",true);
  state.busy=true;
  try{
    downloadBlob(await cellCountWorkbookBlob(groups),`${safeFileName(state.project.name)}_细胞计数结果.xlsx`);
    toast("Excel 已下载：包含汇总、说明和每个已处理文件夹的工作表");
  }catch(error){toast(`Excel 导出失败：${error.message}`,true);}
  finally{state.busy=false;}
}
async function exportResults() {
  if (!state.project || state.busy) return;
  const processedGroups=processedGroupNames();
  if (!processedGroups.length) return toast("还没有处理完成的文件夹，请先运行至少一个通道",true);
  const rootName=`${safeFileName(state.project.name)}_cell-count-results`;
  let sink,fallbackReason="",directoryRootName="";
  if(window.showDirectoryPicker){
    try{
      const parent=await window.showDirectoryPicker({mode:"readwrite"});
      directoryRootName=`${rootName}_${exportRunStamp()}`;
      sink=await createDirectoryExportSink(parent,directoryRootName);
    }catch(error){
      if(error.name==="AbortError")return;
      fallbackReason=error.message||error.name;sink=createZipExportSink(rootName);
      console.warn("文件夹导出不可用，改用 ZIP",error);
    }
  }else{
    fallbackReason="当前浏览器不支持文件夹写入";sink=createZipExportSink(rootName);
  }
  state.busy=true;state.cancelled=false;
  $("jobPanel").classList.remove("hidden");
  $("cancelBtn").textContent="停止导出";
  try {
    if(fallbackReason)toast("当前环境不能直接写入文件夹，正在自动生成 ZIP；数据和标注图不会减少");
    try{
      await writeExportContents(sink,processedGroups);
    }catch(error){
      if(sink.kind!=="directory"||!isFileSystemAccessError(error))throw error;
      console.warn("文件夹写入过程中被拒绝，重新导出 ZIP",error);
      toast("文件夹写入被浏览器拒绝，正在重新生成完整 ZIP");
      state.cancelled=false;sink=createZipExportSink(rootName);
      await writeExportContents(sink,processedGroups);
    }
    toast(state.cancelled
      ? (sink.kind==="zip"?"导出已停止，已下载目前完成的 ZIP":"导出已停止；已完成文件保留在所选目录")
      : (sink.kind==="zip"?"已下载 ZIP：包含计数、原始数据和全部标注图":`已导出到独立结果文件夹：${directoryRootName}`));
  } catch(error) {
    toast(`导出失败：${error.message}`,true);
  } finally {
    state.busy=false;
    $("jobPanel").classList.add("hidden");
    $("cancelBtn").textContent="停止批处理";
  }
}
function exportAnnotated() {
  if (!$("imageCanvas").width) return;
  const canvas=document.createElement("canvas");canvas.width=$("imageCanvas").width;canvas.height=$("imageCanvas").height;
  const context=canvas.getContext("2d");context.drawImage($("imageCanvas"),0,0);context.drawImage($("overlayCanvas"),0,0);
  canvas.toBlob(blob=>downloadBlob(blob,`${viewById(state.currentViewId).name}-annotated.png`),"image/png");
}
async function importProject(file) {
  try {
    const project=JSON.parse(await file.text());
    if (!project.browserVersion) toast("这是本地 Python 版项目；将尝试导入兼容参数和结果");
    state.pendingProject=project;
    if (state.project) mergePendingProject();
    else toast("项目已读取，请重新选择对应的原始图片文件夹");
  } catch(error){toast(`项目文件无效：${error.message}`,true);}
}
function exportLearningProfile() {
  if(typeof CellScopeLearning==="undefined")return toast("本地学习模块未加载",true);
  const data=JSON.stringify(CellScopeLearning.exportData(),null,2);
  downloadBlob(new Blob([data],{type:"application/json"}),"CellScope_本地纠正学习.json");
  toast("学习配置已导出，可在另一台电脑导入继续使用");
}
async function importLearningProfile(file) {
  if(!file||typeof CellScopeLearning==="undefined")return;
  try{
    CellScopeLearning.importData(await file.text());updateLearningStatus();scheduleAutosave();
    toast("学习配置已导入并合并；之后的新分析会使用这些纠正样本");
  }catch(error){toast(`学习配置导入失败：${error.message}`,true);}
}
function applyViewportTransform() {
  $("imageStage").style.transform=`translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  $("zoomLabel").textContent=`${Math.round(state.zoom*100)}%`;
}
function setZoom(value, clientX=null, clientY=null) {
  const next=Math.max(.5,Math.min(8,value));
  if (next===state.zoom) return;
  const viewer=$("viewer"), rect=viewer.getBoundingClientRect();
  const anchorX=clientX ?? rect.left+rect.width/2;
  const anchorY=clientY ?? rect.top+rect.height/2;
  const localX=(anchorX-rect.left-state.fitLeft-state.panX)/state.zoom;
  const localY=(anchorY-rect.top-state.fitTop-state.panY)/state.zoom;
  state.panX=anchorX-rect.left-state.fitLeft-localX*next;
  state.panY=anchorY-rect.top-state.fitTop-localY*next;
  state.zoom=next;
  applyViewportTransform();
}
function centerStage() {
  const stage=$("imageStage"), viewer=$("viewer");
  state.panX=(viewer.clientWidth-stage.clientWidth*state.zoom)/2-state.fitLeft;
  state.panY=(viewer.clientHeight-stage.clientHeight*state.zoom)/2-state.fitTop;
  applyViewportTransform();
}
function fitCurrentStage() {
  if (!state.currentViewId) return;
  const view=viewById(state.currentViewId);
  const width=state.rawImage?.width || view?.width;
  const height=state.rawImage?.height || view?.height;
  if (width&&height) fitStage(width,height);
}
function setReviewMode(mode) {
  state.mode=mode;
  for (const name of ["select","add","delete","pan"]) $(`${name}ModeBtn`).classList.toggle("active",name===mode);
  const hints={
    select:"点击标记后可使用右侧删除按钮或键盘 Delete",
    add:`点击图片可添加并计入当前 ${targetLabel(state.target)}`,
    delete:"点击错误识别的轮廓或编号即可删除",
    pan:"按住左键拖动图片；滚轮可缩放",
  };
  $("selectionHint").textContent=hints[mode];
  updatePanCursor();
}
function updatePanCursor() {
  const ready=state.mode==="pan" || state.spacePressed;
  $("viewer").classList.toggle("pan-ready",ready && !state.panning);
  $("viewer").classList.toggle("is-panning",state.panning);
}
function shouldStartPan(event) {
  return event.button===1 || (event.button===0 && (state.mode==="pan" || state.spacePressed));
}
function startPan(event) {
  if (!shouldStartPan(event) || event.target.closest("button") || $("imageStage").style.display==="none") return;
  event.preventDefault();
  state.panning=true; state.panPointerId=event.pointerId;
  state.panStartX=event.clientX; state.panStartY=event.clientY;
  state.panOriginX=state.panX; state.panOriginY=state.panY;
  state.panMoved=false;
  $("viewer").setPointerCapture(event.pointerId);
  updatePanCursor();
}
function movePan(event) {
  if (!state.panning || event.pointerId!==state.panPointerId) return;
  const dx=event.clientX-state.panStartX, dy=event.clientY-state.panStartY;
  if (Math.hypot(dx,dy)>3) state.panMoved=true;
  state.panX=state.panOriginX+dx; state.panY=state.panOriginY+dy;
  applyViewportTransform();
}
function endPan(event) {
  if (!state.panning || event.pointerId!==state.panPointerId) return;
  state.panning=false; state.panPointerId=null;
  if ($("viewer").hasPointerCapture(event.pointerId)) $("viewer").releasePointerCapture(event.pointerId);
  updatePanCursor();
}
function isTypingTarget(target) {
  return ["INPUT","TEXTAREA","SELECT"].includes(target?.tagName) || target?.isContentEditable;
}
function formatSeconds(value){return value<60?`${Math.ceil(value)} 秒`:`${Math.ceil(value/60)} 分钟`;}
function refreshChannelLabels() {
  if (!state.project) return;
  const suffix = {dapi:"Dapi",nk:"Nk",tumor:"Tumor"};
  for (const target of TARGETS) {
    const label=targetLabel(target);
    const key=suffix[target];
    $(`viewerLabel${key}`).textContent=label;
    $(`legendLabel${key}`).textContent=label;
    $(`targetLabel${key}`).textContent=label;
    $(`resultHeader${key}`).textContent=label;
    $(`countLabel${key}`).textContent=target==="dapi"?`${label} 核数 / 推算细胞`:`${label} 总数`;
    $(`channelName${key}`).value=label;
  }
  $("resultHeaderDapi").textContent=`${targetLabel("dapi")} 核 / 细胞`;
  $("resultHeaderDapiMinusNk").textContent=`${targetLabel("dapi")}细胞-${targetLabel("nk")}`;
  $("targetParameterTitle").textContent=`${targetLabel(state.target)} 独立计数参数`;
  $("currentTargetName").textContent=targetLabel(state.target);
  if (state.currentGroup) $("profileGroup").textContent=`${state.currentGroup} · ${targetLabel(state.target)}`;
  $("calibrationWarning").textContent=`推荐顺序：选择 ${targetLabel("dapi")} → 随机预跑 → 保存阈值 → 批量；然后对 ${targetLabel("nk")}、${targetLabel("tumor")} 分别重复。三类参数互不覆盖。`;
  updateActionLabels();
  if (state.currentGroup) updateParameterVisibility();
  updateLearningStatus();
}
function saveChannelNames() {
  if (!state.project) return;
  const labels={
    dapi:$("channelNameDapi").value.trim(),
    nk:$("channelNameNk").value.trim(),
    tumor:$("channelNameTumor").value.trim(),
  };
  if (TARGETS.some(target=>!labels[target])) return toast("三条通道名称都不能为空",true);
  state.project.channel_labels=labels;
  refreshChannelLabels();
  renderResults();
  scheduleAutosave();
  toast("通道名称已保存，页面和导出表头已同步更新");
}
async function setTarget(target) {
  if (!TARGETS.includes(target) || !state.project) return;
  if (state.busy) return toast("请先等待当前类别分析完成，或点击停止批处理");
  state.target=target;
  $("controlPanel").scrollTo({top:0,behavior:"smooth"});
  state.channel=target;
  document.querySelectorAll("#targetPicker button").forEach(button=>button.classList.toggle("active",button.dataset.target===target));
  document.querySelectorAll("#channelTabs button").forEach(button=>button.classList.toggle("active",button.dataset.channel===target));
  const dot=$("targetDot");
  dot.className=`dot ${target==="tumor"?"red":target==="nk"?"green":"blue"}`;
  $("targetParameterTitle").textContent=`${targetLabel(target)} 独立计数参数`;
  $("currentTargetName").textContent=targetLabel(target);
  if (state.currentGroup) {
    $("profileGroup").textContent=`${state.currentGroup} · ${targetLabel(target)}`;
    populateParameters(state.project.parameters_by_group[state.currentGroup][target]);
  }
  updateLearningStatus();
  state.detections=state.currentViewId?targetResult(state.currentViewId,target)?.detections||[]:[];
  state.selectedId=null;
  updateCounts();
  renderInspectionView();
  if (state.currentViewId) await showImage();
}
async function randomSample() {
  if (!state.currentGroup) return;
  const candidates=groupViews(state.currentGroup).filter(view=>Boolean(view.files[state.target])&&(
    state.target==="dapi"||state.project.parameters_by_group[view.group][state.target].analysis_mode!=="nucleus_guided"||view.files.dapi
  ));
  if (!candidates.length) return toast("当前实验组没有可分析视野",true);
  const sample=candidates[Math.floor(Math.random()*candidates.length)];
  await selectView(sample.id);
  await analyzeScope("current");
}

function comparePrefix(side) { return side==="left" ? "compareLeft" : "compareRight"; }
function compareNode(side,name) { return $(`${comparePrefix(side)}${name}`); }
function compareOther(side) { return side==="left" ? "right" : "left"; }
function populateCompareSelectors() {
  const options=state.project.views.map(view=>
    `<option value="${escapeHtml(view.id)}">${escapeHtml(view.group)} / ${escapeHtml(view.name)}</option>`
  ).join("");
  for(const side of ["left","right"]){
    compareNode(side,"View").innerHTML=options;
    compareNode(side,"View").value=compareState[side].viewId||"";
    const channelSelect=compareNode(side,"Channel");
    channelSelect.querySelector('option[value="dapi"]').textContent=targetLabel("dapi");
    channelSelect.querySelector('option[value="nk"]').textContent=targetLabel("nk");
    channelSelect.querySelector('option[value="tumor"]').textContent=targetLabel("tumor");
    channelSelect.value=compareState[side].channel;
  }
}
function applyCompareTransform(side) {
  const pane=compareState[side];
  compareNode(side,"Stage").style.transform=`translate(${pane.panX}px,${pane.panY}px) scale(${pane.zoom})`;
  compareNode(side,"Zoom").textContent=`${Math.round(pane.zoom*100)}%`;
}
function fitCompareSide(side) {
  const pane=compareState[side],viewer=compareNode(side,"Viewer"),stage=compareNode(side,"Stage");
  if(!pane.raw||!viewer.clientWidth||!viewer.clientHeight)return;
  const ratio=pane.raw.width/pane.raw.height;
  let width=viewer.clientWidth,height=width/ratio;
  if(height>viewer.clientHeight){height=viewer.clientHeight;width=height*ratio;}
  stage.style.width=`${width}px`;stage.style.height=`${height}px`;
  pane.fitLeft=(viewer.clientWidth-width)/2;pane.fitTop=(viewer.clientHeight-height)/2;
  stage.style.left=`${pane.fitLeft}px`;stage.style.top=`${pane.fitTop}px`;
  pane.zoom=1;pane.panX=0;pane.panY=0;
  applyCompareTransform(side);
}
function syncCompareViewport(sourceSide) {
  if(!$("compareSync").checked)return;
  const source=compareState[sourceSide],targetSide=compareOther(sourceSide),target=compareState[targetSide];
  if(!source.raw||!target.raw)return;
  const sourceViewer=compareNode(sourceSide,"Viewer"),sourceStage=compareNode(sourceSide,"Stage");
  const targetViewer=compareNode(targetSide,"Viewer"),targetStage=compareNode(targetSide,"Stage");
  const normalizedX=(sourceViewer.clientWidth/2-source.fitLeft-source.panX)/(sourceStage.clientWidth*source.zoom);
  const normalizedY=(sourceViewer.clientHeight/2-source.fitTop-source.panY)/(sourceStage.clientHeight*source.zoom);
  target.zoom=source.zoom;
  target.panX=targetViewer.clientWidth/2-target.fitLeft-normalizedX*targetStage.clientWidth*target.zoom;
  target.panY=targetViewer.clientHeight/2-target.fitTop-normalizedY*targetStage.clientHeight*target.zoom;
  applyCompareTransform(targetSide);
}
function drawCompareDetections(canvas,detections,color,labelPrefix="") {
  if(!detections?.length)return;
  const active=detections.filter(item=>!item.deleted);
  const mask=buildDetectionMask(canvas.width,canvas.height,active);
  const context=canvas.getContext("2d");
  context.drawImage(outlineMask(mask,color,2),0,0);
  const review=active.filter(item=>item.review_required);
  if(review.length){
    const reviewMask=buildDetectionMask(canvas.width,canvas.height,review);
    context.drawImage(outlineMask(reviewMask,"#ffb84d",4),0,0);
    reviewMask.width=1;reviewMask.height=1;
  }
  if(!state.showLabels)return;
  active.forEach((item,index)=>{
    context.font=`700 ${Math.max(12,Math.min(22,(item.radius||12)*.75))}px system-ui`;
    context.textAlign="center";context.textBaseline="middle";context.lineWidth=3;
    context.strokeStyle="rgba(0,0,0,.88)";context.fillStyle="#fff";
    const label=detectionDisplayLabel(item,index+1,labelPrefix);
    context.strokeText(label,item.x,item.y);context.fillText(label,item.x,item.y);
  });
}
function updateCompareStats(side,view) {
  const counts=viewCounts(view.id);
  compareNode(side,"Stats").textContent=
    `${view.group} / ${view.name}　${targetLabel("dapi")}核 ${counts.dapi.total} / 细胞 ${counts.dapi.cells??"—"}　${targetLabel("nk")} ${counts.nk.total}　${targetLabel("tumor")} ${counts.tumor.total}　待复核 ${counts.nk.review+counts.tumor.review}`;
}
async function renderCompareSide(side,resetViewport=true) {
  const pane=compareState[side],view=viewById(pane.viewId);
  if(!view)return;
  const requestId=Symbol(side);pane.requestId=requestId;
  const file=view.files[pane.channel]||(pane.channel==="overlay"?view.files.dapi:null);
  if(!file){
    pane.raw=null;
    compareNode(side,"Stage").style.display="none";
    compareNode(side,"Empty").textContent=`当前视野缺少 ${targetLabel(pane.channel)} 通道`;
    compareNode(side,"Empty").classList.remove("hidden");
    compareNode(side,"Stats").textContent="";
    return;
  }
  compareNode(side,"Empty").textContent="正在读取本地图片…";
  compareNode(side,"Empty").classList.remove("hidden");
  try{
    const decoded=await decodeRgba(file);
    if(pane.requestId!==requestId)return;
    pane.raw=decoded;
    const image=compareNode(side,"Image"),overlay=compareNode(side,"Overlay");
    image.width=overlay.width=decoded.width;image.height=overlay.height=decoded.height;
    image.getContext("2d").putImageData(new ImageData(decoded.rgba,decoded.width,decoded.height),0,0);
    const overlayContext=overlay.getContext("2d");overlayContext.clearRect(0,0,overlay.width,overlay.height);
    if(TARGETS.includes(pane.channel)){
      drawCompareDetections(overlay,targetResult(view.id,pane.channel)?.detections||[],colors[pane.channel]);
    }else{
      drawCompareDetections(overlay,targetResult(view.id,"dapi")?.detections||[],colors.dapi,"D");
      drawCompareDetections(overlay,targetResult(view.id,"nk")?.detections||[],colors.nk,"N");
      drawCompareDetections(overlay,targetResult(view.id,"tumor")?.detections||[],colors.tumor,"T");
    }
    compareNode(side,"Stage").style.display="block";
    compareNode(side,"Empty").classList.add("hidden");
    updateCompareStats(side,view);
    if(resetViewport)fitCompareSide(side);else applyCompareTransform(side);
  }catch(error){
    if(pane.requestId!==requestId)return;
    pane.raw=null;
    compareNode(side,"Stage").style.display="none";
    compareNode(side,"Stats").textContent="";
    compareNode(side,"Empty").textContent=`读取失败：${error.message}`;
    compareNode(side,"Empty").classList.remove("hidden");
  }
}
async function openCompare() {
  if(!state.project||!state.currentViewId)return;
  const current=viewById(state.currentViewId),sameGroup=groupViews(current.group);
  const index=sameGroup.findIndex(view=>view.id===current.id);
  compareState.left.viewId=current.id;
  compareState.right.viewId=(sameGroup[index+1]||sameGroup[index-1]||current).id;
  compareState.left.channel=state.channel;
  compareState.right.channel=compareState.left.channel;
  compareState.open=true;populateCompareSelectors();
  $("compareDialog").classList.remove("hidden");
  await Promise.all([renderCompareSide("left"),renderCompareSide("right")]);
}
function closeCompare() {
  compareState.open=false;$("compareDialog").classList.add("hidden");
}
function compareZoom(side,next,clientX,clientY) {
  const pane=compareState[side],viewer=compareNode(side,"Viewer"),rect=viewer.getBoundingClientRect();
  const zoom=Math.max(.5,Math.min(8,next));
  const anchorX=(clientX??rect.left+rect.width/2)-rect.left;
  const anchorY=(clientY??rect.top+rect.height/2)-rect.top;
  const localX=(anchorX-pane.fitLeft-pane.panX)/pane.zoom;
  const localY=(anchorY-pane.fitTop-pane.panY)/pane.zoom;
  pane.panX=anchorX-pane.fitLeft-localX*zoom;
  pane.panY=anchorY-pane.fitTop-localY*zoom;
  pane.zoom=zoom;applyCompareTransform(side);syncCompareViewport(side);
}
function startComparePan(side,event) {
  if(event.button!==0||!compareState[side].raw)return;
  const pane=compareState[side];pane.dragging=true;pane.pointerId=event.pointerId;
  pane.startX=event.clientX;pane.startY=event.clientY;pane.originX=pane.panX;pane.originY=pane.panY;
  compareNode(side,"Viewer").setPointerCapture(event.pointerId);
  compareNode(side,"Viewer").classList.add("dragging");event.preventDefault();
}
function moveComparePan(side,event) {
  const pane=compareState[side];if(!pane.dragging||pane.pointerId!==event.pointerId)return;
  pane.panX=pane.originX+event.clientX-pane.startX;pane.panY=pane.originY+event.clientY-pane.startY;
  applyCompareTransform(side);syncCompareViewport(side);
}
function endComparePan(side,event) {
  const pane=compareState[side];if(!pane.dragging||pane.pointerId!==event.pointerId)return;
  pane.dragging=false;pane.pointerId=null;compareNode(side,"Viewer").classList.remove("dragging");
}

[$("folderInput"),$("welcomeFolderInput")].forEach(input=>input.onchange=event=>scanFolder(event.target.files).catch(error=>{console.error(error);toast(error.message,true);}));
$("projectInput").onchange=event=>event.target.files[0]&&importProject(event.target.files[0]);
$("mappingToggleBtn").onclick=()=>$("mappingPanel").classList.toggle("hidden");
$("selectAllGroupsBtn").onclick=()=>{state.selectedGroups=new Set(state.project.groups);renderGroups();scheduleAutosave();};
$("clearGroupsBtn").onclick=()=>{state.selectedGroups.clear();renderGroups();scheduleAutosave();};
$("saveChannelNamesBtn").onclick=saveChannelNames;
$("saveProfileBtn").onclick=()=>saveParameters(false);$("applyAllBtn").onclick=()=>saveParameters(true);
$("randomSampleBtn").onclick=randomSample;
$("targetPicker").querySelectorAll("button").forEach(button=>button.onclick=()=>setTarget(button.dataset.target));
$("analyzeCurrentBtn").onclick=()=>analyzeScope("current");$("analyzeGroupBtn").onclick=()=>analyzeScope("group");
$("analyzeAllBtn").onclick=()=>analyzeScope("all");$("resumeBtn").onclick=()=>analyzeScope("pending");
$("cancelBtn").onclick=()=>{
  state.cancelled=true;
  if(state.cancelReject) state.cancelReject();
  state.cancelReject=null;
  if(state.worker) state.worker.terminate();
  state.worker=null;
};
$("exportBtn").onclick=exportResults;$("excelBtn").onclick=exportWorkbook;$("annotatedBtn").onclick=exportAnnotated;
$("exportLearningBtn").onclick=exportLearningProfile;
$("importLearningInput").onchange=async event=>{await importLearningProfile(event.target.files?.[0]);event.target.value="";};
$("overlayCanvas").onclick=handleCanvasClick;
$("selectModeBtn").onclick=()=>setReviewMode("select");
$("addModeBtn").onclick=()=>setReviewMode("add");
$("deleteModeBtn").onclick=()=>setReviewMode("delete");
$("panModeBtn").onclick=()=>setReviewMode("pan");
$("deleteDetectionBtn").onclick=deleteSelected;
$("confirmDetectionBtn").onclick=confirmSelectedDetection;
$("nextReviewBtn").onclick=nextReviewRequired;
document.querySelectorAll("#channelTabs button").forEach(button=>button.onclick=async()=>{
  if (TARGETS.includes(button.dataset.channel)) {
    await setTarget(button.dataset.channel);
    return;
  }
  document.querySelectorAll("#channelTabs button").forEach(item=>item.classList.remove("active"));button.classList.add("active");
  state.channel=button.dataset.channel;showImage();
});
document.querySelectorAll("#inspectionTabs button").forEach(button=>button.onclick=()=>{
  if(button.dataset.inspection==="binary"&&state.detections.some(item=>!item.manual&&!detectionRuns(item).length)){
    return toast("这个结果没有保存真实掩膜，请重新预跑当前类别后查看二值核对图",true);
  }
  state.inspectionMode=button.dataset.inspection;
  document.querySelectorAll("#inspectionTabs button").forEach(item=>item.classList.toggle("active",item===button));
  renderInspectionView();
});
$("labelsToggle").onclick=()=>{
  state.showLabels=!state.showLabels;
  $("labelsToggle").classList.toggle("active",state.showLabels);
  $("labelsToggle").textContent=state.showLabels?"显示编号":"隐藏编号";
  renderInspectionView();
};
document.querySelectorAll(".legend button[data-class]").forEach(button=>button.onclick=()=>{
  button.classList.toggle("active");button.classList.contains("active")?state.visibleClasses.add(button.dataset.class):state.visibleClasses.delete(button.dataset.class);renderInspectionView();
});
$("zoomInBtn").onclick=()=>setZoom(state.zoom+.25);
$("zoomOutBtn").onclick=()=>setZoom(state.zoom-.25);
$("fitBtn").onclick=fitCurrentStage;
$("centerBtn").onclick=centerStage;
$("previousViewBtn").onclick=()=>navigateCurrentGroup(-1);
$("nextViewBtn").onclick=()=>navigateCurrentGroup(1);
$("undoBtn").onclick=undoCorrection;
$("redoBtn").onclick=redoCorrection;
$("compareBtn").onclick=openCompare;
$("compareCloseBtn").onclick=closeCompare;
$("compareFitBtn").onclick=()=>{fitCompareSide("left");fitCompareSide("right");};
$("compareSync").onchange=event=>event.target.checked&&syncCompareViewport("left");
$("compareSwapBtn").onclick=async()=>{
  const leftView=compareState.left.viewId,leftChannel=compareState.left.channel;
  compareState.left.viewId=compareState.right.viewId;compareState.left.channel=compareState.right.channel;
  compareState.right.viewId=leftView;compareState.right.channel=leftChannel;
  populateCompareSelectors();
  await Promise.all([renderCompareSide("left"),renderCompareSide("right")]);
};
for(const side of ["left","right"]){
  compareNode(side,"View").onchange=event=>{compareState[side].viewId=event.target.value;renderCompareSide(side);};
  compareNode(side,"Channel").onchange=event=>{compareState[side].channel=event.target.value;renderCompareSide(side,false);};
  const viewer=compareNode(side,"Viewer");
  viewer.addEventListener("wheel",event=>{event.preventDefault();compareZoom(side,compareState[side].zoom+(event.deltaY<0?.15:-.15),event.clientX,event.clientY);},{passive:false});
  viewer.addEventListener("pointerdown",event=>startComparePan(side,event));
  viewer.addEventListener("pointermove",event=>moveComparePan(side,event));
  viewer.addEventListener("pointerup",event=>endComparePan(side,event));
  viewer.addEventListener("pointercancel",event=>endComparePan(side,event));
  viewer.ondblclick=()=>fitCompareSide(side);
}
$("minArea").addEventListener("input",updateAreaNote);
$("analysisMode").addEventListener("change",updateParameterVisibility);
$("viewer").addEventListener("wheel",event=>{event.preventDefault();setZoom(state.zoom+(event.deltaY<0?.15:-.15),event.clientX,event.clientY);},{passive:false});
$("viewer").addEventListener("pointerdown",startPan);
$("viewer").addEventListener("pointermove",movePan);
$("viewer").addEventListener("pointerup",endPan);
$("viewer").addEventListener("pointercancel",endPan);
$("viewer").addEventListener("auxclick",event=>{if(event.button===1)event.preventDefault();});
window.addEventListener("keydown",event=>{
  if(event.key==="Escape"&&compareState.open){closeCompare();return;}
  if(!compareState.open&&!isTypingTarget(event.target)&&!event.ctrlKey&&!event.metaKey&&!event.altKey
    &&(event.key==="ArrowLeft"||event.key==="ArrowRight")){
    event.preventDefault();
    navigateCurrentGroup(event.key==="ArrowLeft"?-1:1);
    return;
  }
  if((event.ctrlKey||event.metaKey)&&!isTypingTarget(event.target)&&event.key.toLowerCase()==="z"){
    event.preventDefault();event.shiftKey?redoCorrection():undoCorrection();return;
  }
  if((event.ctrlKey||event.metaKey)&&!isTypingTarget(event.target)&&event.key.toLowerCase()==="y"){
    event.preventDefault();redoCorrection();return;
  }
  if((event.key==="Delete" || event.key==="Backspace") && !isTypingTarget(event.target) && state.selectedId){
    event.preventDefault(); deleteSelected(); return;
  }
  if(event.code!=="Space" || isTypingTarget(event.target)) return;
  event.preventDefault(); state.spacePressed=true; updatePanCursor();
});
window.addEventListener("keyup",event=>{
  if(event.code!=="Space") return;
  state.spacePressed=false; updatePanCursor();
});
window.addEventListener("blur",()=>{state.spacePressed=false;updatePanCursor();});
window.addEventListener("resize",()=>{
  if(state.currentViewId&&viewById(state.currentViewId).width)fitStage(viewById(state.currentViewId).width,viewById(state.currentViewId).height);
  if(compareState.open){fitCompareSide("left");fitCompareSide("right");}
});
