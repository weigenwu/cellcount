/* global UTIF */
const APP_ASSET_VERSION = "20260729-hero1";
const DEFAULTS = {
  threshold_mode: "manual", threshold_low: 15, threshold_high: 255,
  gaussian_sigma: 1, opening_radius: 1, watershed_min_distance: 12,
  min_area_px: 400, max_area_px: 20000, min_circularity: 0.3,
  max_circularity: 1,
};
const TARGETS = ["dapi", "nk", "tumor"];
const DEFAULT_CHANNEL_LABELS = {dapi:"DAPI", nk:"NK", tumor:"肿瘤"};
const DEFAULT_CIC_PARAMS = {
  evidence_profile:"ppt_annotated",
  rule_version:3,
  min_enclosure_coverage:0.55,
  ring_width_px:36,
  min_ring_contrast:0.05,
  max_candidates:200,
  red_quantile:0.72,
  sector_positive_fraction:0.18,
  homotypic_enabled:true,
  homotypic_min_coverage:0.88,
  homotypic_host_max_circularity:0.78,
  host_max_distance_px:150,
  min_host_separation_factor:0.58,
  host_radius_allowance:1.8,
  max_inner_host_area_ratio:1.5,
  max_inner_radius_factor:1.8,
};
function defaultParams(target) {
  return {
    ...DEFAULTS,
    analysis_mode:target === "dapi" ? "particles" : "nucleus_guided",
    signal_threshold:target === "nk" ? 10 : 15,
    positive_fraction:0.1,
    ring_radius_px:6,
  };
}
const state = {
  project: null, currentViewId: null, currentGroup: null, channel: "overlay", target: "dapi", layer:"cells",
  detections: [], selectedId: null, mode: "select", zoom: 1, worker: null,
  cicEvents: [], selectedCicId: null, cicMode:"select",
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
const channelCodes = {dapi:"ch00", nk:"ch01", tumor:"ch02"};
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
    version:2, browserVersion:true, name:root, pixel_size_um:pixelSizeUm, suffixes,
    channel_labels:{...DEFAULT_CHANNEL_LABELS},
    groups, views,
    parameters_by_group:Object.fromEntries(groups.map(group => [
      group,
      Object.fromEntries(TARGETS.map(target => [target, defaultParams(target)]))
    ])),
    cic_parameters_by_group:Object.fromEntries(groups.map(group=>[group,{...DEFAULT_CIC_PARAMS}])),
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
  if (Array.isArray(saved.selected_groups)) {
    state.selectedGroups=new Set(saved.selected_groups.filter(group=>state.project.groups.includes(group)));
  }
  for (const group of state.project.groups) {
    const savedGroup = saved.parameters_by_group?.[group];
    if (!savedGroup) continue;
    if (savedGroup.dapi || savedGroup.nk || savedGroup.tumor) {
      for (const target of TARGETS) {
        if (savedGroup[target]) state.project.parameters_by_group[group][target] = {...defaultParams(target), ...savedGroup[target]};
      }
    } else {
      for (const target of TARGETS) state.project.parameters_by_group[group][target] = {...defaultParams(target), ...savedGroup};
    }
    state.project.cic_parameters_by_group[group]={
      ...DEFAULT_CIC_PARAMS,
      ...(saved.cic_parameters_by_group?.[group]||saved.cic_parameters||{})
    };
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
      if (savedResult.cic) {
        if (!state.project.results[view.id]) state.project.results[view.id]={};
        state.project.results[view.id].cic={
          ...savedResult.cic,
          events:(savedResult.cic.events||[]).map(event=>({...event}))
        };
      }
      view.status = overallStatus(view);
    }
  }
  state.pendingProject = null;
  updateHistoryButtons();
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
function cicResult(viewId=state.currentViewId) { return state.project?.results?.[viewId]?.cic; }
function cicStatus(viewId=state.currentViewId) { return cicResult(viewId)?.status || "pending"; }
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
    wrapper.innerHTML = `<div class="group-header"><label class="group-select" title="选择此文件夹进行批量处理"><input type="checkbox" ${state.selectedGroups.has(group)?"checked":""}></label><button class="group-toggle"><strong>${escapeHtml(group)}</strong><small>${views.length}</small></button></div><div class="view-list"></div>`;
    const list = wrapper.querySelector(".view-list");
    views.forEach(view => {
      view.status = overallStatus(view);
      const button = document.createElement("button");
      button.className = `view-item${view.id === state.currentViewId ? " active" : ""}`;
      button.innerHTML = `<span class="status-dot ${view.status}"></span><span>${escapeHtml(view.name)}</span>`;
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
  updateCicPrerequisiteUi();
}

async function selectView(id) {
  state.currentViewId = id; state.selectedId = null; state.selectedCicId=null;
  const view = viewById(id);
  state.currentGroup = view.group;
  $("currentGroupLabel").textContent = view.group;
  $("currentViewLabel").textContent = view.name;
  $("profileGroup").textContent = `${view.group} · ${targetLabel(state.target)}`;
  populateParameters(state.project.parameters_by_group[view.group][state.target]);
  state.detections = targetResult(id)?.detections || [];
  state.cicEvents = cicResult(id)?.events || [];
  populateCicParameters(state.project.cic_parameters_by_group[view.group]);
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
  const file = state.layer==="cic" ? (view?.files.overlay||view?.files.dapi) : (view?.files[state.channel] || view?.files.dapi);
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
  state.fitLeft = (viewer.clientWidth - displayWidth) / 2;
  state.fitTop = (viewer.clientHeight - displayHeight) / 2;
  stage.style.left = `${state.fitLeft}px`;
  stage.style.top = `${state.fitTop}px`;
  state.panX = 0; state.panY = 0; state.zoom = 1;
  applyViewportTransform();
}

function buildDetectionMask(width, height, detections, visibleClasses=null) {
  const mask = document.createElement("canvas");
  mask.width = width; mask.height = height;
  const context = mask.getContext("2d");
  context.fillStyle = "#fff";
  for (const item of detections) {
    if (item.deleted || (visibleClasses && !visibleClasses.has(item.classification))) continue;
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
  if (state.layer==="cic") {
    state.inspectionMode="original";
    context.putImageData(new ImageData(state.rawImage.rgba,state.rawImage.width,state.rawImage.height),0,0);
    drawCicOverlay($("overlayCanvas"));
    return;
  }
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

function cicDisplayColor(event) {
  if (event.classification==="heterotypic") return "#32d6ff";
  if (event.classification==="homotypic") return "#b98cff";
  return event.type_hint==="homotypic" ? "#ff8f55" : "#ffbd4a";
}
function drawCicOverlay(target=$("overlayCanvas")) {
  if (!target.width) return;
  const context=target.getContext("2d");
  context.clearRect(0,0,target.width,target.height);
  let index=0;
  for (const event of state.cicEvents) {
    if (event.deleted || event.classification==="rejected") continue;
    index++;
    const color=cicDisplayColor(event);
    const inner=Math.max(10,event.inner_radius||event.radius||16);
    const outer=Math.max(inner+10,event.outer_radius||inner+36);
    context.save();
    context.strokeStyle=color;
    context.lineWidth=event.id===state.selectedCicId?5:3;
    if (event.classification==="pending") context.setLineDash([10,7]);
    context.beginPath();context.arc(event.x,event.y,inner,0,Math.PI*2);context.stroke();
    context.globalAlpha=.8;
    context.beginPath();context.arc(event.x,event.y,outer,0,Math.PI*2);context.stroke();
    context.setLineDash([]);
    if (Number.isFinite(event.outer_x)&&Number.isFinite(event.outer_y)) {
      context.globalAlpha=.65;
      context.beginPath();context.moveTo(event.x,event.y);context.lineTo(event.outer_x,event.outer_y);context.stroke();
      context.beginPath();context.arc(event.outer_x,event.outer_y,5,0,Math.PI*2);context.fillStyle=color;context.fill();
    }
    context.restore();
    if (!state.showLabels) continue;
    const grade=event.evidence_grade||"";
    const prefix=event.classification==="heterotypic"?"异":event.classification==="homotypic"?"同":event.type_hint==="homotypic"?"同?":`异${grade}?`;
    context.font="700 16px system-ui";context.textAlign="center";context.textBaseline="middle";
    context.lineWidth=4;context.strokeStyle="rgba(0,0,0,.9)";context.fillStyle="#fff";
    const label=`${prefix}${index}`;
    context.strokeText(label,event.x,event.y-outer-12);context.fillText(label,event.x,event.y-outer-12);
  }
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
  analysisMode:"analysis_mode",
  thresholdMode:"threshold_mode", thresholdLow:"threshold_low", thresholdHigh:"threshold_high",
  minArea:"min_area_px", maxArea:"max_area_px", minCircularity:"min_circularity",
  maxCircularity:"max_circularity", gaussianSigma:"gaussian_sigma",
  watershedDistance:"watershed_min_distance",
  signalThreshold:"signal_threshold", positiveFraction:"positive_fraction", ringRadius:"ring_radius_px",
};
function populateParameters(params) {
  Object.entries(fieldMap).forEach(([id,key]) => $(id).value = params[key]);
  $("analysisMode").disabled = state.target === "dapi";
  if (state.target === "dapi") $("analysisMode").value = "particles";
  updateParameterVisibility();
  updateAreaNote();
}
function collectParameters() {
  const params = {...state.project.parameters_by_group[state.currentGroup][state.target]};
  Object.entries(fieldMap).forEach(([id,key]) => {
    params[key] = id === "thresholdMode" || id === "analysisMode" ? $(id).value : Number($(id).value);
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
  if (!state.currentGroup) return;
  const params = collectParameters();
  if (params.threshold_low > params.threshold_high) return toast("阈值下限不能大于上限", true);
  if (params.positive_fraction < 0 || params.positive_fraction > 1) return toast("阳性像素比例必须在 0–1 之间", true);
  state.project.parameters_by_group[state.currentGroup][state.target] = params;
  if (all) state.project.groups.forEach(group => state.project.parameters_by_group[group][state.target] = {...params});
  scheduleAutosave();
  toast(all ? `${targetLabel(state.target)} 参数已应用到全部实验组` : `已保存“${state.currentGroup}”的 ${targetLabel(state.target)} 参数`);
}
function updateAreaNote() {
  if (!state.project) return;
  const area = Number($("minArea").value||0);
  $("areaConversion").textContent = `${area} px² ≈ ${(area*state.project.pixel_size_um**2).toFixed(1)} µm²`;
}

const cicFieldMap={
  cicMinCoverage:"min_enclosure_coverage",
  cicRingWidth:"ring_width_px",
  cicMinContrast:"min_ring_contrast",
  cicMaxCandidates:"max_candidates",
};
function populateCicParameters(params={}) {
  const merged={...DEFAULT_CIC_PARAMS,...params};
  Object.entries(cicFieldMap).forEach(([id,key])=>$(id).value=merged[key]);
  $("cicEvidenceProfile").value=merged.evidence_profile;
  $("cicHomotypicEnabled").checked=Boolean(merged.homotypic_enabled);
}
function collectCicParameters() {
  const params={...DEFAULT_CIC_PARAMS,...state.project.cic_parameters_by_group[state.currentGroup]};
  Object.entries(cicFieldMap).forEach(([id,key])=>params[key]=Number($(id).value));
  params.evidence_profile=$("cicEvidenceProfile").value;
  params.rule_version=3;
  params.homotypic_enabled=$("cicHomotypicEnabled").checked;
  return params;
}
function applyCicPptPreset() {
  if(!state.currentGroup)return;
  $("cicEvidenceProfile").value="ppt_annotated";
  $("cicMinCoverage").value="0.55";
  $("cicRingWidth").value="36";
  $("cicMinContrast").value="0.05";
  const params=saveCicParameters(false);
  if(params)toast("已应用 CIC 标注 PPT 推荐参数；同质 CIC 规则保持保守");
}
function saveCicParameters(all=false) {
  if (!state.currentGroup) return null;
  const params=collectCicParameters();
  if (params.min_enclosure_coverage<0.25||params.min_enclosure_coverage>1) {
    toast("CIC 最小包围比例必须在 0.25–1 之间",true);return null;
  }
  if (params.ring_width_px<8||params.max_candidates<10) {
    toast("CIC 环宽或最多候选数过小",true);return null;
  }
  state.project.cic_parameters_by_group[state.currentGroup]={...params};
  if (all) state.project.groups.forEach(group=>state.project.cic_parameters_by_group[group]={...params});
  scheduleAutosave();
  return params;
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
        ? (targetResult(view.id,"dapi").detections || []).filter(item=>!item.deleted)
        : null;
      const anchorBuffer = guided && !anchorDetections ? await view.files.dapi.arrayBuffer() : null;
      const transfers = anchorBuffer ? [channelBuffer,anchorBuffer] : [channelBuffer];
      worker.postMessage({
        type:"analyze", params, target, targetLabel:targetLabel(target),
        pixelSizeUm:state.project.pixel_size_um,
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
  saveParameters(false);
  const target = state.target;
  let views = scope === "current" ? [viewById(state.currentViewId)] :
    scope === "group" ? groupViews(state.currentGroup) :
    scope === "pending" ? state.project.views.filter(view => state.selectedGroups.has(view.group) && targetStatus(view.id,target) !== "done") :
    state.project.views.filter(view=>state.selectedGroups.has(view.group));
  views = views.filter(view => !view.error);
  if (!views.length) return toast(scope==="all"||scope==="pending"?"请先勾选至少一个有可分析视野的文件夹":"没有未完成且可分析的视野",true);
  const label = targetLabel(target);
  if (views.some(view => countTargetDetections(targetResult(view.id,target)?.detections||[]).corrected > 0)) {
    const guidance = target === "dapi"
      ? `\n\n当前计数对象仍是 ${label}。若要分析 ${targetLabel("nk")} 或 ${targetLabel("tumor")}，请先选择对应通道。`
      : "";
    if (!confirm(`当前正在重新分析 ${label}。所选范围包含 ${label} 自身的人工修正，继续只会清除这些 ${label} 修正；其他通道不受影响。是否继续？${guidance}`)) return;
  }
  const hasCicResults=views.some(view=>cicStatus(view.id)!=="pending");
  if(hasCicResults&&!confirm(`所选范围已有 CIC 候选或人工确认。重新分析 ${label} 后细胞坐标可能变化，因此只会将这些视野的 CIC 结果重置为“未分析”；三类细胞的其他结果不受影响。是否继续？`))return;
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
      if(hasCicResults)state.project.results[view.id].cic={status:"pending",error:"",events:[]};
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
  scheduleAutosave();
  toast(state.cancelled ? `${targetLabel(target)} 批处理已停止，已完成结果仍保留` : `${targetLabel(target)} 分析完成`);
}

function compactDetections(detections=[]) {
  return detections.filter(item=>!item.deleted).map(item=>({
    id:item.id,x:item.x,y:item.y,radius:item.radius||12,area_px:item.area_px||0,
    circularity:Number.isFinite(item.circularity)?item.circularity:1,
    positive_fraction:item.positive_fraction==null?null:Number(item.positive_fraction),
    anchor_manual:Boolean(item.anchor_manual),manual:Boolean(item.manual)
  }));
}
function analyzeCicOne(view,params) {
  return new Promise(async(resolve,reject)=>{
    state.cancelReject=()=>reject(new Error("__cancelled__"));
    const worker=createWorker();
    worker.onmessage=event=>{
      if(event.data.type==="progress") $("jobCurrent").textContent=`${view.group} / ${view.name} · ${event.data.phase}`;
      else if(event.data.type==="result"){state.cancelReject=null;resolve(event.data);}
      else if(event.data.type==="error"){state.cancelReject=null;reject(new Error(event.data.error));}
    };
    worker.onerror=event=>{state.cancelReject=null;reject(new Error(event.message||"CIC 分析线程失败"));};
    try {
      const redBuffer=await view.files.tumor.arrayBuffer();
      worker.postMessage({
        type:"analyze_cic",params,
        redBuffer,redExtension:extension(view.files.tumor.name),
        nkDetections:compactDetections(targetResult(view.id,"nk")?.detections),
        tumorDetections:compactDetections(targetResult(view.id,"tumor")?.detections),
        pixelSizeUm:state.project.pixel_size_um,
      },[redBuffer]);
    } catch(error){state.cancelReject=null;reject(error);}
  });
}
function cicPrerequisitesReady(view) {
  return TARGETS.every(target=>targetStatus(view.id,target)==="done");
}
function updateCicPrerequisiteUi() {
  if(!state.project||!$("cicPrerequisiteBadge"))return;
  const current=state.currentViewId?viewById(state.currentViewId):null;
  const currentDone=current?TARGETS.filter(target=>targetStatus(current.id,target)==="done").length:0;
  const currentReady=Boolean(current&&cicPrerequisitesReady(current));
  const currentGroupViews=state.currentGroup?groupViews(state.currentGroup).filter(view=>!view.error):[];
  const groupReady=currentGroupViews.length>0&&currentGroupViews.every(cicPrerequisitesReady);
  const selectedViews=state.project.views.filter(view=>state.selectedGroups.has(view.group)&&!view.error);
  const selectedReady=selectedViews.filter(cicPrerequisitesReady).length;
  const allSelectedReady=selectedViews.length>0&&selectedReady===selectedViews.length;
  const badge=$("cicPrerequisiteBadge");
  badge.textContent=currentReady
    ? (cicStatus()==="done"?"当前视野已筛查":"三类计数已完成")
    : `当前视野 ${currentDone}/3`;
  badge.title=`已选文件夹中 ${selectedReady}/${selectedViews.length} 个视野完成三类计数`;
  badge.classList.toggle("ready",currentReady);
  $("cicPanel").classList.toggle("ready",currentReady);
  $("analyzeCicCurrentBtn").disabled=!currentReady;
  $("analyzeCicGroupBtn").disabled=!groupReady;
  $("analyzeCicAllBtn").disabled=!allSelectedReady;
  const hasPending=state.project.views.some(view=>(cicResult(view.id)?.events||[]).some(event=>!event.deleted&&event.classification==="pending"));
  $("reviewPendingCicBtn").disabled=!hasPending;
  $("analyzeCicCurrentBtn").title=currentReady?"":"请先完成当前视野的三类细胞计数";
  $("analyzeCicGroupBtn").title=groupReady?"":"请先完成当前实验组全部视野的三类细胞计数";
  $("analyzeCicAllBtn").title=allSelectedReady?"":`已选文件夹完成 ${selectedReady}/${selectedViews.length} 个视野`;
}
async function analyzeCicScope(scope) {
  if (!state.project||state.busy) return;
  const params=saveCicParameters(false);
  if (!params) return;
  let views=scope==="current"?[viewById(state.currentViewId)]:
    scope==="group"?groupViews(state.currentGroup):
    state.project.views.filter(view=>state.selectedGroups.has(view.group));
  views=views.filter(view=>!view.error);
  const missing=views.filter(view=>!cicPrerequisitesReady(view));
  views=views.filter(cicPrerequisitesReady);
  if (!views.length) return toast("请先完成所选视野的 DAPI、NK 和肿瘤三类计数，再筛查 CIC",true);
  if (views.some(view=>(cicResult(view.id)?.events||[]).some(event=>event.manual||event.reviewed))) {
    if(!confirm("重新筛查只会清除所选视野的 CIC 候选及 CIC 人工确认；原有 DAPI、NK、肿瘤计数和人工修正不会改变。是否继续？")) return;
  }
  state.busy=true;state.cancelled=false;
  $("jobPanel").classList.remove("hidden");
  const started=performance.now();
  for(let index=0;index<views.length;index++){
    if(state.cancelled) break;
    const view=views[index];
    if(!state.project.results[view.id])state.project.results[view.id]={};
    const previous=state.project.results[view.id].cic;
    state.project.results[view.id].cic={...(previous||{}),status:"running",error:""};
    $("jobTitle").textContent=`正在筛查 CIC ${index+1}/${views.length}`;
    const percent=Math.round(index/views.length*100);
    $("jobPercent").textContent=`${percent}%`;$("jobProgress").style.width=`${percent}%`;
    renderResults();updateCounts();
    try{
      const result=await analyzeCicOne(view,state.project.cic_parameters_by_group[view.group]);
      if(state.cancelled)break;
      state.project.results[view.id].cic={
        status:"done",error:"",events:result.events,
        parameters:{...state.project.cic_parameters_by_group[view.group]},
        method:"2d_candidate_screening_requires_manual_confirmation",
      };
    }catch(error){
      if(state.cancelled){state.project.results[view.id].cic=previous||{status:"pending",error:"",events:[]};break;}
      state.project.results[view.id].cic={status:"error",error:error.message,events:[]};
    }
    const elapsed=(performance.now()-started)/1000,remaining=elapsed/(index+1)*(views.length-index-1);
    $("jobCurrent").textContent=`${view.group} / ${view.name} · 剩余约 ${formatSeconds(remaining)}`;
    renderResults();updateCounts();
  }
  if(state.worker)state.worker.terminate();
  state.worker=null;state.cancelReject=null;state.busy=false;
  $("jobPanel").classList.add("hidden");
  state.cicEvents=cicResult()?.events||[];
  if(state.layer==="cic")renderInspectionView();
  const skipped=missing.length?`；另有 ${missing.length} 个视野因三类计数未完成而跳过`:"";
  scheduleAutosave();
  toast(state.cancelled?`CIC 筛查已停止${skipped}`:`CIC 候选筛查完成${skipped}`);
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
function cicCounts(viewId) {
  const events=cicResult(viewId)?.events||[];
  const active=events.filter(event=>!event.deleted);
  return {
    heterotypic:active.filter(event=>event.classification==="heterotypic").length,
    homotypic:active.filter(event=>event.classification==="homotypic").length,
    pending:active.filter(event=>event.classification==="pending").length,
    rejected:active.filter(event=>event.classification==="rejected").length,
    corrected:events.filter(event=>event.manual||event.reviewed||event.deleted).length,
  };
}
function updateCounts() {
  const counts=state.currentViewId?viewCounts(state.currentViewId):{};
  $("countDapi").textContent=targetStatus(state.currentViewId,"dapi")==="done"?counts.dapi.total:"—";
  $("countTumor").textContent=targetStatus(state.currentViewId,"tumor")==="done"?counts.tumor.total:"—";
  $("countNk").textContent=targetStatus(state.currentViewId,"nk")==="done"?counts.nk.total:"—";
  const cic=state.currentViewId?cicCounts(state.currentViewId):{};
  $("countCicHeterotypic").textContent=cicStatus()==="done"?cic.heterotypic:"—";
  $("countCicHomotypic").textContent=cicStatus()==="done"?cic.homotypic:"—";
  $("countCicPending").textContent=cicStatus()==="done"?cic.pending:"—";
  const cicStatusLabels={pending:"未分析",running:"分析中",done:"已筛查",error:"错误"};
  $("countCicStatus").textContent=cicStatusLabels[cicStatus()]||cicStatus();
  $("currentTargetName").textContent=targetLabel(state.target);
  updateActionLabels();
  updateCicPrerequisiteUi();
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
    const cic=cicCounts(view.id);
    const corrected=c.dapi.corrected+c.nk.corrected+c.tumor.corrected;
    const status=[...TARGETS.map(target=>`${targetLabel(target)} ${short[targetStatus(view.id,target)]}`),`CIC ${short[cicStatus(view.id)]}`].join(" · ");
    const cicDone=cicStatus(view.id)==="done";
    return `<tr><td>${escapeHtml(view.group)} / ${escapeHtml(view.name)}</td><td>${targetStatus(view.id,"dapi")==="done"?c.dapi.total:"—"}</td><td>${targetStatus(view.id,"nk")==="done"?c.nk.total:"—"}</td><td>${targetStatus(view.id,"tumor")==="done"?c.tumor.total:"—"}</td><td>${cicDone?cic.heterotypic:"—"}</td><td>${cicDone?cic.homotypic:"—"}</td><td>${cicDone?cic.pending:"—"}</td><td>${corrected+cic.corrected}</td><td class="status-${overallStatus(view)}" title="${escapeHtml(view.error||cicResult(view.id)?.error||"")}">${escapeHtml(status)}</td></tr>`;
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
    if (!item.runs?.length) return false;
    for (let index=0; index<item.runs.length; index+=3) {
      if (item.runs[index]===pixelY && pixelX>=item.runs[index+1] && pixelX<=item.runs[index+2]) return true;
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
function cicEventAtPoint(point) {
  let best=null,distance=Infinity;
  for(const event of state.cicEvents){
    if(event.deleted||event.classification==="rejected")continue;
    const d=Math.hypot(event.x-point.x,event.y-point.y);
    if(d<=Math.max(24,event.outer_radius||48)&&d<distance){best=event;distance=d;}
  }
  return best;
}
function syncCicCorrections(message="CIC 修正已保存") {
  if(!state.project.results[state.currentViewId])state.project.results[state.currentViewId]={};
  state.project.results[state.currentViewId].cic={
    ...(cicResult()||{}),status:"done",error:"",events:state.cicEvents
  };
  state.selectedCicId=null;
  updateCounts();renderInspectionView();renderResults();
  scheduleAutosave();
  $("cicSelectionHint").textContent=message;
}
function handleCicCanvasClick(event) {
  if(state.mode==="pan")return;
  if(cicStatus()!=="done"&&state.mode!=="cic-add")return toast("请先筛查当前视野 CIC 候选",true);
  const point=canvasPoint(event);
  if(state.mode==="cic-add"){
    pushHistory("cic");
    const id=`cic-manual-${Date.now()}`;
    state.cicEvents.push({
      id,x:point.x,y:point.y,inner_radius:18,outer_radius:54,
      classification:"pending",type_hint:"heterotypic",confidence:null,
      source:"manual",manual:true,reviewed:false,deleted:false,
    });
    state.selectedCicId=id;
    if(!state.project.results[state.currentViewId])state.project.results[state.currentViewId]={};
    state.project.results[state.currentViewId].cic={
      ...(cicResult()||{}),status:"done",error:"",events:state.cicEvents
    };
    updateCounts();renderInspectionView();renderResults();
    $("cicSelectionHint").textContent="已添加 CIC，请确认异质、同质或排除";
    return;
  }
  const selected=cicEventAtPoint(point);
  state.selectedCicId=selected?.id||null;
  $("cicSelectionHint").textContent=selected
    ? `${selected.id} · ${selected.evidence_grade?`${selected.evidence_grade} 级 · `:""}自动提示 ${selected.type_hint==="homotypic"?"同质":"异质"} · 包围 ${Number(selected.enclosure_coverage||0).toFixed(2)} · 对侧 ${selected.opposite_pairs??"—"}/8 · 象限 ${selected.quadrant_count??"—"}/4 · 径向 ${Number(selected.radial_coherence||0).toFixed(2)}`
    :"未选中 CIC 候选";
  drawCicOverlay();
}
function classifySelectedCic(classification) {
  const event=state.cicEvents.find(item=>item.id===state.selectedCicId);
  if(!event)return toast("请先选择一个 CIC 候选",true);
  pushHistory("cic");
  event.classification=classification;event.reviewed=true;event.manual=true;
  syncCicCorrections(classification==="heterotypic"?`已确认异质 CIC：${event.id}`:`已确认同质 CIC：${event.id}`);
}
function rejectSelectedCic() {
  const event=state.cicEvents.find(item=>item.id===state.selectedCicId);
  if(!event)return toast("请先选择一个 CIC 候选",true);
  pushHistory("cic");
  event.classification="rejected";event.reviewed=true;event.manual=true;
  syncCicCorrections(`已排除候选：${event.id}`);
}
function deleteSelectedCic() {
  const event=state.cicEvents.find(item=>item.id===state.selectedCicId);
  if(!event)return toast("请先选择一个 CIC 候选",true);
  pushHistory("cic");
  event.deleted=true;event.reviewed=true;event.manual=true;
  syncCicCorrections(`已删除 CIC 标记：${event.id}`);
}
function handleCanvasClick(event) {
  if(state.layer==="cic")return handleCicCanvasClick(event);
  if (state.mode==="pan") return;
  if (!targetResult(state.currentViewId)?.detections) return toast(`请先预跑当前视野的 ${targetLabel(state.target)}`);
  const point=canvasPoint(event);
  if (state.mode==="add") {
    pushHistory("cell");
    state.detections.push({id:`manual-${Date.now()}`,x:point.x,y:point.y,area_px:452.39,area_um2:452.39*state.project.pixel_size_um**2,radius:12,circularity:1,classification:state.target,manual:true,deleted:false});
    syncCorrections(); return;
  }
  const best=detectionAtPoint(point);
  if (state.mode==="delete") {
    if (!best) { $("selectionHint").textContent="未点中细胞标记"; return; }
    pushHistory("cell");
    best.deleted=true; best.manual=true;
    syncCorrections();
    $("selectionHint").textContent=`已删除 ${best.id}`;
    return;
  }
  state.selectedId=best?.id||null;
  $("selectionHint").textContent=best?`已选择 ${best.id}`:"未选中标记";
  drawOverlay();
}
function syncCorrections() {
  state.project.results[state.currentViewId][state.target].detections=state.detections;
  state.selectedId=null; updateCounts(); renderInspectionView(); renderResults();
  scheduleAutosave();
}
function reclassify(classification) {
  const item=state.detections.find(d=>d.id===state.selectedId); if(!item)return;
  item.classification=state.target;item.manual=true;syncCorrections();
}
function deleteSelected() {
  const item=state.detections.find(d=>d.id===state.selectedId);
  if(!item) return toast("请先选择要删除的细胞标记",true);
  pushHistory("cell");
  item.deleted=true;item.manual=true;syncCorrections();
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
    if(viewResult.cic){
      serializedResults[viewId].cic={
        ...viewResult.cic,
        events:(viewResult.cic.events||[]).map(event=>({...event}))
      };
    }
  }
  return {
    version:2,browserVersion:true,name:state.project.name,pixel_size_um:state.project.pixel_size_um,
    suffixes:state.project.suffixes,channel_labels:state.project.channel_labels,
    selected_groups:[...state.selectedGroups],
    groups:state.project.groups,parameters_by_group:state.project.parameters_by_group,
    cic_parameters_by_group:state.project.cic_parameters_by_group,
    views:state.project.views.map(({id,group,name,width,height,status,error,fileNames})=>({id,group,name,width,height,status,error,fileNames})),
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
function historySnapshot(kind,viewId=state.currentViewId,target=state.target) {
  const value=kind==="cic" ? state.project.results[viewId]?.cic : state.project.results[viewId]?.[target];
  return {kind,viewId,target,value:cloneResult(value)};
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
  if(snapshot.kind==="cic")state.project.results[snapshot.viewId].cic=cloneResult(snapshot.value);
  else state.project.results[snapshot.viewId][snapshot.target]=cloneResult(snapshot.value);
  if(snapshot.viewId!==state.currentViewId)await selectView(snapshot.viewId);
  if(snapshot.kind==="cic"){
    state.cicEvents=cicResult()?.events||[];
    state.selectedCicId=null;
  }else{
    if(state.target!==snapshot.target)await setTarget(snapshot.target);
    state.detections=targetResult(snapshot.viewId,snapshot.target)?.detections||[];
    state.selectedId=null;
  }
  updateCounts();renderResults();renderGroups();renderInspectionView();scheduleAutosave();
}
async function undoCorrection() {
  const snapshot=state.undoStack.pop();
  if(!snapshot)return;
  state.redoStack.push(historySnapshot(snapshot.kind,snapshot.viewId,snapshot.target));
  await restoreHistorySnapshot(snapshot);updateHistoryButtons();toast("已撤销上一次人工修正");
}
async function redoCorrection() {
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
  detections.forEach((item,index)=>{
    const fontSize=Math.max(13,Math.min(24,(item.radius||12)*0.8));
    context.font=`700 ${fontSize}px system-ui`;
    context.textAlign="center";context.textBaseline="middle";context.lineWidth=3;
    context.strokeStyle="rgba(0,0,0,.85)";context.fillStyle="#fff";
    context.strokeText(String(index+1),item.x,item.y);
    context.fillText(String(index+1),item.x,item.y);
  });
  const title=`${view.group} / ${view.name} · ${targetLabel(target)} · n=${detections.length}`;
  context.font="700 22px system-ui";context.textAlign="left";context.textBaseline="top";
  const titleWidth=Math.min(decoded.width-24,context.measureText(title).width+28);
  context.fillStyle="rgba(0,0,0,.72)";context.fillRect(12,12,titleWidth,44);
  context.fillStyle="#fff";context.fillText(title,26,23,decoded.width-52);
  const blob=await canvasBlob(canvas);
  canvas.width=1;canvas.height=1;mask.width=1;mask.height=1;
  return blob;
}
async function cicAnnotatedBlob(view) {
  const decoded=await decodeRgba(view.files.overlay||view.files.dapi);
  const canvas=document.createElement("canvas");
  canvas.width=decoded.width;canvas.height=decoded.height;
  const context=canvas.getContext("2d");
  context.putImageData(new ImageData(decoded.rgba,decoded.width,decoded.height),0,0);
  const events=(cicResult(view.id)?.events||[]).filter(event=>!event.deleted&&event.classification!=="rejected");
  events.forEach((event,index)=>{
    const color=cicDisplayColor(event);
    const inner=Math.max(10,event.inner_radius||16),outer=Math.max(inner+10,event.outer_radius||inner+36);
    context.save();context.strokeStyle=color;context.lineWidth=4;
    if(event.classification==="pending")context.setLineDash([12,8]);
    context.beginPath();context.arc(event.x,event.y,inner,0,Math.PI*2);context.stroke();
    context.globalAlpha=.8;context.beginPath();context.arc(event.x,event.y,outer,0,Math.PI*2);context.stroke();
    context.restore();
    const prefix=event.classification==="heterotypic"?"异":event.classification==="homotypic"?"同":`待${event.evidence_grade||""}`;
    context.font="700 18px system-ui";context.textAlign="center";context.textBaseline="middle";
    context.lineWidth=4;context.strokeStyle="rgba(0,0,0,.9)";context.fillStyle="#fff";
    context.strokeText(`${prefix}${index+1}`,event.x,event.y-outer-13);
    context.fillText(`${prefix}${index+1}`,event.x,event.y-outer-13);
  });
  const counts=cicCounts(view.id);
  const title=`${view.group} / ${view.name} · 异质 ${counts.heterotypic} · 同质 ${counts.homotypic} · 待复核 ${counts.pending}`;
  context.font="700 22px system-ui";context.textAlign="left";context.textBaseline="top";
  const titleWidth=Math.min(decoded.width-24,context.measureText(title).width+28);
  context.fillStyle="rgba(0,0,0,.75)";context.fillRect(12,12,titleWidth,44);
  context.fillStyle="#fff";context.fillText(title,26,23,decoded.width-52);
  const blob=await canvasBlob(canvas);canvas.width=1;canvas.height=1;return blob;
}
function csvText(views=state.project.views) {
  const headers=[
    "实验组","视野",
    ...TARGETS.map(target=>`${targetLabel(target)}总数`),
    "异质CIC","同质CIC","待复核CIC","排除CIC",
    ...TARGETS.map(target=>`${targetLabel(target)}修正数`),
    "CIC人工修正数",
    ...TARGETS.map(target=>`${targetLabel(target)}状态`),
    "CIC状态",
    "错误"
  ];
  const rows=views.map(view=>{
    const c=viewCounts(view.id);
    const cic=cicCounts(view.id);
    return [
      view.group,view.name,
      targetStatus(view.id,"dapi")==="done"?c.dapi.total:"",
      targetStatus(view.id,"nk")==="done"?c.nk.total:"",
      targetStatus(view.id,"tumor")==="done"?c.tumor.total:"",
      cicStatus(view.id)==="done"?cic.heterotypic:"",
      cicStatus(view.id)==="done"?cic.homotypic:"",
      cicStatus(view.id)==="done"?cic.pending:"",
      cicStatus(view.id)==="done"?cic.rejected:"",
      c.dapi.corrected,c.nk.corrected,c.tumor.corrected,
      cic.corrected,
      targetStatus(view.id,"dapi"),targetStatus(view.id,"nk"),targetStatus(view.id,"tumor"),
      cicStatus(view.id),view.error||cicResult(view.id)?.error||""
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
  const rows=[["实验组","视野","通道","对象编号","分类","X_px","Y_px","面积_px2","面积_um2","圆度","阳性像素比例","人工添加或修改","由人工核锚定","已删除"]];
  for(const view of views){
    for(const target of TARGETS){
      for(const item of targetResult(view.id,target)?.detections||[]){
        rows.push([
          view.group,view.name,targetLabel(target),item.id,item.classification,
          Number(item.x).toFixed(2),Number(item.y).toFixed(2),
          item.area_px??"",item.area_um2==null?"":Number(item.area_um2).toFixed(4),
          item.circularity==null?"":Number(item.circularity).toFixed(4),
          item.positive_fraction==null?"":Number(item.positive_fraction).toFixed(4),
          Boolean(item.manual),Boolean(item.anchor_manual),Boolean(item.deleted)
        ]);
      }
    }
  }
  return csvEncode(rows);
}
function cicRawCsv(views=state.project.views) {
  const rows=[["实验组","视野","CIC编号","最终分类","自动提示","证据等级","判定规则","内部细胞类型","外部细胞类型","内部细胞编号","外部细胞编号","X_px","Y_px","包围比例","环内差异","对侧支持数_8","覆盖象限数_4","最大连续缺口_16","径向一致性","近层覆盖","远层覆盖","宿主核距离_px","内外细胞面积比","内部NK半径相对中位数","内部绿色阳性比例","置信分","来源","已人工复核","人工修正","已删除"]];
  for(const view of views){
    for(const event of cicResult(view.id)?.events||[]){
      const innerType=TARGETS.includes(event.inner_cell_type)?targetLabel(event.inner_cell_type):event.inner_cell_type;
      const outerType=TARGETS.includes(event.outer_cell_type)?targetLabel(event.outer_cell_type):event.outer_cell_type;
      rows.push([
        view.group,view.name,event.id,event.classification,event.type_hint,event.evidence_grade,event.evidence_rule,
        innerType,outerType,event.inner_cell_id,event.outer_cell_id,
        Number(event.x).toFixed(2),Number(event.y).toFixed(2),
        event.enclosure_coverage==null?"":Number(event.enclosure_coverage).toFixed(4),
        event.ring_contrast==null?"":Number(event.ring_contrast).toFixed(4),
        event.opposite_pairs??"",event.quadrant_count??"",event.largest_gap_sectors??"",
        event.radial_coherence==null?"":Number(event.radial_coherence).toFixed(4),
        event.near_coverage==null?"":Number(event.near_coverage).toFixed(4),
        event.far_coverage==null?"":Number(event.far_coverage).toFixed(4),
        event.host_distance_px==null?"":Number(event.host_distance_px).toFixed(2),
        event.inner_host_area_ratio==null?"":Number(event.inner_host_area_ratio).toFixed(4),
        event.inner_radius_typical_ratio==null?"":Number(event.inner_radius_typical_ratio).toFixed(4),
        event.inner_positive_fraction==null?"":Number(event.inner_positive_fraction).toFixed(4),
        event.confidence==null?"":Number(event.confidence).toFixed(4),
        event.source,Boolean(event.reviewed),Boolean(event.manual),Boolean(event.deleted)
      ]);
    }
  }
  return csvEncode(rows);
}
function meanSd(values) {
  if(!values.length)return{mean:0,sd:0};
  const mean=values.reduce((sum,value)=>sum+value,0)/values.length;
  const sd=values.length>1?Math.sqrt(values.reduce((sum,value)=>sum+(value-mean)**2,0)/(values.length-1)):0;
  return{mean,sd};
}
function cicGroupStats(views=state.project.views) {
  return state.project.groups.filter(group=>views.some(view=>view.group===group)).map(group=>{
    const groupDone=views.filter(view=>view.group===group&&cicStatus(view.id)==="done");
    const hetero=groupDone.map(view=>cicCounts(view.id).heterotypic);
    const homo=groupDone.map(view=>cicCounts(view.id).homotypic);
    const pending=groupDone.map(view=>cicCounts(view.id).pending);
    const hs=meanSd(hetero),os=meanSd(homo);
    return{
      group,n:groupDone.length,
      heterotypic_total:hetero.reduce((a,b)=>a+b,0),homotypic_total:homo.reduce((a,b)=>a+b,0),
      pending_total:pending.reduce((a,b)=>a+b,0),
      heterotypic_mean:hs.mean,heterotypic_sd:hs.sd,
      homotypic_mean:os.mean,homotypic_sd:os.sd,
    };
  });
}
function cicSummaryCsv(views=state.project.views) {
  const rows=[["实验组","已完成视野数","异质CIC总数","异质CIC每视野均值","异质CIC标准差","同质CIC总数","同质CIC每视野均值","同质CIC标准差","待复核总数"]];
  for(const item of cicGroupStats(views))rows.push([
    item.group,item.n,item.heterotypic_total,item.heterotypic_mean.toFixed(4),item.heterotypic_sd.toFixed(4),
    item.homotypic_total,item.homotypic_mean.toFixed(4),item.homotypic_sd.toFixed(4),item.pending_total
  ]);
  return csvEncode(rows);
}
function xmlEscape(value){return String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[char]));}
function cicPlotSvg(views=state.project.views) {
  const data=cicGroupStats(views),width=1100,height=650,left=90,right=35,top=65,bottom=135;
  const chartW=width-left-right,chartH=height-top-bottom;
  const max=Math.max(1,...data.flatMap(item=>[item.heterotypic_mean+item.heterotypic_sd,item.homotypic_mean+item.homotypic_sd]));
  const niceMax=Math.ceil(max*1.15*2)/2;
  const groupW=chartW/Math.max(1,data.length),barW=Math.min(58,groupW*.26);
  const y=value=>top+chartH-value/niceMax*chartH;
  const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="white"/>`,
    `<text x="${width/2}" y="32" text-anchor="middle" font-family="Microsoft YaHei, Arial, sans-serif" font-size="22" font-weight="700">CIC 每视野计数（均值 ± 标准差）</text>`];
  for(let tick=0;tick<=5;tick++){
    const value=niceMax*tick/5,yy=y(value);
    parts.push(`<line x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}" stroke="#dfe4ea"/>`);
    parts.push(`<text x="${left-12}" y="${yy+5}" text-anchor="end" font-family="Microsoft YaHei, Arial, sans-serif" font-size="13" fill="#44505e">${value.toFixed(value<5?1:0)}</text>`);
  }
  data.forEach((item,index)=>{
    const center=left+groupW*(index+.5);
    [[item.heterotypic_mean,item.heterotypic_sd,"#24bfe8",-barW*.65],[item.homotypic_mean,item.homotypic_sd,"#9b6ee8",barW*.65]].forEach(([mean,sd,color,offset])=>{
      const x=center+offset-barW/2,yy=y(mean),h=top+chartH-yy,errTop=y(mean+sd),errBottom=y(Math.max(0,mean-sd));
      parts.push(`<rect x="${x}" y="${yy}" width="${barW}" height="${h}" rx="3" fill="${color}"/>`);
      parts.push(`<line x1="${x+barW/2}" y1="${errTop}" x2="${x+barW/2}" y2="${errBottom}" stroke="#222" stroke-width="2"/>`);
      parts.push(`<line x1="${x+barW/2-8}" y1="${errTop}" x2="${x+barW/2+8}" y2="${errTop}" stroke="#222" stroke-width="2"/>`);
    });
    parts.push(`<text transform="translate(${center},${top+chartH+22}) rotate(28)" text-anchor="start" font-family="Microsoft YaHei, Arial, sans-serif" font-size="13">${xmlEscape(item.group)} (n=${item.n})</text>`);
  });
  parts.push(`<line x1="${left}" y1="${top+chartH}" x2="${width-right}" y2="${top+chartH}" stroke="#222" stroke-width="2"/>`);
  parts.push(`<text transform="translate(25,${top+chartH/2}) rotate(-90)" text-anchor="middle" font-family="Microsoft YaHei, Arial, sans-serif" font-size="16">确认 CIC 数 / 视野</text>`);
  parts.push(`<rect x="${width-215}" y="48" width="16" height="16" fill="#24bfe8"/><text x="${width-192}" y="61" font-family="Microsoft YaHei, Arial, sans-serif" font-size="13">异质 CIC</text>`);
  parts.push(`<rect x="${width-105}" y="48" width="16" height="16" fill="#9b6ee8"/><text x="${width-82}" y="61" font-family="Microsoft YaHei, Arial, sans-serif" font-size="13">同质 CIC</text>`);
  parts.push(`</svg>`);return parts.join("");
}
async function svgToPngBlob(svg,width=1100,height=650) {
  const blob=new Blob([svg],{type:"image/svg+xml;charset=utf-8"}),url=URL.createObjectURL(blob);
  try{
    const image=new Image();
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});
    const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
    canvas.getContext("2d").drawImage(image,0,0,width,height);
    return await canvasBlob(canvas);
  }finally{URL.revokeObjectURL(url);}
}
function downloadSummaryFiles() {
  downloadBlob(new Blob([csvText()],{type:"text/csv;charset=utf-8"}),`${state.project.name}-cell-count-results.csv`);
  setTimeout(()=>downloadBlob(new Blob([JSON.stringify(serializableProject(),null,2)],{type:"application/json"}),`${state.project.name}-cell-count-project.json`),250);
  setTimeout(()=>downloadBlob(new Blob([cellRawCsv()],{type:"text/csv;charset=utf-8"}),`${state.project.name}-cell-object-raw-data.csv`),500);
  setTimeout(()=>downloadBlob(new Blob([cicRawCsv()],{type:"text/csv;charset=utf-8"}),`${state.project.name}-CIC-raw-events.csv`),750);
  setTimeout(()=>downloadBlob(new Blob([cicSummaryCsv()],{type:"text/csv;charset=utf-8"}),`${state.project.name}-CIC-group-summary.csv`),1000);
  setTimeout(()=>downloadBlob(new Blob([cicPlotSvg()],{type:"image/svg+xml;charset=utf-8"}),`${state.project.name}-CIC-plot.svg`),1250);
}
async function exportResults() {
  if (!state.project || state.busy) return;
  const processedGroups=state.project.groups.filter(group=>
    groupViews(group).some(view=>TARGETS.some(target=>targetStatus(view.id,target)!=="pending"))
  );
  if (!processedGroups.length) return toast("还没有处理完成的文件夹，请先运行至少一个通道",true);
  if (!window.showDirectoryPicker) {
    downloadSummaryFiles();
    return toast("已导出 CSV 和项目 JSON；批量标注图文件夹需要使用最新版 Chrome 或 Edge",true);
  }
  let parent;
  try {
    parent=await window.showDirectoryPicker({mode:"readwrite"});
  } catch(error) {
    if (error.name!=="AbortError") toast(`无法选择导出目录：${error.message}`,true);
    return;
  }
  state.busy=true;state.cancelled=false;
  $("jobPanel").classList.remove("hidden");
  $("cancelBtn").textContent="停止导出";
  const errors=[];
  try {
    const root=await parent.getDirectoryHandle(`${safeFileName(state.project.name)}_cell-count-results`,{create:true});
    const processedViews=state.project.views.filter(view=>processedGroups.includes(view.group));
    await writeLocalFile(root,"全部文件夹汇总.csv",new Blob([csvText(processedViews)],{type:"text/csv;charset=utf-8"}));
    await writeLocalFile(root,"细胞逐对象原始数据.csv",new Blob([cellRawCsv(processedViews)],{type:"text/csv;charset=utf-8"}));
    await writeLocalFile(root,"CIC逐事件原始数据.csv",new Blob([cicRawCsv(processedViews)],{type:"text/csv;charset=utf-8"}));
    await writeLocalFile(root,"CIC组汇总.csv",new Blob([cicSummaryCsv(processedViews)],{type:"text/csv;charset=utf-8"}));
    const cicSvg=cicPlotSvg(processedViews);
    await writeLocalFile(root,"CIC组间图.svg",new Blob([cicSvg],{type:"image/svg+xml;charset=utf-8"}));
    await writeLocalFile(root,"CIC组间图.png",await svgToPngBlob(cicSvg));
    await writeLocalFile(root,"项目.json",new Blob([JSON.stringify(serializableProject(),null,2)],{type:"application/json"}));
    const mirrored=await root.getDirectoryHandle("按原目录排列",{create:true});
    const groupOutputs=new Map();
    for (const group of processedGroups) {
      const groupDir=await nestedDirectory(mirrored,group);
      const groupErrors=[];
      await writeLocalFile(groupDir,"计数结果.csv",new Blob([csvText(groupViews(group))],{type:"text/csv;charset=utf-8"}));
      await writeLocalFile(groupDir,"细胞逐对象原始数据.csv",new Blob([cellRawCsv(groupViews(group))],{type:"text/csv;charset=utf-8"}));
      await writeLocalFile(groupDir,"CIC逐事件原始数据.csv",new Blob([cicRawCsv(groupViews(group))],{type:"text/csv;charset=utf-8"}));
      await writeLocalFile(groupDir,"CIC组汇总.csv",new Blob([cicSummaryCsv(groupViews(group))],{type:"text/csv;charset=utf-8"}));
      groupOutputs.set(group,{
        directory:groupDir,
        annotations:await groupDir.getDirectoryHandle("标注图",{create:true}),
        cicAnnotations:await groupDir.getDirectoryHandle("CIC标注图",{create:true}),
        errors:groupErrors,
      });
    }
    const tasks=[];
    for (const view of processedViews) {
      for (const target of TARGETS) {
        if (targetStatus(view.id,target)==="done" && view.files[target]) tasks.push({view,target});
        else {
          const message=`${view.group} / ${view.name} / ${targetLabel(target)}：${targetStatus(view.id,target)}`;
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
        const fileName=`${safeFileName(view.name)}__${safeFileName(targetLabel(target))}__${channelCodes[target]}__标注.png`;
        await writeLocalFile(output.annotations,fileName,await annotatedBlob(view,target));
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
    const cicTasks=processedViews.filter(view=>cicStatus(view.id)==="done");
    for(let index=0;index<cicTasks.length;index++){
      if(state.cancelled)break;
      const view=cicTasks[index],output=groupOutputs.get(view.group);
      $("jobTitle").textContent=`正在导出 CIC 标注图 ${index+1}/${cicTasks.length}`;
      const percent=Math.round(index/Math.max(1,cicTasks.length)*100);
      $("jobPercent").textContent=`${percent}%`;$("jobProgress").style.width=`${percent}%`;
      $("jobCurrent").textContent=`${view.group} / ${view.name} · CIC`;
      try{
        const fileName=`${safeFileName(view.name)}__CIC__标注.png`;
        await writeLocalFile(output.cicAnnotations,fileName,await cicAnnotatedBlob(view));
        const c=cicCounts(view.id);
        manifest.push([view.group,view.name,"CIC",c.heterotypic+c.homotypic,`按原目录排列/${safeRelativePath(view.group)}/CIC标注图/${fileName}`,"done",`待复核 ${c.pending}`]);
      }catch(error){
        const message=`${view.group} / ${view.name} / CIC：${error.message}`;
        errors.push(message);output.errors.push(message);
        manifest.push([view.group,view.name,"CIC","","","error",error.message]);
      }
    }
    const quote=value=>`"${String(value).replaceAll('"','""')}"`;
    const manifestText="\ufeff"+manifest.map(row=>row.map(quote).join(",")).join("\r\n");
    await writeLocalFile(root,"标注图清单.csv",new Blob([manifestText],{type:"text/csv;charset=utf-8"}));
    await writeLocalFile(root,"错误报告.txt",new Blob([errors.length?errors.join("\r\n"):"无错误"],{type:"text/plain;charset=utf-8"}));
    for (const output of groupOutputs.values()) {
      await writeLocalFile(output.directory,"错误报告.txt",new Blob([output.errors.length?output.errors.join("\r\n"):"无错误"],{type:"text/plain;charset=utf-8"}));
    }
    toast(state.cancelled?"导出已停止；已完成文件保留在所选目录":"细胞计数、CIC 原始数据、汇总图和全部标注图已导出");
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
  state.layer="cells";
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
function setCicReviewMode(mode) {
  state.layer="cic";
  state.cicMode=mode;
  state.mode=mode==="pan"?"pan":`cic-${mode}`;
  for(const name of ["select","add","pan"])$(`cic${name[0].toUpperCase()+name.slice(1)}ModeBtn`).classList.toggle("active",name===mode);
  const hints={
    select:"选择候选后确认类型；黄色候选不计入最终结果",
    add:"点击图片添加一个待确认 CIC 标记",
    pan:"按住左键拖动图片；滚轮可缩放",
  };
  $("cicSelectionHint").textContent=hints[mode];
  updatePanCursor();
}
function showReviewLayer(layer) {
  state.layer=layer;
  $("cellReviewBar").classList.toggle("hidden",layer==="cic");
  $("cicReviewBar").classList.toggle("hidden",layer!=="cic");
  $("inspectionTabs").classList.toggle("hidden",layer==="cic");
  if(layer==="cic"){
    state.channel="overlay";state.cicEvents=cicResult()?.events||[];state.selectedCicId=null;
    setCicReviewMode(state.cicMode||"select");
  }else{
    state.detections=targetResult(state.currentViewId)?.detections||[];
    if(state.mode.startsWith("cic-")||state.mode==="pan")setReviewMode("select");
  }
}
async function activateCicReview() {
  if(!state.project)return;
  showReviewLayer("cic");
  document.querySelectorAll("#channelTabs button").forEach(button=>button.classList.toggle("active",button.dataset.channel==="cic"));
  await showImage();updateCounts();
  $("controlPanel").scrollTo({top:Math.max(0,$("cicPanel").offsetTop-85),behavior:"smooth"});
}
async function reviewNextPendingCic() {
  if(!state.project)return;
  let start=Math.max(0,state.project.views.findIndex(view=>view.id===state.currentViewId));
  for(let offset=0;offset<state.project.views.length;offset++){
    const view=state.project.views[(start+offset)%state.project.views.length];
    const event=(cicResult(view.id)?.events||[]).find(item=>!item.deleted&&item.classification==="pending");
    if(!event)continue;
    if(view.id!==state.currentViewId)await selectView(view.id);
    if(state.layer!=="cic")await activateCicReview();
    state.selectedCicId=event.id;drawCicOverlay();
    const stage=$("imageStage"),viewer=$("viewer");
    state.zoom=Math.max(state.zoom,2);
    state.panX=viewer.clientWidth/2-state.fitLeft-event.x*(stage.clientWidth/$("overlayCanvas").width)*state.zoom;
    state.panY=viewer.clientHeight/2-state.fitTop-event.y*(stage.clientHeight/$("overlayCanvas").height)*state.zoom;
    applyViewportTransform();
    $("cicSelectionHint").textContent=`待复核 ${event.id} · ${event.evidence_grade?`${event.evidence_grade} 级 · `:""}自动提示 ${event.type_hint==="homotypic"?"同质":"异质"} · 包围 ${Number(event.enclosure_coverage||0).toFixed(2)} · 对侧 ${event.opposite_pairs??"—"}/8`;
    return;
  }
  toast("当前项目没有待复核 CIC 候选");
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
    $(`countLabel${key}`).textContent=`${label} 总数`;
    $(`channelName${key}`).value=label;
  }
  $("targetParameterTitle").textContent=`${targetLabel(state.target)} 独立计数参数`;
  $("currentTargetName").textContent=targetLabel(state.target);
  if (state.currentGroup) $("profileGroup").textContent=`${state.currentGroup} · ${targetLabel(state.target)}`;
  $("calibrationWarning").textContent=`推荐顺序：选择 ${targetLabel("dapi")} → 随机预跑 → 保存阈值 → 批量；然后对 ${targetLabel("nk")}、${targetLabel("tumor")} 分别重复。三类参数互不覆盖。`;
  updateActionLabels();
  if (state.currentGroup) updateParameterVisibility();
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
  showReviewLayer("cells");
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
  if(!state.showLabels)return;
  active.forEach((item,index)=>{
    context.font=`700 ${Math.max(12,Math.min(22,(item.radius||12)*.75))}px system-ui`;
    context.textAlign="center";context.textBaseline="middle";context.lineWidth=3;
    context.strokeStyle="rgba(0,0,0,.88)";context.fillStyle="#fff";
    const label=`${labelPrefix}${index+1}`;
    context.strokeText(label,item.x,item.y);context.fillText(label,item.x,item.y);
  });
}
function drawCompareCic(canvas,events=[]) {
  const context=canvas.getContext("2d");
  let index=0;
  for(const event of events){
    if(event.deleted||event.classification==="rejected")continue;
    index++;
    const color=cicDisplayColor(event),inner=Math.max(10,event.inner_radius||event.radius||16);
    const outer=Math.max(inner+10,event.outer_radius||inner+36);
    context.save();context.strokeStyle=color;context.lineWidth=3;
    if(event.classification==="pending")context.setLineDash([10,7]);
    context.beginPath();context.arc(event.x,event.y,inner,0,Math.PI*2);context.stroke();
    context.globalAlpha=.8;context.beginPath();context.arc(event.x,event.y,outer,0,Math.PI*2);context.stroke();
    context.restore();
    if(state.showLabels){
      context.font="700 15px system-ui";context.textAlign="center";context.lineWidth=3;
      context.strokeStyle="#05070a";context.fillStyle="#fff";
      const prefix=event.classification==="heterotypic"?"异":event.classification==="homotypic"?"同":`${event.evidence_grade||""}?`;
      context.strokeText(`${prefix}${index}`,event.x,event.y-outer-10);context.fillText(`${prefix}${index}`,event.x,event.y-outer-10);
    }
  }
}
function updateCompareStats(side,view) {
  const counts=viewCounts(view.id),cic=cicCounts(view.id);
  compareNode(side,"Stats").textContent=
    `${view.group} / ${view.name}　${targetLabel("dapi")} ${counts.dapi.total}　${targetLabel("nk")} ${counts.nk.total}　${targetLabel("tumor")} ${counts.tumor.total}　异质 CIC ${cic.heterotypic}　同质 CIC ${cic.homotypic}　待复核 ${cic.pending}`;
}
async function renderCompareSide(side,resetViewport=true) {
  const pane=compareState[side],view=viewById(pane.viewId);
  if(!view)return;
  const requestId=Symbol(side);pane.requestId=requestId;
  const channel=pane.channel==="cic"?"overlay":pane.channel;
  const file=view.files[channel]||view.files.dapi;
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
    if(pane.channel==="cic")drawCompareCic(overlay,cicResult(view.id)?.events||[]);
    else if(TARGETS.includes(pane.channel)){
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
  compareState.left.channel=state.layer==="cic"?"cic":state.channel;
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
$("exportBtn").onclick=exportResults;$("annotatedBtn").onclick=exportAnnotated;
$("overlayCanvas").onclick=handleCanvasClick;
$("selectModeBtn").onclick=()=>setReviewMode("select");
$("addModeBtn").onclick=()=>setReviewMode("add");
$("deleteModeBtn").onclick=()=>setReviewMode("delete");
$("panModeBtn").onclick=()=>setReviewMode("pan");
$("deleteDetectionBtn").onclick=deleteSelected;
$("cicSelectModeBtn").onclick=()=>setCicReviewMode("select");
$("cicAddModeBtn").onclick=()=>setCicReviewMode("add");
$("cicPanModeBtn").onclick=()=>setCicReviewMode("pan");
$("confirmHeterotypicBtn").onclick=()=>classifySelectedCic("heterotypic");
$("confirmHomotypicBtn").onclick=()=>classifySelectedCic("homotypic");
$("rejectCicBtn").onclick=rejectSelectedCic;
$("deleteCicBtn").onclick=deleteSelectedCic;
$("analyzeCicCurrentBtn").onclick=()=>analyzeCicScope("current");
$("analyzeCicGroupBtn").onclick=()=>analyzeCicScope("group");
$("analyzeCicAllBtn").onclick=()=>analyzeCicScope("all");
$("reviewPendingCicBtn").onclick=reviewNextPendingCic;
$("cicPptPresetBtn").onclick=applyCicPptPreset;
document.querySelectorAll("#channelTabs button").forEach(button=>button.onclick=async()=>{
  if(button.dataset.channel==="cic"){await activateCicReview();return;}
  if (TARGETS.includes(button.dataset.channel)) {
    await setTarget(button.dataset.channel);
    return;
  }
  showReviewLayer("cells");
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
  if((event.key==="Delete"||event.key==="Backspace")&&!isTypingTarget(event.target)&&state.layer==="cic"&&state.selectedCicId){
    event.preventDefault();deleteSelectedCic();return;
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
