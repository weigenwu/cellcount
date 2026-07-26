const state = {
  project: null,
  currentViewId: null,
  currentGroup: null,
  channel: "overlay",
  detections: [],
  selectedId: null,
  mode: "select",
  visibleClasses: new Set(["tumor", "nk", "double_positive", "unclassified"]),
  zoom: 1,
  jobTimer: null,
};

const $ = (id) => document.getElementById(id);
const classColors = {
  tumor: "#ff4a5b",
  nk: "#41e090",
  double_positive: "#ffbe48",
  unclassified: "#47bdff",
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? {"Content-Type": "application/json"} : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || "请求失败");
  return data;
}

function toast(message, error = false) {
  const node = $("toast");
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.className = "toast", 3500);
}

async function chooseFolder() {
  try {
    const chosen = await api("/api/select-folder", {method: "POST", body: {}});
    if (!chosen.path) return;
    const suffixes = {
      dapi: $("suffixDapi").value.trim(),
      nk: $("suffixNk").value.trim(),
      tumor: $("suffixTumor").value.trim(),
    };
    toast("正在扫描图片与验证通道…");
    const opened = await api("/api/open", {method: "POST", body: {path: chosen.path, suffixes}});
    loadProject(opened.project);
  } catch (error) { toast(error.message, true); }
}

async function chooseProject() {
  try {
    const chosen = await api("/api/select-project", {method: "POST", body: {}});
    if (!chosen.path) return;
    const loaded = await api("/api/load", {method: "POST", body: {path: chosen.path}});
    loadProject(loaded.project);
  } catch (error) { toast(error.message, true); }
}

function loadProject(project) {
  state.project = project;
  $("appShell").classList.remove("empty");
  ["welcome"].forEach(id => $(id).classList.add("hidden"));
  ["sidebar", "workspace", "controlPanel"].forEach(id => $(id).classList.remove("hidden"));
  $("projectName").textContent = project.name;
  $("projectMeta").textContent = `${project.groups.length} 个实验组 · ${project.views.length} 个视野`;
  $("pixelSizeBadge").textContent = `${project.pixel_size_um} µm/px`;
  renderGroups();
  renderResults();
  const first = project.views.find(view => !view.error) || project.views[0];
  if (first) selectView(first.id);
  toast(`已识别 ${project.views.length} 个视野`);
}

function groupViews(group) {
  return state.project.views.filter(view => view.group === group);
}

function renderGroups() {
  const container = $("groupList");
  container.innerHTML = "";
  state.project.groups.forEach(group => {
    const views = groupViews(group);
    const wrapper = document.createElement("div");
    wrapper.className = "group";
    wrapper.innerHTML = `<button class="group-header"><strong>${escapeHtml(group)}</strong><small>${views.length}</small></button><div class="view-list"></div>`;
    const list = wrapper.querySelector(".view-list");
    views.forEach(view => {
      const button = document.createElement("button");
      button.className = `view-item${view.id === state.currentViewId ? " active" : ""}`;
      button.dataset.id = view.id;
      button.innerHTML = `<span class="status-dot ${view.status}"></span><span>${escapeHtml(view.name)}</span>`;
      button.onclick = () => selectView(view.id);
      list.appendChild(button);
    });
    wrapper.querySelector(".group-header").onclick = () => list.classList.toggle("hidden");
    container.appendChild(wrapper);
  });
}

async function selectView(viewId) {
  state.currentViewId = viewId;
  state.selectedId = null;
  const view = state.project.views.find(item => item.id === viewId);
  state.currentGroup = view.group;
  $("currentGroupLabel").textContent = view.group;
  $("currentViewLabel").textContent = view.name;
  $("profileGroup").textContent = view.group;
  populateParameters(state.project.parameters_by_group[view.group]);
  renderGroups();
  await Promise.all([loadImage(), loadDetections()]);
}

async function loadImage() {
  if (!state.currentViewId) return;
  const image = $("microscopeImage");
  const view = state.project.views.find(item => item.id === state.currentViewId);
  $("viewerEmpty").classList.add("hidden");
  const src = `/api/image?view_id=${encodeURIComponent(state.currentViewId)}&channel=${state.channel}&t=${Date.now()}`;
  image.onload = () => {
    const viewer = $("viewer");
    const ratio = view.width / view.height;
    const maxW = viewer.clientWidth;
    const maxH = viewer.clientHeight;
    let width = maxW;
    let height = width / ratio;
    if (height > maxH) { height = maxH; width = height * ratio; }
    const stage = $("imageStage");
    stage.style.display = "block";
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.left = `${(maxW - width) / 2}px`;
    stage.style.top = `${(maxH - height) / 2}px`;
    const canvas = $("overlayCanvas");
    canvas.width = view.width;
    canvas.height = view.height;
    setZoom(1);
    drawOverlay();
  };
  image.onerror = () => toast("图像预览加载失败", true);
  image.src = src;
}

async function loadDetections() {
  try {
    const data = await api(`/api/detections?view_id=${encodeURIComponent(state.currentViewId)}`);
    state.detections = data.detections;
    updateCounts(data.counts);
    drawOverlay();
  } catch (error) { toast(error.message, true); }
}

function drawOverlay() {
  const canvas = $("overlayCanvas");
  if (!canvas.width) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "20px system-ui";
  ctx.lineWidth = Math.max(2, 3 / state.zoom);
  state.detections.forEach((item, index) => {
    if (item.deleted || !state.visibleClasses.has(item.classification)) return;
    const color = classColors[item.classification];
    const selected = item.id === state.selectedId;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = selected ? 6 : 3;
    ctx.beginPath();
    ctx.arc(item.x, item.y, Math.max(8, item.radius || 12), 0, Math.PI * 2);
    ctx.stroke();
    if (selected) {
      ctx.globalAlpha = .18; ctx.fill(); ctx.globalAlpha = 1;
    }
    ctx.fillText(String(index + 1), item.x + (item.radius || 12) + 3, item.y - 5);
  });
}

function updateCounts(counts = {}) {
  $("countDapi").textContent = counts.dapi_total ?? "—";
  $("countTumor").textContent = counts.tumor ?? "—";
  $("countNk").textContent = counts.nk ?? "—";
  $("countReview").textContent = counts.double_positive ?? "—";
}

const fieldMap = {
  thresholdMode: "threshold_mode",
  thresholdLow: "threshold_low",
  thresholdHigh: "threshold_high",
  minArea: "min_area_px",
  maxArea: "max_area_px",
  minCircularity: "min_circularity",
  maxCircularity: "max_circularity",
  gaussianSigma: "gaussian_sigma",
  watershedDistance: "watershed_min_distance",
  tumorThreshold: "tumor_pixel_threshold",
  tumorFraction: "tumor_positive_fraction",
  nkThreshold: "nk_pixel_threshold",
  nkFraction: "nk_positive_fraction",
  perinuclearRadius: "perinuclear_radius_um",
};

function populateParameters(params) {
  Object.entries(fieldMap).forEach(([id, key]) => $(id).value = params[key]);
  updateAreaNote();
}

function collectParameters() {
  const old = state.project.parameters_by_group[state.currentGroup];
  const params = {...old};
  Object.entries(fieldMap).forEach(([id, key]) => {
    params[key] = id === "thresholdMode" ? $(id).value : Number($(id).value);
  });
  return params;
}

function updateAreaNote() {
  if (!state.project) return;
  const area = Number($("minArea").value || 0);
  const converted = area * state.project.pixel_size_um ** 2;
  $("areaConversion").textContent = `${area} px² ≈ ${converted.toFixed(1)} µm²`;
}

async function saveParameters(applyToAll = false) {
  if (!state.currentGroup) return;
  try {
    const parameters = collectParameters();
    await api("/api/parameters", {method: "POST", body: {group: state.currentGroup, parameters, apply_to_all: applyToAll}});
    if (applyToAll) state.project.groups.forEach(group => state.project.parameters_by_group[group] = {...parameters});
    else state.project.parameters_by_group[state.currentGroup] = parameters;
    toast(applyToAll ? "参数已应用到全部实验组" : `已保存“${state.currentGroup}”的参数`);
  } catch (error) { toast(error.message, true); }
}

async function analyze(scope) {
  if (!state.project) return;
  await saveParameters(false);
  let views = [];
  if (scope === "current") views = [state.project.views.find(view => view.id === state.currentViewId)];
  else if (scope === "group") views = groupViews(state.currentGroup);
  else if (scope === "pending") views = state.project.views.filter(view => view.status !== "done");
  else views = state.project.views;
  views = views.filter(view => !view.error);
  if (!views.length) {
    toast("没有未完成且可分析的视野");
    return;
  }
  const hasCorrections = views.some(view => (view.counts?.corrected || 0) > 0);
  let clearManual = false;
  if (hasCorrections) {
    clearManual = confirm("所选范围包含人工修正。重新分析会清除这些修正，是否继续？");
    if (!clearManual) return;
  }
  try {
    await api("/api/analyze", {method: "POST", body: {view_ids: views.map(view => view.id), clear_manual: clearManual}});
    $("jobPanel").classList.remove("hidden");
    pollJob();
  } catch (error) { toast(error.message, true); }
}

async function pollJob() {
  clearTimeout(state.jobTimer);
  try {
    const {job} = await api("/api/job");
    const percent = job.total ? Math.round(job.completed / job.total * 100) : 0;
    $("jobPercent").textContent = `${percent}%`;
    $("jobProgress").style.width = `${percent}%`;
    $("jobCurrent").textContent = `${job.current || "准备中"} · 剩余约 ${formatSeconds(job.eta_seconds)}`;
    if (job.running) {
      state.jobTimer = setTimeout(pollJob, 850);
    } else {
      $("jobPanel").classList.add("hidden");
      await refreshProject();
      await loadDetections();
      toast(job.current === "已取消" ? "批处理已停止，完成结果已保存" : `分析完成${job.errors.length ? `，${job.errors.length} 个错误` : ""}`, !!job.errors.length);
    }
  } catch (error) { toast(error.message, true); }
}

async function refreshProject() {
  const data = await api("/api/project");
  state.project = data.project;
  renderGroups();
  renderResults();
}

function renderResults() {
  if (!state.project) return;
  $("resultsBody").innerHTML = state.project.views.map(view => {
    const c = view.counts || {};
    const statusLabels = {pending: "待分析", running: "分析中", done: "完成", error: "错误"};
    return `<tr><td>${escapeHtml(view.group)} / ${escapeHtml(view.name)}</td><td>${c.dapi_total ?? 0}</td><td>${c.tumor ?? 0}</td><td>${c.nk ?? 0}</td><td>${c.unclassified ?? 0}</td><td>${c.double_positive ?? 0}</td><td>${c.corrected ?? 0}</td><td class="status-${view.status}" title="${escapeHtml(view.error || "")}">${statusLabels[view.status] || view.status}</td></tr>`;
  }).join("");
}

function canvasPoint(event) {
  const canvas = $("overlayCanvas");
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height,
  };
}

async function handleCanvasClick(event) {
  if (!state.currentViewId) return;
  const point = canvasPoint(event);
  if (state.mode === "add") {
    await correct({action: "add", x: point.x, y: point.y, classification: "unclassified"});
    return;
  }
  let best = null, distance = Infinity;
  state.detections.forEach(item => {
    if (item.deleted) return;
    const value = Math.hypot(item.x - point.x, item.y - point.y);
    if (value < Math.max(20, item.radius * 1.5) && value < distance) { best = item; distance = value; }
  });
  state.selectedId = best?.id || null;
  $("selectionHint").textContent = best ? `已选择 ${best.id}` : "未选中标记";
  drawOverlay();
}

async function correct(payload) {
  try {
    const result = await api("/api/correction", {method: "POST", body: {view_id: state.currentViewId, ...payload}});
    state.detections = result.detections;
    state.selectedId = null;
    updateCounts(result.counts);
    drawOverlay();
    await refreshProject();
  } catch (error) { toast(error.message, true); }
}

function setZoom(value) {
  state.zoom = Math.max(.5, Math.min(4, value));
  $("imageStage").style.transform = `scale(${state.zoom})`;
  $("zoomLabel").textContent = `${Math.round(state.zoom * 100)}%`;
}

async function exportData() {
  try {
    toast("正在生成结果文件…");
    const result = await api("/api/export", {method: "POST", body: {include_annotations: $("annotationCheck").checked}});
    toast(`导出完成：${result.outputs.output_dir}`);
  } catch (error) { toast(error.message, true); }
}

function formatSeconds(value) {
  if (value == null) return "计算中";
  if (value < 60) return `${Math.ceil(value)} 秒`;
  return `${Math.ceil(value / 60)} 分钟`;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
}

$("openFolderBtn").onclick = chooseFolder;
$("welcomeOpenBtn").onclick = chooseFolder;
$("loadProjectBtn").onclick = chooseProject;
$("mappingToggleBtn").onclick = () => $("mappingPanel").classList.toggle("hidden");
$("saveProfileBtn").onclick = () => saveParameters(false);
$("applyAllBtn").onclick = () => saveParameters(true);
$("analyzeCurrentBtn").onclick = () => analyze("current");
$("analyzeGroupBtn").onclick = () => analyze("group");
$("analyzeAllBtn").onclick = () => analyze("all");
$("resumeBtn").onclick = () => analyze("pending");
$("cancelBtn").onclick = () => api("/api/cancel", {method:"POST", body:{}}).then(() => toast("正在停止…"));
$("exportBtn").onclick = exportData;
$("openOutputBtn").onclick = () => api("/api/open-output", {method:"POST", body:{}}).catch(error => toast(error.message, true));
$("zoomInBtn").onclick = () => setZoom(state.zoom + .25);
$("zoomOutBtn").onclick = () => setZoom(state.zoom - .25);
$("fitBtn").onclick = () => setZoom(1);
$("overlayCanvas").onclick = handleCanvasClick;
$("selectModeBtn").onclick = () => { state.mode = "select"; $("selectModeBtn").classList.add("active"); $("addModeBtn").classList.remove("active"); };
$("addModeBtn").onclick = () => { state.mode = "add"; $("addModeBtn").classList.add("active"); $("selectModeBtn").classList.remove("active"); };
$("deleteDetectionBtn").onclick = () => state.selectedId && correct({action:"delete", detection_id: state.selectedId});
document.querySelectorAll("[data-reclass]").forEach(button => button.onclick = () => state.selectedId && correct({action:"reclassify", detection_id: state.selectedId, classification: button.dataset.reclass}));
document.querySelectorAll("#channelTabs button").forEach(button => button.onclick = () => {
  document.querySelectorAll("#channelTabs button").forEach(item => item.classList.remove("active"));
  button.classList.add("active"); state.channel = button.dataset.channel; loadImage();
});
document.querySelectorAll(".legend button").forEach(button => button.onclick = () => {
  button.classList.toggle("active");
  button.classList.contains("active") ? state.visibleClasses.add(button.dataset.class) : state.visibleClasses.delete(button.dataset.class);
  drawOverlay();
});
$("minArea").addEventListener("input", updateAreaNote);
$("viewer").addEventListener("wheel", event => { event.preventDefault(); setZoom(state.zoom + (event.deltaY < 0 ? .15 : -.15)); }, {passive:false});
window.addEventListener("resize", () => state.currentViewId && loadImage());

api("/api/project")
  .then(async data => {
    loadProject(data.project);
    const status = await api("/api/job");
    if (status.job.running) {
      $("jobPanel").classList.remove("hidden");
      pollJob();
    }
  })
  .catch(() => {});
