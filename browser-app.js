/* global UTIF */
const DEFAULTS = {
  threshold_mode: "manual", threshold_low: 15, threshold_high: 255,
  gaussian_sigma: 1, opening_radius: 1, watershed_min_distance: 12,
  min_area_px: 400, max_area_px: 20000, min_circularity: 0.03,
  max_circularity: 1,
};
const TARGETS = ["dapi", "nk", "tumor"];
const DEFAULT_CHANNEL_LABELS = {dapi:"DAPI", nk:"NK", tumor:"肿瘤"};
const state = {
  project: null, currentViewId: null, currentGroup: null, channel: "overlay", target: "dapi",
  detections: [], selectedId: null, mode: "select", zoom: 1, worker: null,
  cancelled: false, cancelReject: null, pendingProject: null, busy: false,
  inspectionMode: "original", showLabels: true, rawImage: null,
  visibleClasses: new Set(["dapi", "tumor", "nk"]),
};
const $ = id => document.getElementById(id);
const colors = {dapi:"#4d7cff", tumor:"#ff4a5b", nk:"#41e090"};
const supported = new Set([".tif", ".tiff", ".png", ".jpg", ".jpeg"]);
function targetLabel(target) {
  return state.project?.channel_labels?.[target] || DEFAULT_CHANNEL_LABELS[target];
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
  let pixelSizeUm = 0.218;
  const propertyFile = files.find(file => /_properties\.xml$/i.test(file.name));
  if (propertyFile) {
    const match = (await propertyFile.text()).match(/Voxel="([\d.]+)"/);
    if (match) pixelSizeUm = Number(match[1]);
  }
  const views = [];
  for (const {file, relative} of map.values()) {
    if (!supported.has(extension(file.name))) continue;
    const fileStem = stem(file.name);
    if (!fileStem.toLowerCase().endsWith(suffixes.dapi.toLowerCase())) continue;
    const base = fileStem.slice(0, -suffixes.dapi.length);
    const slash = relative.lastIndexOf("/");
    const directory = slash >= 0 ? relative.slice(0, slash) : "";
    const group = directory || root;
    const ext = extension(file.name);
    const key = name => `${directory ? directory + "/" : ""}${name}${ext}`.toLowerCase();
    const findAny = name => map.get(key(name)) || [...map.values()].find(item => {
      const itemSlash = item.relative.lastIndexOf("/");
      const itemDir = itemSlash >= 0 ? item.relative.slice(0, itemSlash) : "";
      return itemDir.toLowerCase() === directory.toLowerCase() && stem(item.file.name).toLowerCase() === name.toLowerCase() && supported.has(extension(item.file.name));
    });
    const nk = findAny(base + suffixes.nk), tumor = findAny(base + suffixes.tumor), overlay = findAny(base);
    const errors = [];
    if (!nk) errors.push(`缺少绿色 ${targetLabel("nk")} 通道`);
    if (!tumor) errors.push(`缺少红色 ${targetLabel("tumor")} 通道`);
    views.push({
      id: `${group}/${base}`, group, name: base,
      files: {dapi:file, nk:nk?.file || null, tumor:tumor?.file || null, overlay:overlay?.file || file},
      fileNames: {dapi:file.name, nk:nk?.file.name || "", tumor:tumor?.file.name || "", overlay:overlay?.file.name || file.name},
      width:0, height:0, status:errors.length ? "error" : "pending", error:errors.join("；"),
    });
  }
  if (!views.length) return toast(`没有找到以 ${suffixes.dapi} 结尾的 ${targetLabel("dapi")} 图片`, true);
  views.sort((a,b) => a.id.localeCompare(b.id, "zh-CN", {numeric:true}));
  const groups = [...new Set(views.map(view => view.group))];
  state.project = {
    version:1, browserVersion:true, name:root, pixel_size_um:pixelSizeUm, suffixes,
    channel_labels:{...DEFAULT_CHANNEL_LABELS},
    groups, views,
    parameters_by_group:Object.fromEntries(groups.map(group => [
      group,
      Object.fromEntries(TARGETS.map(target => [target, {...DEFAULTS}]))
    ])),
    results:{}, created_at:new Date().toISOString(),
  };
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
  for (const group of state.project.groups) {
    const savedGroup = saved.parameters_by_group?.[group];
    if (!savedGroup) continue;
    if (savedGroup.dapi || savedGroup.nk || savedGroup.tumor) {
      for (const target of TARGETS) {
        if (savedGroup[target]) state.project.parameters_by_group[group][target] = {...DEFAULTS, ...savedGroup[target]};
      }
    } else {
      for (const target of TARGETS) state.project.parameters_by_group[group][target] = {...DEFAULTS, ...savedGroup};
    }
  }
  for (const view of state.project.views) {
    if (saved.results?.[view.id]) {
    const savedResult = saved.results[view.id];
    if (savedResult.dapi || savedResult.nk || savedResult.tumor) {
        state.project.results[view.id] = {};
        for (const target of TARGETS) {
          if (!savedResult[target]) continue;
          state.project.results[view.id][target] = {
            ...savedResult[target],
            detections:(savedResult[target].detections||[]).map(inflateDetection)
          };
        }
      }
      view.status = overallStatus(view);
    }
  }
  state.pendingProject = null;
  toast("已恢复项目参数和计数结果");
}

function openWorkspace() {
  $("appShell").classList.remove("empty");
  $("welcome").classList.add("hidden");
  ["sidebar","workspace","controlPanel"].forEach(id => $(id).classList.remove("hidden"));
  $("projectName").textContent = state.project.name;
  $("projectMeta").textContent = `${state.project.groups.length} 个实验组 · ${state.project.views.length} 个视野`;
  $("pixelSizeBadge").textContent = `${state.project.pixel_size_um} µm/px`;
  refreshChannelLabels(); renderGroups(); renderResults();
  const first = state.project.views.find(view => !view.error) || state.project.views[0];
  if (first) selectView(first.id);
  toast(`已在浏览器中识别 ${state.project.views.length} 个视野`);
}
function groupViews(group) { return state.project.views.filter(view => view.group === group); }
function viewById(id) { return state.project.views.find(view => view.id === id); }
function targetResult(viewId, target=state.target) { return state.project.results[viewId]?.[target]; }
function targetStatus(viewId, target) { return targetResult(viewId,target)?.status || "pending"; }
function overallStatus(view) {
  if (view.error) return "error";
  const statuses = TARGETS.map(target => targetStatus(view.id,target));
  if (statuses.includes("running")) return "running";
  if (statuses.every(status => status === "done")) return "done";
  if (statuses.some(status => status === "done")) return "partial";
  if (statuses.every(status => status === "error")) return "error";
  return "pending";
}

function renderGroups() {
  $("groupList").innerHTML = "";
  state.project.groups.forEach(group => {
    const wrapper = document.createElement("div");
    wrapper.className = "group";
    const views = groupViews(group);
    wrapper.innerHTML = `<button class="group-header"><strong>${escapeHtml(group)}</strong><small>${views.length}</small></button><div class="view-list"></div>`;
    const list = wrapper.querySelector(".view-list");
    views.forEach(view => {
      view.status = overallStatus(view);
      const button = document.createElement("button");
      button.className = `view-item${view.id === state.currentViewId ? " active" : ""}`;
      button.innerHTML = `<span class="status-dot ${view.status}"></span><span>${escapeHtml(view.name)}</span>`;
      button.onclick = () => selectView(view.id);
      list.appendChild(button);
    });
    wrapper.querySelector(".group-header").onclick = () => list.classList.toggle("hidden");
    $("groupList").appendChild(wrapper);
  });
}

async function selectView(id) {
  state.currentViewId = id; state.selectedId = null;
  const view = viewById(id);
  state.currentGroup = view.group;
  $("currentGroupLabel").textContent = view.group;
  $("currentViewLabel").textContent = view.name;
  $("profileGroup").textContent = `${view.group} · ${targetLabel(state.target)}`;
  populateParameters(state.project.parameters_by_group[view.group][state.target]);
  state.detections = targetResult(id)?.detections || [];
  updateCounts();
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
  const file = view?.files[state.channel] || view?.files.dapi;
  if (!file) return;
  $("decodeBusy").classList.remove("hidden");
  try {
    const decoded = await decodeRgba(file);
    if (state.currentViewId !== view.id) return;
    view.width = decoded.width; view.height = decoded.height;
    const imageCanvas = $("imageCanvas"), overlay = $("overlayCanvas");
    imageCanvas.width = overlay.width = decoded.width;
    imageCanvas.height = overlay.height = decoded.height;
    state.rawImage = decoded;
    fitStage(decoded.width, decoded.height);
    $("imageStage").style.display = "block";
    $("viewerEmpty").classList.add("hidden");
    renderInspectionView();
  } catch (error) { toast(error.message, true); }
  finally { $("decodeBusy").classList.add("hidden"); }
}

function fitStage(width, height) {
  const viewer = $("viewer"), ratio = width / height;
  let displayWidth = viewer.clientWidth, displayHeight = displayWidth / ratio;
  if (displayHeight > viewer.clientHeight) { displayHeight = viewer.clientHeight; displayWidth = displayHeight * ratio; }
  const stage = $("imageStage");
  stage.style.width = `${displayWidth}px`; stage.style.height = `${displayHeight}px`;
  stage.style.left = `${(viewer.clientWidth - displayWidth)/2}px`;
  stage.style.top = `${(viewer.clientHeight - displayHeight)/2}px`;
  setZoom(1);
}

function buildAcceptedMask() {
  const source = $("overlayCanvas");
  const mask = document.createElement("canvas");
  mask.width = source.width; mask.height = source.height;
  const context = mask.getContext("2d");
  context.fillStyle = "#fff";
  for (const item of state.detections) {
    if (item.deleted || !state.visibleClasses.has(item.classification)) continue;
    if (item.runs?.length) {
      for (let i=0; i<item.runs.length; i+=3) {
        const y=item.runs[i], start=item.runs[i+1], end=item.runs[i+2];
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
    context.strokeText(String(activeIndex),item.x,item.y);
    context.fillText(String(activeIndex),item.x,item.y);
  }
}

const fieldMap = {
  thresholdMode:"threshold_mode", thresholdLow:"threshold_low", thresholdHigh:"threshold_high",
  minArea:"min_area_px", maxArea:"max_area_px", minCircularity:"min_circularity",
  maxCircularity:"max_circularity", gaussianSigma:"gaussian_sigma",
  watershedDistance:"watershed_min_distance",
};
function populateParameters(params) {
  Object.entries(fieldMap).forEach(([id,key]) => $(id).value = params[key]);
  updateAreaNote();
}
function collectParameters() {
  const params = {...state.project.parameters_by_group[state.currentGroup][state.target]};
  Object.entries(fieldMap).forEach(([id,key]) => params[key] = id === "thresholdMode" ? $(id).value : Number($(id).value));
  return params;
}
function saveParameters(all=false) {
  if (!state.currentGroup) return;
  const params = collectParameters();
  if (params.threshold_low > params.threshold_high) return toast("阈值下限不能大于上限", true);
  state.project.parameters_by_group[state.currentGroup][state.target] = params;
  if (all) state.project.groups.forEach(group => state.project.parameters_by_group[group][state.target] = {...params});
  toast(all ? `${targetLabel(state.target)} 参数已应用到全部实验组` : `已保存“${state.currentGroup}”的 ${targetLabel(state.target)} 参数`);
}
function updateAreaNote() {
  if (!state.project) return;
  const area = Number($("minArea").value||0);
  $("areaConversion").textContent = `${area} px² ≈ ${(area*state.project.pixel_size_um**2).toFixed(1)} µm²`;
}

function createWorker() {
  if (state.worker) state.worker.terminate();
  state.worker = new Worker("browser-worker.js");
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
      worker.postMessage({
        type:"analyze", params, target, targetLabel:targetLabel(target),
        pixelSizeUm:state.project.pixel_size_um,
        channelBuffer, channelExtension:extension(view.files[target].name),
      },[channelBuffer]);
    } catch (error) {
      state.cancelReject = null;
      reject(error);
    }
  });
}

async function analyzeScope(scope) {
  if (!state.project) return;
  if (state.busy) return toast("已有批处理正在运行，请先等待完成或停止");
  saveParameters(false);
  const target = state.target;
  let views = scope === "current" ? [viewById(state.currentViewId)] :
    scope === "group" ? groupViews(state.currentGroup) :
    scope === "pending" ? state.project.views.filter(view => targetStatus(view.id,target) !== "done") : state.project.views;
  views = views.filter(view => !view.error);
  if (!views.length) return toast("没有未完成且可分析的视野");
  if (views.some(view => countTargetDetections(targetResult(view.id,target)?.detections||[]).corrected > 0) &&
      !confirm(`所选范围包含 ${targetLabel(target)} 人工修正，重新分析会清除这些修正。是否继续？`)) return;
  state.cancelled = false;
  state.busy = true;
  $("jobPanel").classList.remove("hidden");
  const started = performance.now();
  for (let index=0; index<views.length; index++) {
    if (state.cancelled) break;
    const view = views[index];
    if (!state.project.results[view.id]) state.project.results[view.id] = {};
    const previous = state.project.results[view.id][target];
    state.project.results[view.id][target] = {...(previous||{}),status:"running",error:""};
    view.status = overallStatus(view); view.error = ""; renderGroups(); renderResults();
    const percent = Math.round(index/views.length*100);
    $("jobPercent").textContent = `${percent}%`; $("jobProgress").style.width = `${percent}%`;
    $("jobTitle").textContent = `正在分析 ${index+1}/${views.length}`;
    try {
      const result = await analyzeOne(view,state.project.parameters_by_group[view.group][target],target);
      if (state.cancelled) break;
      view.width=result.width; view.height=result.height; view.status="done";
      state.project.results[view.id][target] = {
        status:"done",error:"",detections:result.detections,
        parameter_group:view.group,parameters:{...state.project.parameters_by_group[view.group][target]}
      };
    } catch (error) {
      if (state.cancelled) {
        state.project.results[view.id][target] = previous || {status:"pending",error:"",detections:[]};
        view.status = overallStatus(view);
        break;
      }
      view.status="error"; view.error=error.message;
      state.project.results[view.id][target] = {status:"error",error:error.message,detections:[]};
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
  toast(state.cancelled ? `${targetLabel(target)} 批处理已停止，已完成结果仍保留` : `${targetLabel(target)} 分析完成`);
}

function countTargetDetections(detections=[]) {
  const active=detections.filter(item=>!item.deleted);
  return {total:active.length,corrected:detections.filter(item=>item.manual||item.deleted).length};
}
function viewCounts(viewId) {
  return Object.fromEntries(TARGETS.map(target=>[
    target,
    countTargetDetections(targetResult(viewId,target)?.detections||[])
  ]));
}
function updateCounts() {
  const counts=state.currentViewId?viewCounts(state.currentViewId):{};
  $("countDapi").textContent=targetStatus(state.currentViewId,"dapi")==="done"?counts.dapi.total:"—";
  $("countTumor").textContent=targetStatus(state.currentViewId,"tumor")==="done"?counts.tumor.total:"—";
  $("countNk").textContent=targetStatus(state.currentViewId,"nk")==="done"?counts.nk.total:"—";
  $("currentTargetName").textContent=targetLabel(state.target);
}
function renderResults() {
  if (!state.project) return;
  const short={pending:"—",running:"…",done:"✓",error:"!"};
  $("resultsBody").innerHTML=state.project.views.map(view=>{
    const c=viewCounts(view.id);
    const corrected=c.dapi.corrected+c.nk.corrected+c.tumor.corrected;
    const status=TARGETS.map(target=>`${targetLabel(target)} ${short[targetStatus(view.id,target)]}`).join(" · ");
    return `<tr><td>${escapeHtml(view.group)} / ${escapeHtml(view.name)}</td><td>${targetStatus(view.id,"dapi")==="done"?c.dapi.total:"—"}</td><td>${targetStatus(view.id,"nk")==="done"?c.nk.total:"—"}</td><td>${targetStatus(view.id,"tumor")==="done"?c.tumor.total:"—"}</td><td>${corrected}</td><td class="status-${overallStatus(view)}" title="${escapeHtml(view.error||"")}">${escapeHtml(status)}</td></tr>`;
  }).join("");
}

function canvasPoint(event) {
  const canvas=$("overlayCanvas"),rect=canvas.getBoundingClientRect();
  return {x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height};
}
function handleCanvasClick(event) {
  if (!targetResult(state.currentViewId)?.detections) return toast(`请先预跑当前视野的 ${targetLabel(state.target)}`);
  const point=canvasPoint(event);
  if (state.mode==="add") {
    state.detections.push({id:`manual-${Date.now()}`,x:point.x,y:point.y,area_px:452.39,area_um2:452.39*state.project.pixel_size_um**2,radius:12,circularity:1,classification:state.target,manual:true,deleted:false});
    syncCorrections(); return;
  }
  let best=null,distance=Infinity;
  state.detections.forEach(item=>{
    if(item.deleted)return;
    const d=Math.hypot(item.x-point.x,item.y-point.y);
    if(d<Math.max(20,item.radius*1.5)&&d<distance){best=item;distance=d;}
  });
  state.selectedId=best?.id||null;
  $("selectionHint").textContent=best?`已选择 ${best.id}`:"未选中标记";
  drawOverlay();
}
function syncCorrections() {
  state.project.results[state.currentViewId][state.target].detections=state.detections;
  state.selectedId=null; updateCounts(); renderInspectionView(); renderResults();
}
function reclassify(classification) {
  const item=state.detections.find(d=>d.id===state.selectedId); if(!item)return;
  item.classification=state.target;item.manual=true;syncCorrections();
}
function deleteSelected() {
  const item=state.detections.find(d=>d.id===state.selectedId);if(!item)return;
  item.deleted=true;item.manual=true;syncCorrections();
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
    version:1,browserVersion:true,name:state.project.name,pixel_size_um:state.project.pixel_size_um,
    suffixes:state.project.suffixes,channel_labels:state.project.channel_labels,
    groups:state.project.groups,parameters_by_group:state.project.parameters_by_group,
    views:state.project.views.map(({id,group,name,width,height,status,error,fileNames})=>({id,group,name,width,height,status,error,fileNames})),
    results:serializedResults,updated_at:new Date().toISOString(),
  };
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
  delete output.runs;
  return output;
}
function inflateDetection(detection) {
  const output={...detection};
  if (!output.runs?.length&&output.mask_rle) output.runs=decodeRuns(output.mask_rle);
  delete output.mask_rle;
  return output;
}
function downloadBlob(blob,name) {
  const url=URL.createObjectURL(blob),link=document.createElement("a");
  link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function csvText() {
  const headers=[
    "实验组","视野",
    ...TARGETS.map(target=>`${targetLabel(target)}总数`),
    ...TARGETS.map(target=>`${targetLabel(target)}修正数`),
    ...TARGETS.map(target=>`${targetLabel(target)}状态`),
    "错误"
  ];
  const rows=state.project.views.map(view=>{
    const c=viewCounts(view.id);
    return [
      view.group,view.name,
      targetStatus(view.id,"dapi")==="done"?c.dapi.total:"",
      targetStatus(view.id,"nk")==="done"?c.nk.total:"",
      targetStatus(view.id,"tumor")==="done"?c.tumor.total:"",
      c.dapi.corrected,c.nk.corrected,c.tumor.corrected,
      targetStatus(view.id,"dapi"),targetStatus(view.id,"nk"),targetStatus(view.id,"tumor"),
      view.error||""
    ];
  });
  const quote=value=>`"${String(value).replaceAll('"','""')}"`;
  return "\ufeff"+[headers,...rows].map(row=>row.map(quote).join(",")).join("\r\n");
}
function exportResults() {
  downloadBlob(new Blob([csvText()],{type:"text/csv;charset=utf-8"}),`${state.project.name}-cell-count-results.csv`);
  setTimeout(()=>downloadBlob(new Blob([JSON.stringify(serializableProject(),null,2)],{type:"application/json"}),`${state.project.name}-cell-count-project.json`),250);
  toast("已导出 CSV 和项目 JSON");
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
function setZoom(value){state.zoom=Math.max(.5,Math.min(4,value));$("imageStage").style.transform=`scale(${state.zoom})`;$("zoomLabel").textContent=`${Math.round(state.zoom*100)}%`;}
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
    $(`countLabel${key}`).textContent=`${label} 总数`;
    $(`channelName${key}`).value=label;
  }
  $("targetParameterTitle").textContent=`${targetLabel(state.target)} 独立计数参数`;
  $("currentTargetName").textContent=targetLabel(state.target);
  if (state.currentGroup) $("profileGroup").textContent=`${state.currentGroup} · ${targetLabel(state.target)}`;
  $("calibrationWarning").textContent=`推荐顺序：选择 ${targetLabel("dapi")} → 随机预跑 → 保存阈值 → 批量；然后对 ${targetLabel("nk")}、${targetLabel("tumor")} 分别重复。三类参数互不覆盖。`;
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
  toast("通道名称已保存，页面和导出表头已同步更新");
}
async function setTarget(target) {
  if (!TARGETS.includes(target) || !state.project) return;
  if (state.busy) return toast("请先等待当前类别分析完成，或点击停止批处理");
  state.target=target;
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
  state.detections=state.currentViewId?targetResult(state.currentViewId,target)?.detections||[]:[];
  state.selectedId=null;
  updateCounts();
  renderInspectionView();
  if (state.currentViewId) await showImage();
}
async function randomSample() {
  if (!state.currentGroup) return;
  const candidates=groupViews(state.currentGroup).filter(view=>!view.error);
  if (!candidates.length) return toast("当前实验组没有可分析视野",true);
  const sample=candidates[Math.floor(Math.random()*candidates.length)];
  await selectView(sample.id);
  await analyzeScope("current");
}

[$("folderInput"),$("welcomeFolderInput")].forEach(input=>input.onchange=event=>scanFolder(event.target.files).catch(error=>{console.error(error);toast(error.message,true);}));
$("projectInput").onchange=event=>event.target.files[0]&&importProject(event.target.files[0]);
$("mappingToggleBtn").onclick=()=>$("mappingPanel").classList.toggle("hidden");
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
$("exportBtn").onclick=exportResults;$("annotatedBtn").onclick=exportAnnotated;
$("overlayCanvas").onclick=handleCanvasClick;
$("selectModeBtn").onclick=()=>{state.mode="select";$("selectModeBtn").classList.add("active");$("addModeBtn").classList.remove("active");};
$("addModeBtn").onclick=()=>{state.mode="add";$("addModeBtn").classList.add("active");$("selectModeBtn").classList.remove("active");};
$("deleteDetectionBtn").onclick=deleteSelected;
document.querySelectorAll("#channelTabs button").forEach(button=>button.onclick=()=>{
  document.querySelectorAll("#channelTabs button").forEach(item=>item.classList.remove("active"));button.classList.add("active");
  state.channel=button.dataset.channel;showImage();
});
document.querySelectorAll("#inspectionTabs button").forEach(button=>button.onclick=()=>{
  if(button.dataset.inspection==="binary"&&state.detections.some(item=>!item.manual&&!item.runs?.length)){
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
  drawOverlay();
};
document.querySelectorAll(".legend button[data-class]").forEach(button=>button.onclick=()=>{
  button.classList.toggle("active");button.classList.contains("active")?state.visibleClasses.add(button.dataset.class):state.visibleClasses.delete(button.dataset.class);renderInspectionView();
});
$("zoomInBtn").onclick=()=>setZoom(state.zoom+.25);$("zoomOutBtn").onclick=()=>setZoom(state.zoom-.25);$("fitBtn").onclick=()=>setZoom(1);
$("minArea").addEventListener("input",updateAreaNote);
$("viewer").addEventListener("wheel",event=>{event.preventDefault();setZoom(state.zoom+(event.deltaY<0?.15:-.15));},{passive:false});
window.addEventListener("resize",()=>state.currentViewId&&viewById(state.currentViewId).width&&fitStage(viewById(state.currentViewId).width,viewById(state.currentViewId).height));
